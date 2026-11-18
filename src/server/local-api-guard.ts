import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { isAttachmentUpload } from './attachment-routes.ts';

let sessionFileProblem: string | undefined;
export function reportSessionFileProblem(text: string | undefined) {
  sessionFileProblem = text;
}

export function localApiGuard(token: string, allowedHosts: Set<string>, allowedOrigins: Set<string>): RequestHandler {
  return (req, res, next) => {
    if (!allowedHosts.has(req.headers.host || '')) {
      res.status(403).json({ error: 'Invalid host' });
      return;
    }
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      res.status(403).json({ error: 'Invalid origin' });
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const api = /^\/api\//i.test(req.path);
    if (api) res.setHeader('Cache-Control', 'no-store');
    // The agent bridge authenticates each executor run with its own bearer token instead of the UI session token.
    if (req.path === '/mcp') {
      if (req.method === 'POST' && !req.is('application/json')) {
        res.status(415).json({ error: 'JSON required' });
        return;
      }
      next();
      return;
    }
    if (req.method === 'POST' && req.path === '/api/external/grok-bot/replies') {
      if (!req.is('application/json')) {
        res.status(415).json({ error: 'JSON required' });
        return;
      }
      next();
      return;
    }
    if (
      !['GET', 'HEAD'].includes(req.method) ||
      (api && !/^\/api\/(?:health|connectors\/oauth\/callback)$/i.test(req.path))
    ) {
      const supplied = req.headers['x-agent-token'];
      // Compared as bytes: a header with non-ASCII characters has the token's length in characters but not in bytes.
      const value = typeof supplied === 'string' ? Buffer.from(supplied) : undefined;
      if (!value || value.length !== Buffer.byteLength(token) || !timingSafeEqual(value, Buffer.from(token))) {
        res.status(403).json({
          error: sessionFileProblem
            ? `PugPort could not write its session file (${sessionFileProblem}); the pugport command, the MCP server and the device node cannot connect until it can. The desktop window still works.`
            : 'Local session token required: update the pugport command, the pugport MCP server or the device node to this PugPort version.',
        });
        return;
      }
      // Recorded audio is the one binary body, and only on its own route (still behind the session token).
      const audio =
        /^\/api\/voice\/(?:sessions\/[\w-]+\/audio|live\/sessions\/[\w-]+\/exchange)$/.test(req.path) &&
        req.is('application/octet-stream');
      // A request without a body (closing a background task, removing a queued item) has nothing to check;
      // any body must be JSON. (req.is() is false for an empty body even with the JSON header.)
      const hasBody = req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0;
      if (!audio && !isAttachmentUpload(req.method, req.path) && hasBody && !req.is('application/json')) {
        res.status(415).json({ error: 'JSON required' });
        return;
      }
    }
    next();
  };
}

const fileTokenWrites: [string, RegExp][] = [
  ['POST', /^\/api\/external\/tasks$/],
  ['POST', /^\/api\/external\/tasks\/[^/]+\/cancel$/],
  ['POST', /^\/api\/external\/conversations\/[^/]+\/messages$/],
  ['POST', /^\/api\/projects$/],
  ['POST', /^\/api\/conversations$/],
  ['POST', /^\/api\/conversations\/[^/]+\/messages$/],
  ['POST', /^\/api\/workflows\/[^/]+\/cancel$/],
  ['POST', /^\/api\/workspace\/refresh$/],
  ['POST', /^\/api\/node\/pairing$/],
  ['DELETE', /^\/api\/node\/peers(?:\/[^/]+)?$/],
  ['POST', /^\/api\/conversations\/[^/]+\/work\/(?:messages|jobs|lanes)$/],
  ['PATCH', /^\/api\/conversations\/[^/]+\/work\/(?:settings|jobs\/[^/]+)$/],
  ['DELETE', /^\/api\/conversations\/[^/]+\/work\/jobs\/[^/]+$/],
  // Soft deletes the owner's own Claude Code sessions use to clean up after dispatches; both can be restored.
  ['DELETE', /^\/api\/conversations\/[^/]+$/],
  ['DELETE', /^\/api\/projects\/[^/]+$/],
];
export function ownerApiGuard(owner: string | undefined): RequestHandler {
  return (req, res, next) => {
    const supplied = req.headers['x-pugport-owner'];
    const value = typeof supplied === 'string' ? Buffer.from(supplied) : undefined;
    const expected = owner ? Buffer.from(owner) : undefined;
    res.locals.owner = !!value && !!expected && value.length === expected.length && timingSafeEqual(value, expected);
    if (
      res.locals.owner ||
      req.method === 'GET' ||
      req.method === 'HEAD' ||
      !/^\/api\//i.test(req.path) ||
      req.path === '/api/external/grok-bot/replies' ||
      fileTokenWrites.some(([method, path]) => method === req.method && path.test(req.path))
    )
      return next();
    res.status(403).json({ error: 'Only the PugPort desktop window can do this.' });
  };
}
