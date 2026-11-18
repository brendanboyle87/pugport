import '../src/server/platform/under-test.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { apiEnvironment, apiTarget } from '../src/server/api-providers.ts';
import { createPiAdapter } from '../src/server/adapters/pi.ts';
import { route } from '../src/server/routing.ts';
import { testDirectory } from '../src/server/platform/under-test.ts';
import { apiPreset } from '../src/shared/api-providers.ts';
import type { ExecuteContext, RunEvent, RunInput, Settings } from '../src/shared/types.ts';
import { findNode, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

test(
  'DeepSeek API card uses the real Pi catalog and request path against loopback only',
  { timeout: 180_000 },
  async (t) => {
    const home = join(testDirectory(), 'deepseek');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'fixture.txt'), 'synthetic tool result', 'utf8');
    const bodies: any[] = [];
    const server = createServer(async (req, res) => {
      assert.equal(req.url, '/chat/completions');
      assert.equal(req.headers.authorization, 'Bearer SYNTHETIC_KEY');
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      bodies.push(body);
      const assistants = body.messages.filter((message: any) => message.role === 'assistant');
      const thinking = body.thinking?.type === 'enabled';
      // A thinking request with tools must retain reasoning from ALL earlier assistant replies.
      if (thinking && assistants.some((message: any) => !message.reasoning_content)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Missing earlier reasoning_content' } }));
        return;
      }
      const useTool = !assistants.length;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta: unknown, finish_reason: string | null = null, usage?: unknown) =>
        res.write(
          `data: ${JSON.stringify({
            id: 'synthetic-completion',
            object: 'chat.completion.chunk',
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta, finish_reason }],
            ...(usage ? { usage } : {}),
          })}\n\n`,
        );
      chunk({ role: 'assistant', ...(thinking ? { reasoning_content: `reasoning-${assistants.length}` } : {}) });
      chunk(
        useTool
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: 'synthetic-call',
                  type: 'function',
                  function: { name: 'read', arguments: '{"path":"fixture.txt"}' },
                },
              ],
            }
          : { content: 'Synthetic answer.' },
      );
      chunk({}, useTool ? 'tool_calls' : 'stop', {
        prompt_tokens: 1000,
        completion_tokens: 100,
        total_tokens: 1100,
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: 1000,
      });
      res.end('data: [DONE]\n\n');
    });
    await listenForFetch(server);
    t.after(() => new Promise<void>((done) => server.close(() => done())));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const preset = apiPreset('deepseek')!;
    const target = apiTarget(process.cwd(), home, preset, 'api-deepseek-test', 'Synthetic DeepSeek');
    let launches = 0;
    let storedKey = 'SYNTHETIC_KEY';
    const adapter = createPiAdapter({
      key: () => storedKey,
      environment: (target) => {
        const env = apiEnvironment(target, preset, 'SYNTHETIC_KEY', {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TEMP: home,
          TMP: home,
        });
        // Keep PugPort's actual overrides; replace only transport in this synthetic account.
        const file = join(target.agentDir!, 'models.json');
        const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { providers: { deepseek: {} } };
        mkdirSync(target.agentDir!, { recursive: true });
        config.providers.deepseek.baseUrl = baseUrl;
        writeFileSync(file, JSON.stringify(config), 'utf8');
        return { ...env, PUGPORT_UNDER_TEST: '1', PUGPORT_TEST_DIRECTORY: home };
      },
      spawn: async (target, args, options) => {
        launches++;
        return spawn(process.execPath, [...target.args!, ...args, '--no-context-files'], {
          cwd: home,
          env: options?.env,
          windowsHide: true,
          stdio: 'pipe',
        });
      },
      terminate: async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const closed = once(child, 'close');
        child.kill();
        await closed;
      },
    });
    const snapshot = await adapter.discover(target);
    snapshot.accounting = { mode: 'usage', source: 'synthetic API account' };
    assert.equal(snapshot.status, 'ready', snapshot.note ?? '');
    assert.equal(bodies.length, 0, 'catalog discovery never calls a model');
    // The listing is read from the card's settings, key and models.json: while those stand, observing the card
    // again (every 15 s during a task) starts no process and reports the same models.
    assert.equal(launches, 1);
    const again = await adapter.discover(target);
    assert.equal(launches, 1, 'an unchanged card is not listed by a new process');
    assert.deepEqual(again.models, snapshot.models);
    assert.deepEqual([again.status, again.version, again.installed], ['ready', snapshot.version, true]);
    // A change to any of them is read afresh.
    const overrides = join(target.agentDir!, 'models.json');
    writeFileSync(overrides, readFileSync(overrides, 'utf8') + '\n', 'utf8');
    await adapter.discover(target);
    assert.equal(launches, 2, 'changed model overrides are read again');
    storedKey = 'SYNTHETIC_KEY_REPLACED';
    assert.deepEqual((await adapter.discover(target)).models, snapshot.models);
    assert.equal(launches, 3, 'a replaced key is read again');
    assert.equal((await adapter.discover({ ...target, label: 'Renamed' })).label, 'Renamed');
    assert.equal(launches, 4, 'changed card settings are read again');
    assert.equal(bodies.length, 0);
    assert.deepEqual(
      snapshot.models.map(({ id, label, efforts, catalogDefault, price }) => ({
        id,
        label,
        efforts,
        catalogDefault,
        price,
      })),
      [
        {
          id: 'deepseek/deepseek-flash',
          label: 'DeepSeek V4.1 Flash',
          efforts: ['off', 'low', 'high', 'max'],
          catalogDefault: undefined,
          price: { input: 0.3, output: 1.2 },
        },
        {
          id: 'deepseek/deepseek-v4-pro',
          label: 'DeepSeek V4 Pro',
          efforts: ['off', 'low', 'high', 'max'],
          catalogDefault: true,
          price: { input: 1.32, output: 3.96 },
        },
      ],
    );
    const settings: Settings = {
      refreshSeconds: 60,
      reservePercent: 10,
      maxQuotaAgeSeconds: 180,
      preferCli: true,
      designProvider: 'claude',
      architectureProvider: 'codex',
      routineProvider: 'codex',
      unknownQuotaPolicy: 'manual-only',
      defaultProjectPath: home,
      maxConcurrentRuns: 2,
    };
    assert.equal(
      route(
        { prompt: 'Explain the fixture.', projectPath: home, runtimeId: target.id, kind: 'general' },
        [snapshot],
        settings,
      ).model,
      'deepseek/deepseek-v4-pro',
    );
    const picker = uiHarness(await uiBundle('src/ui/Workspace.tsx'));
    let pickedModel = '';
    const tree = picker.render('WorkspaceExecutionFields', {
      state: { targets: [target], runtimes: [snapshot] },
      policy: 'api-only',
      selection: target.id,
      model: '',
      onSelection() {},
      onModel: (value: string) => {
        pickedModel = value;
      },
    });
    const modelPicker = findNode(tree, (node) => node.props.ariaLabel === '任务模型')!;
    assert.match(text(modelPicker), /DeepSeek V4.1 Flash.*DeepSeek V4 Pro/);
    for (const model of snapshot.models) {
      modelPicker.props.onChange(model.id);
      for (const effort of model.efforts) {
        const start: number = bodies.length;
        const events: RunEvent[] = [];
        const input: RunInput = {
          prompt: 'Read fixture.txt.',
          projectPath: home,
          kind: 'general',
          permissionMode: 'read-only',
          runtimeId: target.id,
          model: pickedModel,
          effort,
        };
        const context: ExecuteContext = {
          target,
          dataDir: home,
          input,
          route: route(input, [snapshot], settings),
          signal: AbortSignal.timeout(30_000),
          emit: (event: RunEvent) => events.push(event),
          approve: async () => false,
        };
        assert.equal(context.route.model, model.id);
        assert.equal(context.route.effort, effort);
        const result = await adapter.execute(context);
        assert.equal(bodies.length - start, 2);
        const requests = bodies.slice(start);
        for (const request of requests) {
          assert.equal(request.model, model.id.slice('deepseek/'.length));
          assert.deepEqual(request.thinking, { type: effort === 'off' ? 'disabled' : 'enabled' });
          assert.equal(request.reasoning_effort, effort === 'off' ? undefined : effort);
          assert.ok(request.tools.some((tool: any) => tool.function.name === 'read'));
        }
        assert.ok(
          requests[1].messages.some(
            (message: any) =>
              message.role === 'tool' && JSON.stringify(message.content).includes('synthetic tool result'),
          ),
        );
        if (effort !== 'off') {
          assert.equal(
            requests[1].messages.find((message: any) => message.role === 'assistant').reasoning_content,
            'reasoning-0',
          );
        }
        const costs = events.filter((event) => event.type === 'usage').map((event) => event.data?.costUsd);
        assert.equal(costs.length, 2);
        for (const cost of costs) {
          assert.equal(typeof cost, 'number');
          assert.ok(Math.abs(Number(cost) - (model.price!.input / 1000 + model.price!.output / 10_000)) < 1e-12);
        }
        if (effort === 'high') {
          assert.ok(result.nativeSessionId);
          await adapter.execute({
            ...context,
            nativeSessionId: result.nativeSessionId,
            input: { ...context.input, prompt: 'Follow up.' },
          });
          const replay = bodies.at(-1).messages.filter((message: any) => message.role === 'assistant');
          assert.deepEqual(
            replay.map((message: any) => message.reasoning_content),
            ['reasoning-0', 'reasoning-1'],
          );
        }
        t.diagnostic(
          JSON.stringify({
            model: requests[0].model,
            thinking: requests[0].thinking,
            reasoning_effort: requests[0].reasoning_effort,
          }),
        );
      }
    }
    picker.unmount();
  },
);

