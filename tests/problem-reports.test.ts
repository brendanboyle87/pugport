import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProblemReports } from '../src/server/problem-reports.ts';
import { redactProblemValue, type ProblemReportInboxItem } from '../src/shared/problem-report.ts';
import express from 'express';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { problemReportRoutes } from '../src/server/problem-report-routes.ts';

const report: ProblemReportInboxItem = {
  id: 'PP-1234',
  createdAt: '2026-01-01',
  description: 'Synthetic failure',
  diagnostics: {},
  version: '1',
  os: 'test',
  status: 'new',
  images: [],
  duplicateCount: 2,
};

test('structured diagnostic credential values are redacted by their keys', () => {
  assert.deepEqual(
    redactProblemValue({
      nested: { refresh_token: 'opaque', client_secret: 'opaque', token: 'opaque', password: 'opaque' },
      status: 'failed',
    }),
    {
      nested: { refresh_token: '[secret]', client_secret: '[secret]', token: '[secret]', password: '[secret]' },
      status: 'failed',
    },
  );
});
async function setup(fetcher: typeof fetch, extra: Partial<ConstructorParameters<typeof ProblemReports>[0]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pugport-report-test-'));
  const options: ConstructorParameters<typeof ProblemReports>[0] = {
    directory,
    url: 'https://relay.example.test',
    publishableKey: 'fake',
    fetch: fetcher,
    session: () => undefined,
    context: async () => ({
      state: { app: { name: 'PugPort', version: '1', platform: 'test', dataDir: 'synthetic' }, runtimes: [] },
    }),
    diagnose: async () => 'synthetic-task',
    ...extra,
  };
  return { service: new ProblemReports(options), options, directory };
}
test('offline draft survives restart; preview is exactly the POST payload and retry respects backoff', async () => {
  let now = 0,
    calls = 0,
    online = false;
  let transmitted: unknown;
  const fake: typeof fetch = async (url, init) => {
    calls++;
    if (!online) throw Error('offline');
    if (String(url).endsWith('/status')) return Response.json({ status: 'new' });
    transmitted = JSON.parse(String(init?.body));
    return Response.json({ id: 'PP-1234', secret: new Headers(init?.headers).get('x-report-secret') });
  };
  const { service, options, directory } = await setup(fake, { now: () => now });
  const preview = await service.preview({ description: 'Failure user@example.test' });
  const saved = await service.submit(preview, []);
  assert.equal(saved.status, 'draft');
  assert.equal(calls, 1);
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, 'problem-reports.json'), 'utf8')).reports[0].payload,
    preview,
  );
  const restarted = new ProblemReports(options);
  await restarted.tick();
  assert.equal(calls, 1);
  now = 30_000;
  online = true;
  await restarted.tick();
  assert.deepEqual(transmitted, preview);
  assert.equal((await restarted.list())[0].status, 'sent');
  assert.equal((await restarted.preview({ description: 'Second' })).installId, preview.installId);
  assert.doesNotMatch(JSON.stringify(await restarted.list()), /synthetic-secret|diagnostics/);
});
test('admin 403 disables polling for the session and account switch re-enables it', async () => {
  let userId = 'one',
    calls = 0,
    now = 0;
  const { service } = await setup(
    async () => {
      calls++;
      return Response.json({}, { status: 403 });
    },
    { session: () => ({ userId, accessToken: 'fake' }), now: () => now },
  );
  await service.tick();
  now = 60 * 60_000;
  await service.tick(true);
  assert.equal(calls, 1);
  userId = 'two';
  await service.tick(true);
  assert.equal(calls, 2);
});
test('owner actions use cached verified owner, dispatch bundle, and lose authorization immediately on account switch', async () => {
  let userId = 'owner',
    dispatched = 0;
  const calls: string[] = [];
  const { service } = await setup(
    async (url, init) => {
      calls.push(String(url));
      assert.equal(init?.redirect, 'error');
      return Response.json(
        init?.method === 'POST' ? {} : String(url).endsWith('/' + report.id) ? { report } : { reports: [report] },
      );
    },
    {
      session: () => ({ userId, accessToken: 'fake' }),
      diagnose: async (item, directory) => {
        assert.equal(JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')).id, item.id);
        dispatched++;
        return 'diagnosis-task';
      },
    },
  );
  await assert.rejects(service.diagnose(report.id), /OWNER_REQUIRED/);
  await service.tick();
  assert.equal(service.count(), 1);
  assert.deepEqual(await service.diagnose(report.id), { taskId: 'diagnosis-task' });
  assert.equal(service.inbox()[0].taskId, 'diagnosis-task');
  userId = 'different';
  await assert.rejects(service.diagnose(report.id), /OWNER_REQUIRED/);
  await assert.rejects(service.setStatus(report.id, 'fixed', '1.2'), /OWNER_REQUIRED/);
  assert.equal(dispatched, 1);
  assert.equal(service.count(), 0);
  await service.tick(true);
  await service.setStatus(report.id, 'fixed', '1.2');
  assert.equal(service.count(), 0);
  assert.ok(calls.some((url) => url.endsWith('/PP-1234/status')));
});
test('supplemental image failure stays a draft and retries without creating a second report', async () => {
  let online = false,
    creates = 0,
    now = 0;
  const { service } = await setup(
    async (url, init) => {
      if (String(url).endsWith('/files')) {
        if (!online) throw Error('offline');
        return Response.json({ uploaded: 1 });
      }
      if (String(url).endsWith('/status')) return Response.json({ status: 'new' });
      creates++;
      return Response.json({ id: 'PP-1234', secret: new Headers(init?.headers).get('x-report-secret') });
    },
    { now: () => now },
  );
  const item = await service.submit(await service.preview({ description: 'Failure' }), []);
  assert.equal(item.status, 'sent');
  const updated = await service.addFiles(item.localId, [{ dataUrl: 'data:image/jpeg;base64,/9j/2Q==' }]);
  assert.equal(updated.status, 'draft');
  now = 30_000;
  online = true;
  await service.tick();
  assert.equal((await service.list())[0].status, 'sent');
  assert.equal(creates, 1);
});
test('status checks only own sent reports on start and every six hours', async () => {
  let now = 0,
    checks = 0;
  const { service } = await setup(
    async (url, init) => {
      if (String(url).endsWith('/status')) {
        checks++;
        return Response.json({ status: checks > 1 ? 'fixed' : 'new', fixedIn: '2.0' });
      }
      return Response.json({ id: 'PP-1234', secret: new Headers(init?.headers).get('x-report-secret') });
    },
    { now: () => now },
  );
  await service.submit(await service.preview({ description: 'Failure' }), []);
  await service.tick();
  now = 60_000;
  await service.tick(true);
  assert.equal(checks, 1);
  now = 6 * 3600_000;
  await service.tick();
  assert.equal((await service.list())[0].fixedIn, '2.0');
  assert.equal((await service.list())[0].status, 'fixed');
});
test('800-task scale state count performs no context projection, file read, or network request', async () => {
  const tasks = Array.from({ length: 800 }, (_, id) => ({ id }));
  let contexts = 0;
  const { service } = await setup(
    async () => {
      throw Error('unexpected network');
    },
    {
      context: async () => {
        contexts++;
        throw Error(String(tasks.length));
      },
    },
  );
  for (let i = 0; i < 800; i++) assert.equal(service.count(), 0);
  assert.equal(contexts, 0);
});

test('HTTP preview, submit, list, inbox and action routes preserve the canonical payload', async () => {
  let sent: unknown;
  const { service } = await setup(async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return Response.json({ id: 'PP-1234', secret: new Headers(init?.headers).get('x-report-secret') });
  });
  const app = express();
  problemReportRoutes(app, service);
  const request = (method: string, url: string, body?: unknown) =>
    new Promise<any>((resolve, reject) => {
      const req = new IncomingMessage(new Socket());
      req.method = method;
      req.url = url;
      Object.assign(req, { body });
      const res = new ServerResponse(req);
      res.end = ((data: string) => {
        resolve(JSON.parse(data));
        return res;
      }) as typeof res.end;
      (
        app as unknown as {
          handle: (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void;
        }
      ).handle(req, res, (error) => reject(error ?? Error('Route not found')));
    });
  const preview = await request('POST', '/api/problem-reports/preview', { description: 'Error at user@example.test' });
  const submitted = await request('POST', '/api/problem-reports', { payload: preview, images: [] });
  assert.deepEqual(sent, preview);
  assert.equal(submitted.id, 'PP-1234');
  const listed = await request('GET', '/api/problem-reports');
  assert.equal(listed.reports.length, 1);
  assert.equal(listed.reports[0].secret, undefined);
  assert.deepEqual(await request('GET', '/api/problem-reports/inbox'), { reports: [] });
  await assert.rejects(request('POST', '/api/problem-reports/PP-1234/diagnose'), /OWNER_REQUIRED/);
  await assert.rejects(
    request('POST', '/api/problem-reports/PP-1234/status', { status: 'fixed', fixedIn: '2' }),
    /OWNER_REQUIRED/,
  );
  await assert.rejects(
    request('POST', '/api/problem-reports/preview', { description: 'x', includeConversation: 'true' }),
  );
});

test('an old admin response cannot authorize or disable a newly signed-in session of the same user', async () => {
  for (const status of [200, 403]) {
    let sessionId = 'first';
    let finish!: (response: Response) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    const { service } = await setup(
      async () => {
        calls++;
        if (calls > 1) return Response.json({ reports: [report] });
        entered();
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      },
      { session: () => ({ userId: 'same-user', accessToken: 'fake', sessionId }) },
    );
    const pending = service.tick();
    await started;
    sessionId = 'second';
    assert.equal(service.count(), 0);
    finish(Response.json({ reports: [report] }, { status }));
    await pending;
    assert.equal(service.count(), 0);
    await assert.rejects(service.diagnose(report.id), /OWNER_REQUIRED/);
    await service.tick();
    assert.equal(calls, 2);
    assert.equal(service.count(), 1);
  }
});

test('conversation opt-in reaches the selected conversation even when it has no task', async () => {
  const { service } = await setup(
    async () => {
      throw Error('unexpected network');
    },
    {
      context: async (taskId, includeConversation, conversationId) => {
        assert.equal(taskId, undefined);
        assert.equal(conversationId, 'older-conversation');
        return {
          state: { app: { name: 'PugPort', version: '1', platform: 'test', dataDir: '' }, runtimes: [] },
          ...(includeConversation ? { conversation: [{ role: 'user', content: 'Synthetic older message' }] } : {}),
        };
      },
    },
  );
  const included = await service.preview({
    description: 'Failure',
    includeConversation: true,
    conversationId: 'older-conversation',
  });
  assert.deepEqual(included.diagnostics.conversation, [{ role: 'user', content: 'Synthetic older message' }]);
  const excluded = await service.preview({
    description: 'Failure',
    includeConversation: false,
    conversationId: 'older-conversation',
  });
  assert.equal(excluded.diagnostics.conversation, undefined);
});

test('lost create response retries the persisted secret after restart without duplicating the report', async () => {
  let now = 0;
  let loseResponse = true;
  let directory = '';
  const received = new Map<string, string>();
  const submittedSecrets: string[] = [];
  const {
    service,
    options,
    directory: dataDir,
  } = await setup(
    async (url, init) => {
      if (String(url).endsWith('/status')) return Response.json({ status: 'new' });
      const secret = new Headers(init?.headers).get('x-report-secret')!;
      assert.match(secret, /^[a-f0-9]{64}$/);
      const stored = JSON.parse(await readFile(join(directory, 'problem-reports.json'), 'utf8'));
      assert.equal(stored.reports[0].secret, secret, 'secret must reach disk before the first POST');
      submittedSecrets.push(secret);
      if (!received.has(secret)) received.set(secret, `PP-${1000 + received.size}`);
      if (loseResponse) {
        loseResponse = false;
        throw Error('response lost after commit');
      }
      return Response.json({ id: received.get(secret), secret });
    },
    { now: () => now },
  );
  directory = dataDir;
  const preview = await service.preview({ description: 'Synthetic failure' });
  assert.equal((await service.submit(preview, [])).status, 'draft');
  now = 30_000;
  const restarted = new ProblemReports(options);
  await restarted.tick();
  assert.equal((await restarted.list())[0].status, 'sent');
  assert.equal(received.size, 1);
  assert.equal(submittedSecrets.length, 2);
  assert.equal(submittedSecrets[0], submittedSecrets[1]);
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, 'problem-reports.json'), 'utf8')).reports[0].payload,
    preview,
  );
});

