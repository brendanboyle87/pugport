import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryTelemetry, memoryTelemetry, track } from '../src/server/memory-telemetry.ts';

test('telemetry bounds records, tracks peak and threshold crossings, and exposes only numeric counters and names', () => {
  const logs: string[] = [];
  let rss = 100;
  const telemetry = new MemoryTelemetry(
    (line) => logs.push(line),
    () => ({ rss, heapUsed: 20, external: 30, arrayBuffers: 10, heapTotal: 50 }),
  );
  telemetry.begin('1', 'grok-history-sync');
  rss = 4 * 1024 ** 3;
  telemetry.sample();
  rss = 200;
  telemetry.end('1');
  assert.equal(telemetry.view().jobs[0]!.rssPeak, 4 * 1024 ** 3);
  assert.equal(logs.filter((line) => line.includes('threshold')).length, 2);
  for (let n = 0; n < 140; n++) {
    telemetry.begin(String(n), 'memory-retrieval');
    telemetry.end(String(n));
  }
  assert.equal(telemetry.view().jobs.length, 50);
  assert.equal(telemetry.view().samples.length, 120);
  for (const job of telemetry.view().jobs)
    assert.deepEqual(Object.keys(job).sort(), ['durationMs', 'name', 'rssAfter', 'rssBefore', 'rssPeak']);
  const end = track('memory-distillation-check');
  end();
  end();
  assert.equal(memoryTelemetry.view().jobs.at(-1)?.name, 'memory-distillation-check');
  assert.doesNotMatch(JSON.stringify(telemetry.view()), /prompt|content|path|secret/i);
  telemetry.close();
});
