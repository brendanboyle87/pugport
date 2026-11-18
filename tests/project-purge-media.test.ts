import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { MediaAnalysisManager } from '../src/server/media-analysis.ts';
import type { MediaDecoder } from '../src/server/media-decoder.ts';

test('media cleanup rejects active owners and deletes only the selected conversation checkpoint records', async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-purge-media-')));
  const data = join(root, 'data');
  mkdirSync(data);
  const decoder: MediaDecoder = {
    description: 'Synthetic cleanup fixture',
    image: async () => ({ time: 0, hash: '1234567890abcdef', texture: 0, colours: Array(12).fill(0.25) }),
    probe: async () => ({ duration: 1 }),
    frame: async (_path, time) => ({ time, hash: '1234567890abcdef', texture: 0, colours: Array(12).fill(0.25) }),
  };
  const manager = new MediaAnalysisManager(data, { decoder, staging: false });
  const checkpoint = join(data, 'media-analysis', 'checkpoint.sqlite');
  const db = new DatabaseSync(checkpoint);
  t.after(async () => {
    db.close();
    await manager.close();
    assert.equal(dirname(root).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
    assert.ok(basename(root).startsWith('pugport-purge-media-'));
    rmSync(root, { recursive: true, force: true });
  });
  const insert = db.prepare(
    'INSERT INTO jobs(id,options,status,phase,progress,created,updated,coverage,owner) VALUES(?,?,?,?,?,?,?,?,?)',
  );
  for (const [id, conversationId, status] of [
    ['ours', 'one', 'running'],
    ['other', 'two', 'completed'],
  ] as const) {
    insert.run(id, '{}', status, 'done', '', '', '', '[]', JSON.stringify({ conversationId }));
    db.prepare('INSERT INTO files(job,path,kind) VALUES(?,?,?)').run(id, `${id}.jpg`, 'image');
    db.prepare('INSERT INTO evidence(job,a,b,data) VALUES(?,?,?,?)').run(id, 1, 2, '{}');
    db.prepare('INSERT INTO pair_cache(job,a,b,key,data) VALUES(?,?,?,?,?)').run(id, 1, 2, 'key', '{}');
    db.prepare('INSERT INTO pair_checks(job,a,b,key,checked) VALUES(?,?,?,?,?)').run(id, 1, 2, 'key', 'now');
  }
  assert.throws(() => manager.purgeConversations(['one']), /尚未结束/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get()!.n, 2);
  db.prepare("UPDATE jobs SET status='completed' WHERE id='ours'").run();
  manager.purgeConversations(['one']);
  assert.equal(db.prepare("SELECT 1 FROM jobs WHERE id='ours'").get(), undefined);
  for (const table of ['files', 'evidence', 'pair_cache', 'pair_checks']) {
    assert.equal(db.prepare(`SELECT 1 FROM ${table} WHERE job='ours'`).get(), undefined);
    assert.ok(db.prepare(`SELECT 1 FROM ${table} WHERE job='other'`).get());
  }
  assert.ok(db.prepare("SELECT 1 FROM jobs WHERE id='other'").get());
  assert.equal(existsSync(checkpoint), true);
});