test('successful uploads discard local images while retaining the cumulative four-image limit', async () => {
  const image = { dataUrl: 'data:image/jpeg;base64,/9j/2Q==' };
  let failUpload = false;
  let now = 0;
  const uploads: number[] = [];
  const { service, options, directory } = await setup(
    async (url, init) => {
      if (String(url).endsWith('/files')) {
        uploads.push(JSON.parse(String(init?.body)).images.length);
        if (failUpload) throw Error('offline');
        return Response.json({ uploaded: 2 });
      }
      if (String(url).endsWith('/status')) return Response.json({ status: 'fixed', fixedIn: '2' });
      return Response.json({ id: 'PP-1234', secret: new Headers(init?.headers).get('x-report-secret') });
    },
    { now: () => now },
  );
  const read = async () => JSON.parse(await readFile(join(directory, 'problem-reports.json'), 'utf8')).reports[0];
  const created = await service.submit(await service.preview({ description: 'Synthetic failure' }), [image, image]);
  assert.deepEqual((await read()).images, []);
  assert.equal((await read()).imageCount, 2);
  failUpload = true;
  await service.addFiles(created.localId, [image, image]);
  assert.equal((await read()).images.length, 2);
  assert.equal((await read()).imageCount, 4);
  await assert.rejects(service.addFiles(created.localId, [image]), /TOO_MANY_IMAGES/);
  failUpload = false;
  now = 30_000;
  const restarted = new ProblemReports(options);
  await restarted.tick();
  assert.deepEqual((await read()).images, []);
  assert.equal((await read()).uploaded, 4);
  assert.equal((await read()).status, 'fixed');
  assert.doesNotMatch(await readFile(join(directory, 'problem-reports.json'), 'utf8'), /data:image/);
  assert.deepEqual(uploads, [2, 2, 2]);
  await restarted.tick();
  assert.deepEqual(uploads, [2, 2, 2], 'status checks do not upload cleared images');
  await assert.rejects(restarted.addFiles(created.localId, [image]), /TOO_MANY_IMAGES/);
});

