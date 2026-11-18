import type { Express, RequestHandler } from 'express';
import { z } from 'zod';
import type { Devices } from './service.ts';
import { validateFiles } from '../node/peer-files.ts';

/** The 设备 card. Mounted behind main's localhost, origin and session-token guards; no token ever leaves here. */
export function deviceRoutes(app: Express, devices: Devices | undefined, refuseExecutors: RequestHandler) {
  const required = () => {
    if (!devices) throw new Error('设备节点本身不能再添加设备。');
    return devices;
  };
  app.get('/api/devices', async (req, res) => {
    const { refresh } = z.object({ refresh: z.enum(['0', '1']).optional() }).parse(req.query);
    res.json(devices ? await devices.view(refresh === '1') : { devices: [], slackHost: null });
  });
  app.post('/api/devices', async (req, res) => {
    const input = z
      .object({
        address: z.string().trim().min(1).max(300),
        code: z.string().trim().min(4).max(20),
        name: z.string().trim().max(24).optional(),
        tunnel: z
          .object({
            ssh: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/),
            remotePort: z.number().int().min(1).max(65535),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(req.body);
    res.status(201).json(await required().add(input));
  });
  app.post('/api/devices/:id/files', async (req, res) => {
    const { paths } = z
      .object({ paths: z.array(z.string().min(1).max(4000)).min(1).max(16) })
      .strict()
      .parse(req.body);
    res.json({ files: await required().sendFiles(z.string().uuid().parse(req.params.id), await validateFiles(paths)) });
  });
  app.post('/api/devices/:id/check', async (req, res) => {
    res.json({ device: await required().check(z.string().uuid().parse(req.params.id)) });
  });
  app.delete('/api/devices/:id', async (req, res) => {
    res.json(await required().remove(z.string().uuid().parse(req.params.id)));
  });
  app.put('/api/devices/slack-host', async (req, res) => {
    const { deviceId } = z.object({ deviceId: z.string().uuid().nullable() }).strict().parse(req.body);
    res.json(await required().setSlackHost(deviceId));
  });
  app.put('/api/devices/github-host', refuseExecutors, async (req, res) => {
    const { deviceId } = z
      .object({ deviceId: z.union([z.string().uuid(), z.literal('self')]).nullable() })
      .strict()
      .parse(req.body);
    res.json(await required().setGitHubHost(deviceId));
  });
}
