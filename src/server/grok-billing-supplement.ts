import { fileIdentity } from './platform/file-identity.ts';
import './platform/under-test.ts';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { RuntimeTarget } from '../shared/types.ts';
import {
  defaultNativeAccountFingerprint,
  defaultNativeAccountHome,
  nativeAccountEnvironment,
  nativeAccountFingerprint,
} from './native-accounts.ts';

const MAX_BYTES = 1024 * 1024,
  MAX_AUTH_BYTES = 256 * 1024;
export type GrokBillingPeriod = { type: string; start: string; end: string };
export type GrokBillingSupplement = { usedPercent: number; implicitZero: boolean };
const comparable = (path: string) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export function grokBillingIdentity(target: RuntimeTarget, env = process.env): string | undefined {
  return target.accountId ? nativeAccountFingerprint(target) : defaultNativeAccountFingerprint(target, env);
}

/** The selected account's existing credential is used only in memory for the
 * fixed official billing host. No refresh, keychain, account scan or auth write.
 */
function readCredential(target: RuntimeTarget, expected: string, env: NodeJS.ProcessEnv): string | undefined {
  let fd: number | undefined;
  try {
    if (
      target.provider !== 'grok' ||
      target.environment !== 'native' ||
      target.gateway ||
      !expected ||
      (target.accountFingerprint && target.accountFingerprint !== expected) ||
      grokBillingIdentity(target, env) !== expected
    )
      return;
    if (
      !isAbsolute(target.command) ||
      (process.platform === 'win32'
        ? basename(target.command).toLowerCase() !== 'grok.exe'
        : basename(target.command) !== 'grok')
    )
      return;
    const effective = nativeAccountEnvironment(target, env);
    const home = target.accountId ? target.accountHome : defaultNativeAccountHome(target, env);
    if (!home) return;
    const args = target.args ?? [];
    if (
      target.accountId
        ? args.length !== 2 ||
          args[0] !== '--leader-socket' ||
          comparable(args[1]) !== comparable(join(home, 'leader.sock'))
        : args.length !== 0
    )
      return;
    if (
      Object.keys(effective).some(
        (key) => /^(?:GROK_AUTH_PROVIDER_COMMAND|GROK_API_KEY|XAI_API_KEY)$/i.test(key) && effective[key],
      )
    )
      return;
    const authOverride = Object.keys(effective).find((key) => key.toUpperCase() === 'GROK_AUTH_PATH');
    const path = resolve((authOverride && effective[authOverride]) || join(home, 'auth.json'));
    const directory = dirname(path),
      parent = lstatSync(directory),
      before = lstatSync(path, { bigint: true });
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      comparable(realpathSync(directory)) !== comparable(directory) ||
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.size > BigInt(MAX_AUTH_BYTES) ||
      comparable(realpathSync(path)) !== comparable(path)
    )
      return;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (
      !opened.isFile() ||
      fileIdentity(opened).ino !== fileIdentity(before).ino ||
      opened.nlink !== 1n ||
      opened.size > BigInt(MAX_AUTH_BYTES) ||
      (process.platform !== 'win32' && fileIdentity(opened).dev !== fileIdentity(before).dev)
    )
      return;
    const bytes = Buffer.alloc(MAX_AUTH_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = readSync(fd, bytes, size, bytes.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size > MAX_AUTH_BYTES || comparable(realpathSync(path)) !== comparable(path)) return;
    const auth = object(JSON.parse(bytes.subarray(0, size).toString('utf8'))),
      tokens = new Set<string>();
    for (const value of Object.values(auth)) {
      const entry = object(value);
      if (!['web_login', 'grok', 'oidc'].includes(String(entry.auth_mode))) continue;
      const stable = (id: unknown): id is string =>
        typeof id === 'string' && id.trim().length > 0 && id.length <= 512 && !/[\x00-\x1f\x7f]/.test(id);
      const identity = stable(entry.user_id)
        ? ['user_id', entry.user_id.trim()]
        : stable(entry.email)
          ? ['email', entry.email.trim().toLowerCase()]
          : undefined;
      if (
        !identity ||
        createHash('sha256')
          .update(JSON.stringify(['grok', ...identity]))
          .digest('hex') !== expected
      )
        return;
      if (
        typeof entry.key !== 'string' ||
        !entry.key ||
        entry.key.length > 64 * 1024 ||
        /[\x00-\x20\x7f]/.test(entry.key)
      )
        continue;
      // Never refresh here. An expired credential leaves the ACP result unknown.
      if (
        entry.expires_at != null &&
        (typeof entry.expires_at !== 'string' ||
          !Number.isFinite(Date.parse(entry.expires_at)) ||
          Date.parse(entry.expires_at) <= Date.now())
      )
        continue;
      tokens.add(entry.key);
    }
    return tokens.size === 1 && grokBillingIdentity(target, env) === expected
      ? tokens.values().next().value
      : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

type Field = { number: number; wire: number; value: bigint | number | Buffer };
function fields(bytes: Buffer): Field[] {
  let offset = 0;
  const result: Field[] = [];
  const varint = (): bigint => {
    let value = 0n;
    for (let index = 0; index < 10; index++) {
      if (offset >= bytes.length) throw new Error('truncated');
      const byte = bytes[offset++];
      if (index === 9 && byte > 1) throw new Error('overflow');
      value |= BigInt(byte & 127) << BigInt(index * 7);
      if (!(byte & 128)) return value;
    }
    throw new Error('varint');
  };
  while (offset < bytes.length) {
    const tag = varint(),
      number = Number(tag >> 3n),
      wire = Number(tag & 7n);
    if (number < 1 || number > 536870911) throw new Error('field');
    let value: Field['value'];
    if (wire === 0) value = varint();
    else if (wire === 2) {
      const length = varint();
      if (length > BigInt(bytes.length - offset)) throw new Error('length');
      value = bytes.subarray(offset, offset + Number(length));
      offset += Number(length);
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (offset + size > bytes.length) throw new Error('fixed');
      value = wire === 5 ? bytes.readFloatLE(offset) : bytes.subarray(offset, offset + size);
      offset += size;
    } else throw new Error('wire');
    result.push({ number, wire, value });
  }
  return result;
}
function one(list: Field[], number: number, wire: number): Field | undefined {
  const matches = list.filter((field) => field.number === number);
  if (matches.length > 1 || (matches[0] && matches[0].wire !== wire)) throw new Error('ambiguous');
  return matches[0];
}
function message(list: Field[], number: number): Field[] | undefined {
  const found = one(list, number, 2);
  return found ? fields(found.value as Buffer) : undefined;
}
function timestamp(list: Field[] | undefined): number | undefined {
  if (!list) return;
  const seconds = one(list, 1, 0)?.value,
    nanos = one(list, 2, 0)?.value ?? 0n;
  if (
    typeof seconds !== 'bigint' ||
    typeof nanos !== 'bigint' ||
    seconds < 0n ||
    seconds > 253402300799n ||
    nanos < 0n ||
    nanos > 999999999n
  )
    return;
  return Number(seconds) * 1000 + Math.floor(Number(nanos) / 1e6);
}

// Billing descriptor/zero-usage guards cross-checked against CodexBar (MIT),
// ad81eeded84ea2ed7e930c291c5168aa2f59070d, GrokWebBillingFetcher.swift and
// GrokZeroUsageTests.swift. Parse only known messages; unknown byte strings are
// opaque, never recursively searched for a plausible percentage or timestamp.
const nestedPaths = new Set([
  '1',
  '1.2',
  '1.3',
  '1.4',
  '1.5',
  '1.6',
  '1.7',
  '1.8',
  '1.12',
  '1.6.1',
  '1.6.2',
  '1.6.3',
  '1.8.2',
  '1.8.3',
  '1.6.3.2',
  '1.6.3.3',
]);
function validateKnownMessages(list: Field[], path = ''): boolean {
  let fixed32 = false;
  for (const field of list) {
    fixed32 ||= field.wire === 5;
    const key = path ? `${path}.${field.number}` : String(field.number);
    if (nestedPaths.has(key)) {
      if (field.wire !== 2) throw new Error('message');
      fixed32 = validateKnownMessages(fields(field.value as Buffer), key) || fixed32;
    }
  }
  return fixed32;
}

/** Complete successful unary gRPC-web response only; period-only JSON is never
 * zero evidence. Require the same active monthly/weekly period as this ACP read.
 */
export function parseGrokBillingSupplement(
  bytes: Uint8Array,
  expected: GrokBillingPeriod,
  now = Date.now(),
  headerStatus?: string | null,
): GrokBillingSupplement | undefined {
  try {
    if (bytes.length > MAX_BYTES || (headerStatus != null && headerStatus !== '0')) return;
    const data = Buffer.from(bytes),
      payloads: Buffer[] = [];
    let offset = 0,
      successfulStatus = headerStatus === '0',
      trailerSeen = false;
    while (offset < data.length) {
      if (trailerSeen) return;
      if (offset + 5 > data.length) return;
      const flag = data[offset],
        length = data.readUInt32BE(offset + 1);
      offset += 5;
      if (offset + length > data.length) return;
      const frame = data.subarray(offset, offset + length);
      offset += length;
      if (flag === 0) payloads.push(frame);
      else if (flag === 128) {
        if (payloads.length !== 1) return;
        const statuses = [...frame.toString('utf8').matchAll(/^grpc-status:\s*([^\r\n]+)\s*$/gim)];
        if (statuses.length !== 1 || statuses[0][1].trim() !== '0') return;
        successfulStatus = true;
        trailerSeen = true;
      } else return;
    }
    if (!successfulStatus || payloads.length !== 1) return;
    const root = fields(payloads[0]),
      hasFloat = validateKnownMessages(root),
      config = message(root, 1);
    if (!config) return;
    const period = message(config, 8);
    if (!period) return;
    const type = one(period, 1, 0)?.value,
      start = timestamp(message(period, 2)),
      end = timestamp(message(period, 3));
    const expectedType =
      expected.type === 'USAGE_PERIOD_TYPE_MONTHLY'
        ? 1n
        : expected.type === 'USAGE_PERIOD_TYPE_WEEKLY'
          ? 2n
          : undefined;
    if (
      expectedType === undefined ||
      type !== expectedType ||
      start === undefined ||
      end === undefined ||
      start !== Date.parse(expected.start) ||
      end !== Date.parse(expected.end) ||
      start > now ||
      end <= now ||
      end <= start
    )
      return;
    const percent = one(config, 1, 5);
    if (percent)
      return typeof percent.value === 'number' &&
        Number.isFinite(percent.value) &&
        percent.value >= 0 &&
        percent.value <= 100
        ? { usedPercent: percent.value, implicitZero: false }
        : undefined;
    return !hasFloat ? { usedPercent: 0, implicitZero: true } : undefined;
  } catch {
    return undefined;
  }
}

type Dependencies = { fetch: typeof fetch; env: NodeJS.ProcessEnv; now: () => number; timeoutMs: number };
const billingHost = 'https://grok.com/grok_api_v2.GrokBuildBilling/';

/** One fixed, read-only billing method on the official host with the selected account's
 * own credential. Returns the raw gRPC-web body, or undefined on any doubt.
 */
async function callBilling(
  target: RuntimeTarget,
  expectedFingerprint: string,
  method: 'GetGrokCreditsConfig' | 'GetAutoTopupRule',
  body: Uint8Array<ArrayBuffer>,
  deps: Dependencies,
): Promise<{ bytes: Buffer; status: string | null } | undefined> {
  const credential = readCredential(target, expectedFingerprint, deps.env);
  if (!credential) return;
  const response = await deps.fetch(billingHost + method, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(deps.timeoutMs),
    headers: {
      Authorization: `Bearer ${credential}`,
      'Content-Type': 'application/grpc-web+proto',
      'x-grpc-web': '1',
      'x-user-agent': 'connect-es/2.1.1',
      Origin: 'https://grok.com',
      Referer: 'https://grok.com/?_s=usage',
    },
    body,
  });
  if (
    !response.ok ||
    !response.body ||
    Number(response.headers.get('content-length')) > MAX_BYTES ||
    !/^application\/grpc-web(?:\+proto)?(?:;|$)/i.test(response.headers.get('content-type') ?? '')
  ) {
    await response.body?.cancel();
    return;
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_BYTES) {
        await reader.cancel();
        return;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (grokBillingIdentity(target, deps.env) !== expectedFingerprint) return;
  return { bytes: Buffer.concat(chunks), status: response.headers.get('grpc-status') };
}

export async function readGrokBillingSupplement(
  target: RuntimeTarget,
  expectedFingerprint: string,
  period: GrokBillingPeriod,
  overrides: Partial<Dependencies> = {},
): Promise<GrokBillingSupplement | undefined> {
  const deps = { fetch, env: process.env, now: Date.now, timeoutMs: 10_000, ...overrides };
  try {
    const result = await callBilling(
      target,
      expectedFingerprint,
      'GetGrokCreditsConfig',
      new Uint8Array([0, 0, 0, 0, 2, 8, 0]),
      deps,
    );
    return result && parseGrokBillingSupplement(result.bytes, period, deps.now(), result.status);
  } catch {
    return undefined;
  } // Never expose HTTP bodies, auth paths, token or identity.
}

/** The single data frame of a complete, successful unary gRPC-web response. */
function unaryPayload(bytes: Uint8Array, headerStatus: string | null): Buffer | undefined {
  if (bytes.length > MAX_BYTES || (headerStatus != null && headerStatus !== '0')) return;
  const data = Buffer.from(bytes),
    payloads: Buffer[] = [];
  let offset = 0,
    ok = headerStatus === '0';
  while (offset < data.length) {
    if (offset + 5 > data.length) return;
    const flag = data[offset],
      length = data.readUInt32BE(offset + 1);
    offset += 5;
    if (offset + length > data.length) return;
    const frame = data.subarray(offset, offset + length);
    offset += length;
    if (flag === 0) payloads.push(frame);
    else if (flag === 128) {
      const statuses = [...frame.toString('utf8').matchAll(/^grpc-status:\s*([^\r\n]+)\s*$/gim)];
      if (offset !== data.length || statuses.length !== 1 || statuses[0][1].trim() !== '0') return;
      ok = true;
    } else return;
  }
  return ok && payloads.length === 1 ? payloads[0] : undefined;
}

/** GetAutoTopupRule's reply: rule.enabled, where an unset rule (empty reply) means off. */
export function parseGrokAutoTopup(bytes: Uint8Array, headerStatus?: string | null): boolean | undefined {
  try {
    const payload = unaryPayload(bytes, headerStatus ?? null);
    if (!payload) return;
    const rule = message(fields(payload), 1);
    const enabled = rule ? one(rule, 1, 0)?.value : undefined;
    return enabled === undefined ? false : enabled === 1n ? true : enabled === 0n ? false : undefined;
  } catch {
    return undefined;
  }
}

/** Whether automatic top-up of extra usage credits is on — read only, never changed here. */
export async function readGrokAutoTopup(
  target: RuntimeTarget,
  expectedFingerprint: string,
  overrides: Partial<Dependencies> = {},
): Promise<boolean | undefined> {
  const deps = { fetch, env: process.env, now: Date.now, timeoutMs: 10_000, ...overrides };
  try {
    const result = await callBilling(target, expectedFingerprint, 'GetAutoTopupRule', new Uint8Array(5), deps);
    return result && parseGrokAutoTopup(result.bytes, result.status);
  } catch {
    return undefined;
  }
}
