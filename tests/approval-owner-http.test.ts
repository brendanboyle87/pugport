import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { localApiGuard } from '../src/server/local-api-guard.ts';
import { DesktopPermissionRequired } from '../src/server/permission-guards.ts';

// Register the actual main.ts route callbacks with a stub controller, without starting an executor.
test('a local session can deny an approval but cannot allow or remember it', async () => {
  const source = readFileSync(new URL('../src/server/main.ts', import.meta.url), 'utf8');
  const session = source.match(/app\.get\('\/api\/session',[^\n]+/)?.[0];
  const route = source.match(/app\.post\('\/api\/approvals\/:id', [\s\S]*?\n\}\);/)?.[0];
  assert.ok(session && route);
  const handlers = new Map<string, Function>();
  const app = {
    get: (path: string, handler: Function) => handlers.set(path, handler),
    post: (path: string, handler: Function) => handlers.set(path, handler),
  };
  const token = 'synthetic-token';
  let pending = true;
  let denied = false;
  const controller = {
    answerApproval(_id: string, allow: boolean) {
      pending = false;
      denied = !allow;
    },
  };
  new Function('app', 'token', session)(app, token);
  new Function('app', 'controller', 'z', 'DesktopPermissionRequired', route)(
    app,
    controller,
    z,
    DesktopPermissionRequired,
  );
  const guard = localApiGuard(token, new Set(['localhost']), new Set());
  function request(path: string, body?: object, supplied?: string) {
    let status = 200;
    let result: any;
    const req = {
      method: body ? 'POST' : 'GET',
      path,
      params: { id: 'fixture' },
      body,
      headers: {
        host: 'localhost',
        ...(supplied ? { 'x-agent-token': supplied } : {}),
        ...(body ? { 'content-length': '1' } : {}),
      },
      is: () => true,
    };
    const res = {
      setHeader() {},
      status(value: number) {
        status = value;
        return this;
      },
      json(value: unknown) {
        result = value;
        return this;
      },
    };
    guard(req as any, res as any, () => {
      try {
        handlers.get(path.startsWith('/api/approvals/') ? '/api/approvals/:id' : path)!(req, res);
      } catch (error) {
        if (error instanceof DesktopPermissionRequired) status = 403;
        else throw error;
      }
    });
    return { status, result };
  }
  const sessionToken = request('/api/session', undefined, token).result.token;
  assert.equal(sessionToken, token);
  assert.equal(request('/api/approvals/fixture', { allow: true }, sessionToken).status, 403);
  assert.equal(pending, true);
  assert.equal(request('/api/approvals/fixture', { allow: true, remember: true }, sessionToken).status, 403);
  assert.equal(pending, true);
  assert.equal(request('/api/approvals/fixture', { allow: false }, sessionToken).status, 200);
  assert.equal(denied, true);
});
