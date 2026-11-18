import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { memoryStorageRoot } from '../src/server/local-memory.ts';

test("a test that forgets to choose a memory folder writes to a temporary one, never the user's app data", () => {
  const previous = process.env.COMBORUNNER_MEMORY_DIR;
  delete process.env.COMBORUNNER_MEMORY_DIR;
  try {
    const root = memoryStorageRoot('C:/somewhere/data');
    const fromTemporary = relative(realpathSync.native(tmpdir()), root);
    assert.ok(
      fromTemporary && !isAbsolute(fromTemporary) && fromTemporary !== '..' && !fromTemporary.startsWith(`..${sep}`),
      root,
    );
  } finally {
    if (previous !== undefined) process.env.COMBORUNNER_MEMORY_DIR = previous;
  }
});
