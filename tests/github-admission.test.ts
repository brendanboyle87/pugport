import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { ExternalEvents } from '../src/server/external-events.ts';
import { AdmissionRules, admit, type SenderClass, type AdmissionInput } from '../src/server/external-admission.ts';

const input: AdmissionInput = {
  source: 'github',
  scope: 'issue',
  senderId: 'synthetic',
  senderClass: 'owner',
  ownerRepository: true,
  mentioned: true,
};
test('GitHub mention defaults and quiet new issues/PRs', () => {
  const classes: SenderClass[] = ['owner', 'trusted', 'other', 'bot', 'system'];
  for (const scope of ['issue', 'pr', 'comment'] as const) {
    assert.deepEqual(
      classes.map((senderClass) => admit({ ...input, scope, senderClass }).level),
      ['L1', 'L2', 'L3', 'L4', 'L4'],
    );
    assert.deepEqual(
      classes.map((senderClass) => admit({ ...input, scope, senderClass, mentioned: false }).level),
      ['L4', 'L4', 'L4', 'L4', 'L4'],
    );
  }
});
test('foreign repos and non-default or successful CI never run', () => {
  assert.equal(admit({ ...input, ownerRepository: false }).verdict, 'ignore');
  assert.equal(admit({ ...input, ownerRepository: undefined }).verdict, 'ignore');
  assert.equal(admit({ ...input, scope: 'ci', senderClass: 'system', ownerCommit: true }).verdict, 'ignore');
  assert.equal(admit({ ...input, scope: 'ci', senderClass: 'system', defaultBranchFailure: true }).level, 'L4');
  assert.equal(
    admit({ ...input, scope: 'ci', senderClass: 'system', defaultBranchFailure: true, ownerCommit: true }).level,
    'L2',
  );
  assert.equal(admit({ ...input, rateLimited: true }).level, 'L4');
});
test('GitHub sender preferences cannot raise hard boundaries', () => {
  const overrides = {
    version: 1 as const,
    rules: [{ source: 'github' as const, scope: 'issue' as const, level: 'L1' as const }],
  };
  assert.equal(admit({ ...input, ownerRepository: false }, overrides).level, 'ignore');
  assert.equal(admit({ ...input, senderClass: 'bot' }, overrides).level, 'L4');
  assert.equal(admit({ ...input, mentioned: false }, overrides).level, 'L4');
});
test('GitHub edits update one persisted event without resetting receipt or decision', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new WorkspaceStore(db, { recoverInterrupted: false });
    const events = new ExternalEvents(store);
    const row = {
      ...input,
      ...admit(input),
      eventId: 'owner/repo:issue:123',
      senderName: 'Synthetic',
      channel: 'owner/repo',
      ts: '123',
      text: 'first',
    };
    const first = events.record(row);
    assert.equal(first.fresh, true);
    events.receipt(first.event.id, 'received', '收到');
    const duplicate = events.record({ ...row, text: 'edited' });
    assert.equal(duplicate.fresh, false);
    assert.equal(duplicate.event.text, 'edited');
    assert.equal(duplicate.event.receipt?.state, 'received');
    assert.equal(events.list().length, 1);
    assert.equal(store.list('external-event', 'github').length, 1);
    const rules = new AdmissionRules(store, 'github');
    rules.trust('comment', 'synthetic');
    assert.equal(rules.read().rules[0].source, 'github');
    assert.deepEqual(new AdmissionRules(store).read().rules, []);
    assert.throws(() => rules.trust('dm', 'synthetic'));
  } finally {
    db.close();
  }
});