test('DeepSeek card converts Pi USD cost to labelled yuan and switches back to USD', async () => {
  const code = await uiBundle('src/ui/Executors.tsx');
  const harness = uiHarness(`${code}\nmodule.exports.ApiRow = ApiRow;`);
  const preset = apiPreset('deepseek')!;
  const props = {
    provider: {
      targetId: 'api-deepseek-test',
      preset: preset.id,
      label: 'DeepSeek',
      enabled: true,
      console: preset.console,
      currency: preset.currency,
    },
    target: { id: 'api-deepseek-test', provider: 'pi', enabled: true },
    usage: { runs: 1, totalTokens: 1000, estimatedCostUsd: 1.5 },
    api: async () => {
      throw new Error('This render must not make a request');
    },
    reload: async () => {},
    notify() {},
  };
  let tree = harness.render('ApiRow', props);
  assert.match(text(tree.props.metric), /¥10.65/);
  assert.ok(findNode(tree.props.metric, (node) => node.props.title?.includes('1 美元≈7.1 元')));
  assert.doesNotMatch(text(tree.props.metric), /¥1.50/);
  findNode(tree, (node) => node.props.className === 'currency-toggle')!.props.onClick({ stopPropagation() {} });
  tree = harness.render('ApiRow', props);
  assert.match(text(tree.props.metric), /\$1.50/);
  assert.doesNotMatch(text(tree.props.metric), /¥10.65/);
  harness.unmount();
});
