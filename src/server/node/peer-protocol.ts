import { z } from 'zod';
import { judgePinSchema, repositorySchema } from '../maintainer/config.ts';
import { projectGatesInputSchema } from '../../shared/project-gates.ts';

/*
 * The peer API between the desktop PugPort and a device node (`/peer/v1/...`). Both sides validate with these
 * schemas: the node what it is sent, the desktop what the node answers. Nothing in here carries file bytes, a secret
 * of the node, or its local session token.
 */

export const defaultPeerPort = 4318;
/** One-time pairing codes: 8 letters/digits without look-alikes, shown as ABCD-EFGH. */
export const pairingAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const pairingCodeLength = 8;
export const pairingLifetimeMs = 10 * 60_000;
export const pairingAttempts = 5;
/** 32 random bytes, base64url. */
export const peerTokenPattern = /^[A-Za-z0-9_-]{43}$/;
export const maxPeers = 20;
export const maxResultWaitSeconds = 50;
// A sender never re-POSTs an id after this window. Settled records can then expire safely on the node.
export const peerRequestRetryMs = 24 * 60 * 60_000;
export const peerRequestKeepMs = 7 * 24 * 60 * 60_000;
export const maxPeerRequests = 10_000;
export const maxPeerCancelTombstones = 1000;

/** "abcd efgh", "ABCD-EFGH" and "abcdefgh" are the same code. */
export const normalizePairingCode = (code: string) => code.toUpperCase().replace(/[\s-]/g, '');
export const formatPairingCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

const name = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), 'name: control characters are not allowed');

export const pairRequestSchema = z.object({ code: z.string().trim().min(4).max(20), name }).strict();

export const peerTaskRequestSchema = z
  .object({
    task: z.string().trim().min(1).max(50000),
    title: z.string().trim().min(1).max(150).optional(),
    /** A folder on the node; refused unless it exists there. */
    projectPath: z.string().trim().min(1).max(4000).optional(),
    write: z.boolean().optional(),
    requestId: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,100}$/)
      .optional(),
    /** The task quotes other people's words: it runs without tools on the node too. */
    untrusted: z.boolean().optional(),
  })
  .strict();
export type PeerTaskRequest = z.infer<typeof peerTaskRequestSchema>;

export const taskIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,100}$/);
export const peerRequestLookupSchema = z.object({ taskId: taskIdSchema.nullable() });
export const resultQuerySchema = z
  .object({ wait: z.coerce.number().finite().nonnegative().max(maxResultWaitSeconds).optional() })
  .strict();

const slackUser = z
  .object({
    id: z.string().regex(/^[UW][A-Z0-9]{2,30}$/),
    name: z.string().max(200).optional(),
    pairedAt: z.string().max(40),
    isOwner: z.boolean().optional(),
  })
  .strict();
/** Choosing which PugPort runs the Slack gateway: the chosen node gets the desktop's Slack setup once. */
export const slackHostRequestSchema = z.discriminatedUnion('host', [
  z
    .object({
      host: z.literal(true),
      appToken: z.string().max(1000),
      botToken: z.string().max(1000),
      users: z.array(slackUser).max(100),
    })
    .strict(),
  z.object({ host: z.literal(false) }).strict(),
]);
export type SlackHostRequest = z.infer<typeof slackHostRequestSchema>;

// ---- Replies, as the desktop reads them.

const stamp = z.string().max(40);
const bytes = z.number().finite().nonnegative();
export const peerHardwareSchema = z.object({
  os: z.string().max(80),
  cpu: z.string().max(120).optional(),
  gpu: z.string().max(120).optional(),
  gpuOthers: z.array(z.string().max(120)).max(4).optional(),
  cores: z.number().int().min(1).max(4096).optional(),
  threads: z.number().int().min(1).max(4096).optional(),
  memoryTotal: bytes.optional(),
  memoryAvailable: bytes.optional(),
  diskTotal: bytes.optional(),
  diskFree: bytes.optional(),
  readAt: stamp,
});
export type PeerHardware = z.infer<typeof peerHardwareSchema>;
const percent = z.number().finite().min(0).max(100);
export const peerResourcesSchema = z.object({
  cpuPercent: percent.optional(),
  gpuPercent: percent.optional(),
  gpuName: z.string().max(120).optional(),
  memoryUsed: bytes.optional(),
  memoryTotal: bytes.optional(),
  vram: z.object({ usedMiB: bytes, totalMiB: bytes }).optional(),
  observedAt: stamp,
});
export const peerInfoSchema = z.object({
  nodeId: z.string().uuid().optional(),
  hardware: peerHardwareSchema.optional().catch(undefined),
  resources: peerResourcesSchema.optional().catch(undefined),
  name: z.string().max(60),
  version: z.string().max(40),
  role: z.literal('node'),
  hostname: z.string().max(255),
  platform: z.string().max(20),
  arch: z.string().max(20),
  capabilities: z.record(z.string().max(40), z.boolean()),
  /** This node runs the Slack gateway. */
  slackHost: z.boolean(),
  githubHost: z.boolean().optional(),
  allowWrite: z.boolean().optional(),
  /** What the node calls the asking PugPort. */
  peerName: z.string().max(60).optional(),
});
export type PeerInfo = z.infer<typeof peerInfoSchema>;

