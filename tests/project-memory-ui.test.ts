import assert from 'node:assert/strict';
import test from 'node:test';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const code = await uiBundle('src/ui/Workspace.tsx');

for (const trusted of [false, true])
  test(
    trusted
      ? 'removing project trust uses HTTP without a native dialog'
      : 'cancelled trust still saves rules, memory and local settings',
    async () => {
      const writes: { path: string; body: any }[] = [];
      let confirms = 0;
      const h = uiHarness(code, {
        window: {
          comboRunnerDesktop: {
            pickDirectory() {},
            async changePermission() {
              confirms++;
              return false;
            },
          },
        },
      });
      const props = {
        project: { id: 'fixture', path: 'C:/synthetic/project', name: 'Fixture', trusted, rules: [] },
        api: async (path: string, body: any, method: string) => {
          if (method === 'PATCH') writes.push({ path, body });
          return path.endsWith('/local-memory')
            ? { exportEnabled: body?.exportEnabled ?? true, cliEnabled: false, files: [], warnings: [] }
            : { content: body?.content ?? 'Old memory', revision: 1 };
        },
        notify() {},
      };
      h.render('MemoryEditor', props);
      await nextTurn();
      let tree = h.render('MemoryEditor', props);
      findNode(tree, (node) => node.type?.name === 'ProjectTrustControl')!.props.onChange(!trusted);
      findNode(tree, (node) => node.props.id === 'project-rules-fixture')!.props.onChange({
        target: { value: 'New rule' },
      });
      findNode(tree, (node) => node.props.id === 'project-memory-fixture')!.props.onChange({
        target: { value: 'New memory' },
      });
      findNode(tree, (node) => node.type?.name === 'LocalMemoryControls')!.props.onExport(false);
      tree = h.render('MemoryEditor', props);
      findNode(tree, (node) => node.type === 'button' && node.props.className === 'button primary')!.props.onClick();
      await nextTurn();
      tree = h.render('MemoryEditor', props);
      assert.equal(confirms, trusted ? 0 : 1);
      assert.equal(findNode(tree, (node) => node.type?.name === 'ProjectTrustControl')!.props.trusted, false);
      assert.deepEqual(JSON.parse(JSON.stringify(writes)), [
        ...(trusted ? [{ path: '/api/projects/fixture', body: { trusted: false } }] : []),
        { path: '/api/projects/fixture/rules', body: { rules: ['New rule'] } },
        { path: '/api/projects/fixture/memory', body: { content: 'New memory', revision: 1 } },
        { path: '/api/projects/fixture/local-memory', body: { exportEnabled: false, cliEnabled: false } },
      ]);
      h.unmount();
    },
  );

for (const connected of [false, true])
  test(`memory keeps one Save and gates GitHub rules on connection (${connected})`, async () => {
    const writes: { path: string; body: any }[] = [];
    const h = uiHarness(code);
    const props = {
      project: { id: 'fixture', name: 'Fixture', rules: [], trusted: false },
      api: async (path: string, body: any, method: string) => {
        if (method === 'PATCH') writes.push({ path, body });
        if (path === '/api/github') return { enabled: connected, state: connected ? 'connected' : 'off' };
        if (path === '/api/extensions') return { items: [] };
        if (path.endsWith('/routing-profile')) return { id: 'fixture', routingProfileId: body.profileId };
        if (path.endsWith('/local-memory')) return { exportEnabled: true, cliEnabled: false, files: [], warnings: [] };
        return { content: body?.content ?? '', revision: 1 };
      },
      notify() {},
    };
    const render = () => h.render('MemoryEditor', props);
    render();
    await nextTurn();
    const tree = render();
    assert.equal(!!findNode(tree, (n) => n.props.id === 'project-gates-fixture'), connected);
    assert.equal(
      findNode(tree, (n) => n.props.className === 'memory-meta'),
      undefined,
    );
    const advanced = findNode(tree, (n) => n.type === 'details' && n.props.className === 'memory-advanced')!;
    assert.equal(advanced.props.open, undefined);
    for (const name of ['ProjectMcpControl', 'ProjectTrustControl', 'ProjectRoutingDefault'])
      assert.ok(findNode(advanced, (n) => n.type?.name === name));
    assert.doesNotMatch(text(tree), /保存项目默认路由|版本/);
    findNode(tree, (n) => n.type?.name === 'ProjectRoutingDefault')!.props.onChange('synthetic-profile');
    findNode(tree, (n) => n.props.id === 'project-memory-fixture')!.props.onChange({
      target: { value: 'Synthetic note' },
    });
    findNode(render(), (n) => n.type === 'button' && n.props.className === 'button primary')!.props.onClick();
    await nextTurn();
    assert.deepEqual(JSON.parse(JSON.stringify(writes)), [
      { path: '/api/projects/fixture/routing-profile', body: { profileId: 'synthetic-profile' } },
      { path: '/api/projects/fixture/memory', body: { content: 'Synthetic note', revision: 1 } },
    ]);
    h.unmount();
  });
