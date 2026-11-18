import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type CrashRecord = { kind: 'renderer' | 'backend'; reason: string; at: string };
const crashReasons = new Set(['crashed', 'abnormal-exit', 'oom', 'launch-failed']);

export function shouldRecordCrash(kind: CrashRecord['kind'], reason: string, quitting: boolean) {
  return (
    !quitting && (crashReasons.has(reason) || (kind === 'renderer' && ['killed', 'integrity-failure'].includes(reason)))
  );
}

/** Only explicit main-renderer/backend events create records; dumps and exit markers are never inspected. */
export function createCrashRecord(dataDir: string) {
  const directory = join(dataDir, 'logs');
  const file = join(directory, 'last-crash.json');
  const clear = (expected?: CrashRecord) => {
    try {
      if (expected) {
        const current = JSON.parse(readFileSync(file, 'utf8')) as CrashRecord;
        if (current.kind !== expected.kind || current.reason !== expected.reason || current.at !== expected.at) return;
      }
      rmSync(file, { force: true });
    } catch {
      /* Crash reporting must not prevent startup or shutdown. */
    }
  };
  return {
    record(kind: CrashRecord['kind'], reason: string, quitting = false) {
      if (!shouldRecordCrash(kind, reason, quitting)) return;
      try {
        mkdirSync(directory, { recursive: true });
        const record: CrashRecord = { kind, reason, at: new Date().toISOString() };
        writeFileSync(`${file}.tmp`, JSON.stringify(record));
        renameSync(`${file}.tmp`, file);
      } catch {
        /* A crash record is best effort and never interrupts recovery. */
      }
    },
    take(): CrashRecord | undefined {
      try {
        const value = JSON.parse(readFileSync(file, 'utf8')) as CrashRecord;
        if (
          (value.kind === 'renderer' || value.kind === 'backend') &&
          shouldRecordCrash(value.kind, value.reason, false) &&
          typeof value.at === 'string' &&
          Number.isFinite(Date.parse(value.at))
        ) {
          return { kind: value.kind, reason: value.reason, at: value.at };
        }
      } catch {
        /* No prior event, or an incomplete record. */
      }
    },
    clear,
  };
}