/** A systemd service name or pattern as remote-servers.json lists it (never an option). */
export const servicePatternSchema = z.string().regex(/^[A-Za-z0-9@_:*][A-Za-z0-9@._:*-]{0,99}$/);
/** list-units matches names as written: nginx means nginx.service. */
export const serviceUnitPattern = (pattern: string) =>
  /[*?[]|\.service$/.test(pattern) ? pattern : `${pattern}.service`;
export const serverStatusQuerySchema = z
  .object({ service: z.union([servicePatternSchema, z.array(servicePatternSchema).max(8)]).optional() })
  .strict();
/** GET /peer/v1/status: the remote server card's live reading, from the node instead of an SSH shell. */
export const peerServerStatusSchema = z.object({
  cpuPercent: percent.optional(),
  cores: z.number().int().min(1).max(4096).optional(),
  arch: z.string().max(40).optional(),
  memoryTotal: bytes.optional(),
  memoryAvailable: bytes.optional(),
  diskTotal: bytes.optional(),
  diskFree: bytes.optional(),
  /** systemd unit names as listed, with their ACTIVE state. */
  services: z
    .array(z.object({ name: z.string().max(200), state: z.string().max(40) }))
    .max(16)
    .optional(),
  observedAt: stamp,
});
export type PeerServerStatus = z.infer<typeof peerServerStatusSchema>;

export const pairReplySchema = z.object({
  peerId: z.string().max(100),
  token: z.string().regex(peerTokenPattern),
  node: peerInfoSchema,
});
export type PairReply = z.infer<typeof pairReplySchema>;

export const peerExecutorSchema = z.object({
  label: z.string().max(200),
  provider: z.string().max(20),
  status: z.string().max(40),
  windows: z
    .array(
      z.object({
        name: z.string().max(60),
        remaining: z.number().min(0).max(100).optional(),
        resetsAt: stamp.nullable().optional().catch(undefined),
      }),
    )
    .max(20),
  plan: z
    .string()
    .transform((value) => value.slice(0, 60))
    .optional()
    .catch(undefined),
  stale: z.boolean().optional().catch(undefined),
  tightest: z.number().min(0).max(100).optional(),
  observedAt: stamp.nullable(),
});
export type PeerExecutor = z.infer<typeof peerExecutorSchema>;
export const peerRuntimesSchema = z.object({
  executors: z.array(peerExecutorSchema).max(100),
  running: z.number().int().min(0),
});
export type PeerRuntimes = z.infer<typeof peerRuntimesSchema>;

/** Explicit public activity whitelist: tool payloads and output never cross the peer boundary. */
export const peerTaskProgressSchema = z.object({
  lastActivityAt: stamp.optional(),
  toolCalls: z.number().int().min(0).optional(),
  toolCallsAtLeast: z.boolean().optional(),
  step: z
    .object({
      kind: z.enum(['tool', 'writing', 'approval']),
      tool: z
        .string()
        .regex(/^[\w./:-]{1,100}$/)
        .optional(),
      status: z.string().max(30).optional(),
    })
    .optional(),
  planStep: z.object({ index: z.number().int().min(1).max(1000), total: z.number().int().min(1).max(1000) }).optional(),
});

export const peerTaskStatusSchema = z.object({
  taskId: z.string().max(100),
  status: z.string().max(40),
  phase: z.string().max(40).optional(),
  executor: z.string().max(200).optional(),
  model: z.string().max(300).optional(),
  startedAt: stamp.optional(),
  endedAt: stamp.optional(),
  error: z.string().max(4000).optional(),
  note: z.string().max(4000).optional(),
  progress: peerTaskProgressSchema.optional().catch(undefined),
});
export type PeerTaskStatus = z.infer<typeof peerTaskStatusSchema>;

export const dispatchReplySchema = z.object({ taskId: z.string().max(100), status: z.string().max(40) });

export const maxResultLength = 200_000;
export const peerTaskResultSchema = z.object({
  status: z.string().max(40),
  result: z.string().max(maxResultLength).optional(),
  error: z.string().max(maxResultLength).optional(),
  files: z
    .array(
      z.object({
        id: taskIdSchema,
        name: z.string().max(200),
        size: z
          .number()
          .int()
          .min(0)
          .max(2 * 1024 ** 3),
      }),
    )
    .max(16)
    .optional(),
});
export type PeerTaskResult = z.infer<typeof peerTaskResultSchema>;

export const slackHostReplySchema = z.object({ slackHost: z.boolean() });
const githubSha = z.string().regex(/^[0-9a-f]{40}$/);
export const githubHostRequestSchema = z.discriminatedUnion('host', [
  z
    .object({
      host: z.literal(true),
      repository: repositorySchema,
      stage: z.number().int().min(0).max(3).default(0),
      requiredChecks: z.array(z.string().min(1)).optional(),
      gates: projectGatesInputSchema.optional(),
      suiteConfigured: z.boolean().optional(),
      judge: judgePinSchema.optional(),
      hostedBy: z.string().max(60),
      leaseMinutes: z.number().int().min(5).max(1440).default(360),
    })
    .strict(),
  z.object({ host: z.literal(false) }).strict(),
]);
export const githubHostReplySchema = z.object({ githubHost: z.boolean() });
export const githubStatusSchema = z.object({
  githubHost: z.boolean(),
  mode: z.enum(['off', 'shadow', 'live']),
  repository: repositorySchema.optional(),
  stage: z.number().int().min(0).max(3).optional(),
  judgingPaused: z.boolean().optional(),
  writesPausedUntil: stamp.optional(),
  lastPollAt: stamp.optional(),
  nextPollAt: stamp.optional(),
  rateRemaining: z.number().optional(),
  backoffUntil: stamp.optional(),
  ready: z.object({
    gh: z.boolean(),
    app: z.boolean(),
    toolless: z.boolean(),
    problem: z.string().max(300).optional(),
  }),
  counts: z.object({ prs: z.number(), issues: z.number(), judges: z.number(), writes: z.number() }),
  score: z.object({ judged: z.number(), falsePasses: z.number(), falseFails: z.number(), pending: z.number() }),
  recent: z
    .array(
      z.object({
        at: stamp,
        event: z.string().max(10),
        number: z.number().optional(),
        action: z.string().max(20),
        result: z.string().max(12),
      }),
    )
    .max(20),
});
export const outboxItemSchema = z.object({
  id: z.string().regex(/^card-\d{8}-[0-9a-f]{8}$/),
  kind: z.enum(['merge', 'review', 'ruling', 'security', 'close', 'suite']),
  mode: z.enum(['shadow', 'live']),
  number: z.number().int().positive(),
  title: z.string().max(200),
  url: z.string().url().max(2000),
  author: z.string().max(100),
  external: z.boolean(),
  tier: z.enum(['docs', 'code', 'owner']).optional(),
  judgedSha: githubSha.optional(),
  baseRef: z.string().max(255).optional(),
  verdict: z.enum(['pass', 'fail', 'blocked', 'invalid']).optional(),
  judgeId: z.string().max(40).optional(),
  ci: z
    .object({
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      pending: z.number().int().nonnegative(),
      unavailable: z.boolean(),
    })
    .optional(),
  suite: z
    .object({
      state: z.enum(['not-run', 'queued', 'running', 'passed', 'failed', 'error']),
      summary: z.string().max(1000).optional(),
    })
    .optional(),
  reasons: z.array(z.string().max(200)).max(8),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  supersededBy: githubSha.optional(),
  resolution: z
    .object({
      outcome: z.enum(['merged', 'declined', 'failed', 'superseded', 'suite-started', 'suite-result']),
      at: z.string().datetime(),
      mergeCommit: githubSha.optional(),
      detail: z.string().max(1000).optional(),
    })
    .optional(),
});
export const githubOutboxSchema = z.object({ items: z.array(outboxItemSchema).max(100) });
export const githubResolveSchema = z
  .object({
    outcome: z.enum(['merged', 'declined', 'failed', 'suite-started', 'suite-result']),
    mergeCommit: githubSha.optional(),
    detail: z.string().max(1000).optional(),
    suite: z
      .object({
        sha: githubSha,
        tests: z.number().nonnegative(),
        passed: z.number().nonnegative(),
        failed: z.number().nonnegative(),
        failingFiles: z.array(z.string().max(200)).max(50),
        minutes: z.number().nonnegative(),
        runId: z.string().max(40),
        status: z.enum(['passed', 'failed', 'error']),
        detail: z.string().max(1000).optional(),
      })
      .optional(),
  })
  .strict();
export type GitHubHostRequest = z.infer<typeof githubHostRequestSchema>;
export type GitHubStatus = z.infer<typeof githubStatusSchema>;
export type GitHubResolve = z.infer<typeof githubResolveSchema>;
export const okReplySchema = z.object({ ok: z.literal(true) });

/** Workflow states after which nothing more happens on its own. */
export const settledStatuses = new Set(['completed', 'blocked', 'failed', 'cancelled', 'interrupted']);