test('legacy local data drops uploaded images and gives unsent drafts a durable secret', async () => {
  const image = { dataUrl: 'data:image/jpeg;base64,/9j/2Q==' };
  const { service, options, directory } = await setup(async () => {
    throw Error('no network during migration');
  });
  const payload = await service.preview({ description: 'Synthetic legacy failure' });
  await writeFile(
    join(directory, 'problem-reports.json'),
    JSON.stringify({
      installId: payload.installId,
      reports: [
        {
          localId: 'sent',
          id: 'PP-1234',
          secret: 'legacy',
          payload,
          description: 'Sent',
          status: 'sent',
          imageCount: 2,
          images: [image, image],
          uploaded: 2,
          attempts: 0,
          retryAt: 0,
        },
        {
          localId: 'draft',
          payload,
          description: 'Draft',
          status: 'draft',
          imageCount: 1,
          images: [image],
          uploaded: 0,
          attempts: 1,
          retryAt: 100000,
        },
      ],
    }),
  );
  const restarted = new ProblemReports(options);
  await restarted.list();
  const saved = JSON.parse(await readFile(join(directory, 'problem-reports.json'), 'utf8'));
  assert.equal(saved.version, 2);
  assert.deepEqual(saved.reports[0].images, []);
  assert.equal(saved.reports[0].imageCount, 2);
  assert.equal(saved.reports[1].images.length, 1);
  assert.match(saved.reports[1].secret, /^[a-f0-9]{64}$/);
  const again = new ProblemReports(options);
  await again.list();
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'problem-reports.json'), 'utf8')), saved);
});

test('owner polling keeps only summaries and diagnosis fetches fresh details on demand', async () => {
  const calls: string[] = [];
  let diagnosed: ProblemReportInboxItem | undefined;
  const { service } = await setup(
    async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/' + report.id))
        return Response.json({ report: { ...report, diagnostics: { errors: 'fresh error' } } });
      return Response.json({ reports: [{ ...report, diagnostics: { errors: 'stale must not be cached' } }] });
    },
    {
      session: () => ({ userId: 'owner', accessToken: 'fake' }),
      diagnose: async (detail) => {
        diagnosed = detail;
        return 'diagnosis';
      },
    },
  );
  await service.tick();
  assert.equal(calls.length, 1);
  assert.equal(service.inbox()[0].diagnostics, undefined);
  await service.diagnose(report.id);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].endsWith('/' + report.id));
  assert.deepEqual(diagnosed?.diagnostics, { errors: 'fresh error' });
  assert.equal(service.inbox()[0].diagnostics, undefined);
});
