import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { electronModule } from './helpers/electron-harness.ts';
import { recyclablePaths } from '../src/server/recycle-bin.ts';

test('repo and worktree projects recycle and organize ordinary files without exempting private data or outside paths', async (t) => {
  const app = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-bridge-project-')));
  t.after(() => rmSync(app, { recursive: true, force: true }));
  const effects: string[][] = [];
  let projectPath = app;
  const abort = new AbortController();
  const controller = Object.assign(new EventEmitter(), {
    dataDir: join(app, 'private-data'),
    agentBridgeCaller: () => ({
      run: { id: 'run', projectPath },
      target: {},
      delegate: false,
      recycle: true,
      child: false,
      write: true,
      signal: abort.signal,
    }),
    retainMutation: () => () => {},
    returnExecution: () => async () => {},
    recordRunEvent: () => {},
  });
  const api = await electronModule(
    'src/server/agent-bridge.ts',
    {},
    {
      fixtureEffects: effects,
      fixtureRecyclablePaths: recyclablePaths,
      process: { ...process, env: { COMBORUNNER_FILE_MOVES_DIR: join(app, 'journals') } },
    },
    {
      'node:os': `export const homedir=()=>${JSON.stringify(join(app, 'home'))}; export const tmpdir=()=>${JSON.stringify(tmpdir())};`,
      './recycle-bin.ts': `export const maxRecyclePaths=200;
      export const recyclablePaths=(...args)=>globalThis.fixtureRecyclablePaths(...args);
      export async function moveToRecycleBin(project,paths) { globalThis.fixtureEffects.push(paths); return {moved:paths,failed:[]}; }`,
      './workspace.ts': `export const scopeWarning=()=>''; export const workspaceDeliveryComplete=()=>true;`,
      './image-search.ts': `export const findSimilarImages=()=>{};`,
      './media-analysis.ts': `export class MediaAnalysisManager {}`,
      './extensions.ts': `export const extensions={bridgeTools:()=>[],handles:()=>false};`,
    },
  );
  const bridge = new api.AgentBridge(
    { takeNotices: () => [], store: { get: () => undefined, projects: () => [] } },
    controller,
    app,
  );
  const call = async (name: string, args: Record<string, unknown>) =>
    (
      await bridge.handle('Bearer fixture', {
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      })
    ).body.result;
  try {
    for (const project of [app, join(app, '.claude', 'worktrees', 'x')]) {
      projectPath = project;
      controller.dataDir = join(project, 'private-data');
      mkdirSync(project, { recursive: true });
      const ordinary = join(project, 'ordinary.txt'),
        source = join(project, 'source.txt'),
        target = join(project, 'renamed.txt');
      writeFileSync(ordinary, 'synthetic');
      writeFileSync(source, 'synthetic');
      const protectedPaths = ['.data/accounts', '.git', 'private-data/secrets', 'containing/.git'].map((name) =>
        join(project, name),
      );
      for (const folder of protectedPaths) mkdirSync(folder, { recursive: true });
      protectedPaths.push(join(project, 'containing'));
      const recycle = await call('recycle_files', { paths: [ordinary, ...protectedPaths] });
      assert.equal(recycle.structuredContent.succeeded, 1);
      assert.equal(recycle.structuredContent.failed, protectedPaths.length);
      assert.deepEqual(Array.from(effects.at(-1)!), [ordinary]);
      const organize = await call('organize_files', {
        moves: [{ from: source, to: target }],
        recycle: [ordinary, ...protectedPaths],
      });
      assert.equal(organize.structuredContent.succeeded, 2);
      assert.equal(organize.structuredContent.failed, protectedPaths.length);
      assert.equal(existsSync(target), true);
      assert.equal(existsSync(source), false);
      assert.deepEqual(Array.from(effects.at(-1)!), [ordinary]);
      const undone = await call('undo_organize', { id: organize.structuredContent.operationIds[0] });
      assert.match(undone.content[0].text, /移回 1 项/);
      assert.equal(existsSync(source), true);
      if (project !== app) {
        const outside = await call('recycle_files', { paths: [join(app, 'ordinary.txt')] });
        assert.equal(outside.structuredContent.succeeded, 0);
        assert.match(outside.content[0].text, /不在当前项目目录内/);
        const outsideMove = await call('organize_files', {
          moves: [{ from: join(app, 'ordinary.txt'), to: join(project, 'leak.txt') }],
        });
        assert.equal(outsideMove.structuredContent.succeeded, 0);
        assert.match(outsideMove.content[0].text, /应用数据/);
      }
    }
  } finally {
    abort.abort();
    await bridge.close();
    controller.removeAllListeners();
  }
});

