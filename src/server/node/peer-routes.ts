import express, { type NextFunction, type Request, type Response } from 'express';
import { mkdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { currentHost } from '../platform/host.ts';
import { isolatedUserPath } from '../platform/under-test.ts';
import {
  maxPeerConcurrentTransfers,
  maxPeerFiles,
  maxPeerWindowFiles,
  maxPeerWindowBytes,
  peerTransferLimitMs,
  uploadByteQuota,
  peerUploadWindowMs,
} from '../../shared/peer-files.ts';
import { nodeReceivedFolder, fileSizeCheck, openRecordedFile, receiveFile, transferDeadline } from './peer-files.ts';
import { z } from 'zod';
import { FailureLimiter, type PeerRecord, type PeerRegistry } from './peer-auth.ts';
import {
  pairRequestSchema,
  peerTaskRequestSchema,
  resultQuerySchema,
  settledStatuses,
  slackHostRequestSchema,
  githubHostRequestSchema,
  githubHostReplySchema,
  githubStatusSchema,
  githubOutboxSchema,
  githubResolveSchema,
  serverStatusQuerySchema,
  outboxItemSchema,
  taskIdSchema,
  type GitHubHostRequest,
  type GitHubStatus,
  type GitHubResolve,
  type PeerInfo,
  type PeerRuntimes,
  type PeerServerStatus,
  type SlackHostRequest,
} from './peer-protocol.ts';
import { PeerCancelUnconfirmed, PeerRequestNotSent, type PeerTaskRunner } from './peer-tasks.ts';
import type { OutboxItem } from '../maintainer/outbox.ts';
import { PeerRepoError, repoImportSchema, type RepoImporter } from './peer-repos.ts';

export type GitHubHostApi = {
  set(request: GitHubHostRequest): Promise<{ githubHost: boolean }>;
  status(): Promise<GitHubStatus>;
  outbox(): OutboxItem[];
  resolve(id: string, resolution: GitHubResolve): Promise<boolean>;
  resumeJudge?(): void | Promise<void>;
};

export type PeerApiOptions = {
  registry: PeerRegistry;
  runner: PeerTaskRunner;
  info: () => Omit<PeerInfo, 'peerName'>;
  runtimes: () => PeerRuntimes | Promise<PeerRuntimes>;
  /** Load, memory, root disk and the asked systemd services, for the paired PugPorts' remote server card. */
  serverStatus?: (services: string[]) => Promise<PeerServerStatus>;
  /** Makes this node the Slack host, or stops its gateway; absent when the node cannot host Slack. */
  slack?: (request: SlackHostRequest) => Promise<{ slackHost: boolean }>;
  github?: GitHubHostApi;
  importRepo?: RepoImporter;
  /** Owner opt-out; otherwise device tasks may act with the user's account permissions. */
  allowWrite?: boolean;
  /** The folder a task may work in, resolved, or undefined when it is missing or off limits. */
  projectFolder?: (path: string) => string | undefined;
  limiter?: FailureLimiter;
  log?: (line: string) => void;
  now?: () => number;
  /** How often an event stream looks at its task (tests make it quick). */
  eventPollMs?: number;
  requestTimeoutMs?: number;
  transferIdleMs?: number;
  transferMaxMs?: number;
  maxConcurrentTransfersPerPeer?: number;
  maxUploadFilesPerPeer?: number;
  maxUploadBytesPerPeer?: number;
  uploadWindowMs?: number;
};

/** A request's paired PugPort, set once its bearer token has been checked. */
type PeerRequest = Request & { peer?: PeerRecord };

class PeerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const notFound = () => new PeerError(404, '没有这条任务。');
const remote = (req: Request) => req.socket.remoteAddress ?? 'unknown';
const dispatchLimit = { count: 60, windowMs: 10 * 60_000 };
const maxStreamsPerPeer = 8;

/**
 * The node's peer API on its own listener. Every route but pairing needs a paired PugPort's bearer token; failed
 * tokens and pairing guesses are counted per address. A browser can never call it: any request with an Origin is
 * refused, and no CORS headers are sent.
 */
export function peerApp(options: PeerApiOptions) {
  const { registry, runner } = options;
  const limiter = options.limiter ?? new FailureLimiter();
  const now = options.now ?? Date.now;
  const dispatched = new Map<string, number[]>();
  const streams = new Map<string, number>();
  const activeTransfers = new Map<string, number>();
  const uploaded = new Map<string, { batch: string; size: number; at: number; path?: string }[]>();
  const allowWrite = options.allowWrite ?? true;
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('trust proxy', false);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (req.headers.origin !== undefined) return void res.status(403).json({ error: '不接受来自网页的请求。' });
    if (limiter.blocked(remote(req))) return void res.status(429).json({ error: '失败次数太多，请过几分钟再试。' });
    const hasBody = req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0;
    const transfer =
      (req.method === 'PUT' && req.path === '/peer/v1/files') ||
      (req.method === 'GET' && !hasBody && /^\/peer\/v1\/tasks\/[^/]+\/files\/[^/]+$/.test(req.path));
    const events = req.method === 'GET' && !hasBody && /^\/peer\/v1\/tasks\/[^/]+\/events$/.test(req.path);
    if (!transfer && !events) {
      const timer = setTimeout(
        () => {
          req.destroy();
          res.destroy();
        },
        options.requestTimeoutMs ??
          (req.method === 'POST' && /^\/peer\/v1\/repos\/[^/]+\/import$/.test(req.path) ? 600_000 : 60_000),
      );
      timer.unref();
      res.once('close', () => clearTimeout(timer));
    }
    next();
  });
  const authenticate = (req: PeerRequest) => {
    const match = /^Bearer ([^\s]+)$/.exec(req.headers.authorization ?? '');
    const peer = registry.authenticate(match?.[1]);
    if (!peer) {
      limiter.fail(remote(req));
      if (
        req.path === '/peer/v1/files' ||
        /^\/peer\/v1\/tasks\/[^/]+\/files\/[^/]+$/.test(req.originalUrl.split('?')[0]!)
      )
        req.res?.once('finish', () => req.destroy());
      throw new PeerError(401, '这台设备不认识你的 PugPort：请在「设备」里移除它，再重新配对。');
    }
    req.peer = peer;
    return peer;
  };
  // Raw bodies must reach this route before both the JSON content-type gate and parser.
  app.put('/peer/v1/files', async (req: PeerRequest, res) => {
    const peer = authenticate(req);
    const input = z
      .object({
        name: z.string().min(1).max(500),
        size: z.coerce.number(),
        requestId: z
          .string()
          .regex(/^[A-Za-z0-9-]{1,120}$/)
          .optional(),
      })
      .strict()
      .parse(req.query);
    fileSizeCheck(input.size);
    const maxConcurrent = options.maxConcurrentTransfersPerPeer ?? maxPeerConcurrentTransfers;
    const inFlight = activeTransfers.get(peer.id) ?? 0;
    if (inFlight >= maxConcurrent) {
      res.once('finish', () => {
        if (!req.complete) req.destroy();
      });
      throw new PeerError(429, '同时传送的文件太多了。');
    }
    const windowMs = options.uploadWindowMs ?? peerUploadWindowMs;
    const since = now() - windowMs;
    const recent = (uploaded.get(peer.id) ?? []).filter((entry) => entry.at > since);
    uploaded.set(peer.id, recent);
    const batchKey = input.requestId ?? '__default__';
    const batchEntries = recent.filter((entry) => entry.batch === batchKey);
    const batchBytes = batchEntries.reduce((sum, entry) => sum + entry.size, 0);
    const peerBytes = recent.reduce((sum, entry) => sum + entry.size, 0);
    const byteQuota = uploadByteQuota(
      batchBytes,
      peerBytes,
      input.size,
      options.maxUploadBytesPerPeer ?? maxPeerWindowBytes,
    );
    if (batchEntries.length >= maxPeerFiles || byteQuota === 'batch') {
      res.once('finish', () => {
        if (!req.complete) req.destroy();
      });
      throw new PeerError(400, '每条任务最多传送 16 个文件，总大小不超过 4 GiB。');
    }
    if (byteQuota === 'window') {
      res.once('finish', () => {
        if (!req.complete) req.destroy();
      });
      throw new PeerError(429, '这台设备在 10 分钟内传送的数据太多，请稍后再试。');
    }
    const maxPeerCount = options.maxUploadFilesPerPeer ?? maxPeerWindowFiles;
    if (recent.length >= maxPeerCount) {
      res.once('finish', () => {
        if (!req.complete) req.destroy();
      });
      throw new PeerError(429, '传送的文件太多了，请稍后再发。');
    }
    const reservation: { batch: string; size: number; at: number; path?: string } = {
      batch: batchKey,
      size: input.size,
      at: now(),
    };
    recent.push(reservation);
    activeTransfers.set(peer.id, inFlight + 1);
    const abort = new AbortController();
    const timer = transferDeadline(
      (reason) => {
        const error = new Error(reason === 'idle' ? '文件传送已停滞。' : '文件传送超过总时限。');
        abort.abort(error);
        req.destroy(error);
      },
      options.transferIdleMs,
      options.transferMaxMs ?? peerTransferLimitMs(input.size),
    );
    const onPrematureClose = () => {
      if (!res.writableEnded) abort.abort(new Error('文件传送已中断。'));
    };
    req.once('aborted', onPrematureClose);
    req.once('close', () => {
      if (!req.complete) onPrematureClose();
    });
    res.once('close', onPrematureClose);
    const source = async function* () {
      for await (const chunk of req) {
        timer.touch();
        yield chunk as Buffer;
      }
    };
    try {
      const path = await receiveFile(
        source(),
        input.size,
        nodeReceivedFolder(peer.name),
        input.name,
        undefined,
        abort.signal,
      );
      reservation.at = now();
      reservation.path = path;
      res.json({ path });
    } catch (error) {
      const current = uploaded.get(peer.id);
      if (current) {
        const index = current.indexOf(reservation);
        if (index !== -1) current.splice(index, 1);
      }
      throw error;
    } finally {
      timer.close();
      activeTransfers.set(peer.id, Math.max(0, (activeTransfers.get(peer.id) ?? 1) - 1));
    }
  });
  app.use((req, res, next) => {
    const hasBody = req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0;
    if (hasBody && !req.is('application/json')) return void res.status(415).json({ error: '只接受 JSON。' });
    next();
  });
  app.use(express.json({ limit: '256kb' }));

  app.post('/peer/v1/pair', async (req, res) => {
    const input = pairRequestSchema.parse(req.body);
    const outcome = await registry.pair(input.code, input.name);
    if (outcome === 'no-code' || outcome === 'wrong') {
      limiter.fail(remote(req));
      throw new PeerError(
        403,
        outcome === 'no-code'
          ? '这台设备没有在等配对：请在它上面运行 pugport node pair，再输入新的配对码。'
          : '配对码不对。请核对后重试；输错几次后要在设备上重新生成。',
      );
    }
    if (outcome === 'full') throw new PeerError(409, '这台设备已配对的电脑太多了，请先在它上面移除不用的。');
    options.log?.(`[peer] paired with "${outcome.peer.name}"`);
    res.status(201).json({
      peerId: outcome.peer.id,
      token: outcome.token,
      node: { ...options.info(), peerName: outcome.peer.name },
    });
  });

  app.use('/peer/v1', (req: PeerRequest, _res, next) => {
    authenticate(req);
    next();
  });

  const own = (req: PeerRequest) => {
    const id = taskIdSchema.parse(req.params.id);
    if (runner.owner(id) !== req.peer!.id) throw notFound();
    return id;
  };

  app.get('/peer/v1/info', (req: PeerRequest, res) =>
    res.json({
      ...options.info(),
      peerName: req.peer!.name,
    }),
  );
  app.get('/peer/v1/runtimes', async (_req, res) => res.json(await options.runtimes()));
  if (options.serverStatus)
    app.get('/peer/v1/status', async (req, res) => {
      const { service } = serverStatusQuerySchema.parse(req.query);
      res.json(await options.serverStatus!(service === undefined ? [] : [service].flat()));
    });

  if (options.importRepo)
    app.post('/peer/v1/repos/:key/import', async (req: PeerRequest, res) => {
      const key = z
        .string()
        .regex(/^[a-f0-9]{16}$/)
        .parse(req.params.key);
      const input = repoImportSchema.parse(req.body);
      if (!allowWrite) throw new PeerError(400, '这台设备已关闭写入（PUGPORT_PEER_READ_ONLY=1）。');
      const peer = req.peer!;
      const recent = (dispatched.get(peer.id) ?? []).filter((at) => at > now() - dispatchLimit.windowMs);
      if (recent.length >= dispatchLimit.count) throw new PeerError(429, '交来的任务太多了，请稍后再发。');
      recent.push(now());
      dispatched.set(peer.id, recent);
      const reservation = uploaded.get(peer.id)?.find((entry) => entry.path === input.bundlePath);
      if (!reservation) throw new PeerError(404, '没有这个上传文件。');
      delete reservation.path;
      res.status(201).json(await options.importRepo!(peer, { ...input, key }));
    });

  app.post('/peer/v1/tasks', async (req: PeerRequest, res) => {
    const input = peerTaskRequestSchema.parse(req.body);
    const peer = req.peer!;
    const since = now() - dispatchLimit.windowMs;
    const recent = (dispatched.get(peer.id) ?? []).filter((at) => at > since);
    if (recent.length >= dispatchLimit.count) throw new PeerError(429, '交来的任务太多了，请稍后再发。');
    if (input.write && !allowWrite) throw new PeerError(400, '这台设备已关闭写入（PUGPORT_PEER_READ_ONLY=1）。');
    if (input.write && input.untrusted) throw new PeerError(400, '引用了别人话的任务只能只读。');
    let requestedPath = input.projectPath;
    if (input.write && requestedPath === undefined) {
      const host = currentHost();
      // Not ~/PugPort/…: on macOS that is the node's own ~/pugport checkout, whose AGENTS.md the CLIs would load.
      requestedPath = host.path.join(isolatedUserPath(host.home), 'PugPort-Workspace');
      await mkdir(requestedPath, { recursive: true });
    }
    let projectPath: string | undefined;
    if (requestedPath !== undefined) {
      projectPath = options.projectFolder?.(requestedPath);
      if (!projectPath) throw new PeerError(400, '这台设备上没有这个文件夹，或它不能用作项目文件夹。');
    }
    recent.push(now());
    dispatched.set(peer.id, recent);
    const created = await runner.dispatch(
      {
        task: input.task,
        ...(input.title ? { title: input.title } : {}),
        ...(projectPath ? { projectPath } : {}),
        write: input.write === true,
        untrusted: input.untrusted === true,
        ...(input.requestId ? { requestId: input.requestId } : {}),
        caller: `设备 · ${peer.name}`.slice(0, 60),
      },
      peer.id,
    );
    res.status(201).json(created);
  });

  const requestTask = async (req: PeerRequest, cancel = false) => {
    const requestId = taskIdSchema.parse(req.params.requestId);
    const id = await (cancel ? runner.cancelRequest(requestId, req.peer!.id) : runner.lookup(requestId, req.peer!.id));
    if (id && runner.owner(id) !== req.peer!.id) throw notFound();
    return id;
  };
  app.get('/peer/v1/requests/:requestId', async (req: PeerRequest, res) => {
    res.json({ taskId: (await requestTask(req)) ?? null });
  });
  app.post('/peer/v1/requests/:requestId/cancel', async (req: PeerRequest, res) => {
    const taskId = await requestTask(req, true);
    if (taskId) {
      const status = runner.status(taskId);
      if (!status) throw notFound();
      if (!settledStatuses.has(status.status) && !runner.cancel(taskId)) throw notFound();
    }
    res.json({ taskId: taskId ?? null });
  });

  app.get('/peer/v1/tasks/:id', (req: PeerRequest, res) => {
    const status = runner.status(own(req));
    if (!status) throw notFound();
    res.json(status);
  });

  app.get('/peer/v1/tasks/:id/files/:fileId', async (req: PeerRequest, res) => {
    const id = own(req);
    const fileId = taskIdSchema.parse(req.params.fileId);
    const file = runner.file?.(id, fileId);
    if (!file) throw notFound();
    const handle = await openRecordedFile(file);
    const timer = transferDeadline(
      (reason) => res.destroy(new Error(reason === 'idle' ? '文件传送已停滞。' : '文件传送超过总时限。')),
      options.transferIdleMs,
      options.transferMaxMs ?? peerTransferLimitMs(file.size),
    );
    try {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', file.size);
      const stream = handle.createReadStream();
      stream.on('data', () => timer.touch());
      await pipeline(stream, res);
    } finally {
      timer.close();
      await handle.close().catch(() => {});
    }
  });

  app.get('/peer/v1/tasks/:id/result', async (req: PeerRequest, res) => {
    const id = own(req);
    const { wait } = resultQuerySchema.parse(req.query);
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const result = await runner.result(id, wait ?? 0, abort.signal);
    if (abort.signal.aborted) return;
    if (!result) throw notFound();
    res.json(result);
  });

  app.post('/peer/v1/tasks/:id/cancel', (req: PeerRequest, res) => {
    const id = own(req);
    const status = runner.status(id);
    if (!status || (!settledStatuses.has(status.status) && !runner.cancel(id))) throw notFound();
    res.json({ ok: true });
  });

  // Server-sent events: a "status" event whenever the task's state changes, then one "result" event and the end.
  app.get('/peer/v1/tasks/:id/events', (req: PeerRequest, res) => {
    const id = own(req);
    const peerId = req.peer!.id;
    if ((streams.get(peerId) ?? 0) >= maxStreamsPerPeer) throw new PeerError(429, '同时打开的进度连接太多了。');
    streams.set(peerId, (streams.get(peerId) ?? 0) + 1);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    let last = '';
    let closed = false;
    let beats = 0;
    const send = (event: string, value: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
    const finish = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      streams.set(peerId, Math.max(0, (streams.get(peerId) ?? 1) - 1));
      res.end();
    };
    const look = async () => {
      if (closed) return;
      const status = runner.status(id);
      if (!status) return finish();
      const text = JSON.stringify(status);
      if (text !== last) {
        last = text;
        send('status', status);
      } else if (++beats % 8 === 0) res.write(': heartbeat\n\n');
      if (settledStatuses.has(status.status)) {
        const result = await runner.result(id, 0);
        if (!closed && result) send('result', result);
        finish();
      }
    };
    const timer = setInterval(() => void look(), options.eventPollMs ?? 2000);
    req.on('close', finish);
    void look();
  });

  app.put('/peer/v1/slack', async (req, res) => {
    const input = slackHostRequestSchema.parse(req.body);
    if (!options.slack) throw new PeerError(400, '这台设备不能运行 Slack。');
    res.json(await options.slack(input));
  });

  const github = () => {
    if (!options.github) throw new PeerError(400, '这台设备不能运行 GitHub 维护。');
    return options.github;
  };
  app.put('/peer/v1/github', async (req, res) => {
    const input = githubHostRequestSchema.parse(req.body);
    res.json(githubHostReplySchema.parse(await github().set(input)));
  });
  app.get('/peer/v1/github/status', async (_req, res) => {
    res.json(githubStatusSchema.parse(await github().status()));
  });
  app.post('/peer/v1/github/judge/resume', async (req, res) => {
    z.object({}).strict().parse(req.body);
    const host = github();
    if (!host.resumeJudge) throw new PeerError(400, 'GitHub judge resume is unavailable');
    await host.resumeJudge();
    res.json({ ok: true });
  });
  app.get('/peer/v1/github/outbox', (_req, res) => {
    res.json(githubOutboxSchema.parse({ items: github().outbox() }));
  });
  app.post('/peer/v1/github/outbox/:id/resolve', async (req, res) => {
    const id = outboxItemSchema.shape.id.parse(req.params.id);
    const resolution = githubResolveSchema.parse(req.body);
    if (!(await github().resolve(id, resolution))) throw new PeerError(404, 'GitHub card is no longer open');
    res.json({ ok: true });
  });

  // The paired PugPort removing this node on its side revokes its own token here.
  app.delete('/peer/v1/pairing', async (req: PeerRequest, res) => {
    await registry.revoke(req.peer!.id);
    options.log?.(`[peer] "${req.peer!.name}" unpaired itself`);
    res.json({ ok: true });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: '没有这个接口。' });
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return void res.end();
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n') });
      return;
    }
    if (error instanceof PeerError || error instanceof PeerRepoError)
      return void res.status(error.status).json({ error: error.message });
    if (error instanceof PeerRequestNotSent)
      return void res.status(409).json({ error: error.message, code: 'PEER_REQUEST_NOT_SENT' });
    if (error instanceof PeerCancelUnconfirmed)
      return void res.status(409).json({ error: error.message, code: 'PEER_CANCEL_UNCONFIRMED' });
    const status = (error as { status?: number; type?: string })?.status;
    if (status === 413) return void res.status(413).json({ error: '内容太长了。' });
    if (status === 400) return void res.status(400).json({ error: '请求格式不对。' });
    const text = error instanceof Error ? error.message : '请求失败';
    res.status(400).json({ error: text.slice(0, 1000) });
  });
  return app;
}