test('the direct recycle tool shares protected physical-root guards while ordinary project files still work', async () => {
  // Normalize Windows short TEMP paths while preserving the junction inputs used by the guard test.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'comborunner-bridge-recycle-')));
  const app = join(root, 'container', 'app');
  mkdirSync(join(app, '..private'), { recursive: true });
  mkdirSync(join(app, '.data'), { recursive: true });
  writeFileSync(join(app, '..private', 'sentinel.txt'), 'safe');
  writeFileSync(join(root, 'user.txt'), 'user');
  const alias = join(root, 'alias');
  symlinkSync(app, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const effects: string[][] = [];
  const runAbort = new AbortController();
  const controller = Object.assign(new EventEmitter(), {
    dataDir: join(root, 'private-data'),
    agentBridgeCaller: () => ({
      run: { id: 'run', projectPath: root },
      target: {},
      delegate: false,
      recycle: true,
      child: false,
      write: true,
      signal: runAbort.signal,
    }),
    retainMutation: () => () => {},
    returnExecution: () => async () => {},
    recordRunEvent: () => {},
  });
  let bridge: any;
  try {
    const loaded = await electronModule(
      'src/server/agent-bridge.ts',
      {},
      {
        fixtureEffects: effects,
        fixtureRecyclablePaths: recyclablePaths,
        process: { ...process, env: { COMBORUNNER_FILE_MOVES_DIR: join(root, 'journals') } },
      },
      {
        'node:os': `export const homedir=()=>${JSON.stringify(join(root, 'home'))}; export const tmpdir=()=>${JSON.stringify(tmpdir())};`,
        './recycle-bin.ts': `export const maxRecyclePaths = 200;
        export const recyclablePaths = (...args) => globalThis.fixtureRecyclablePaths(...args);
        export async function moveToRecycleBin(project, paths) { globalThis.fixtureEffects.push(paths); return {moved:paths,failed:[]}; }`,
        './workspace.ts': `export const scopeWarning = () => ''; export const workspaceDeliveryComplete = () => true;`,
        './image-search.ts': `export const findSimilarImages = () => { throw new Error('unused'); };`,
        './media-analysis.ts': `export class MediaAnalysisManager { constructor() { throw new Error('Media analysis is outside this recycle fixture.'); } }`,
        './extensions.ts': `export const extensions = { bridgeTools: () => [], handles: () => false };`,
      },
    );
    bridge = new loaded.AgentBridge(
      { takeNotices: () => [], store: { get: () => undefined, projects: () => [] } },
      controller,
      app,
    );
    const response = await bridge.handle('Bearer fixture', {
      id: 1,
      method: 'tools/call',
      params: {
        name: 'recycle_files',
        arguments: {
          paths: [join(alias, '..private', 'sentinel.txt'), join(root, 'container'), join(root, 'user.txt')],
        },
      },
    });
    assert.equal(effects.length, 1);
    assert.deepEqual(Array.from(effects[0]!), [join(root, 'user.txt')]);
    assert.match(response.body.result.content[0].text, /未移动[\s\S]*应用数据/);
  } finally {
    runAbort.abort();
    await bridge?.close();
    controller.removeAllListeners();
    assert.equal(dirname(root).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
    assert.ok(basename(root).startsWith('comborunner-bridge-recycle-'));
    rmSync(root, { recursive: true, force: true });
  }
});
