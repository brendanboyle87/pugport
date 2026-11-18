import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { MOD_PACKAGE_MAX_BYTES, modManifestSchema, type ModManifest } from '../src/shared/mods-manifest.ts';
import { formatIssues, modWarnings } from '../src/server/mod-pack.ts';

export { formatIssues, modWarnings };

export function isMain(url: string): boolean {
  return Boolean(process.argv[1]) && url === pathToFileURL(process.argv[1]).href;
}

export type ModValidation = {
  ok: boolean;
  manifest?: ModManifest;
  bytes: number;
  sha256: string;
  issues: string[];
  warnings: string[];
};

export async function validateModFile(path: string): Promise<ModValidation> {
  const result: ModValidation = { ok: false, bytes: 0, sha256: '', issues: [], warnings: [] };
  try {
    const stat = await lstat(path);
    result.bytes = stat.size;
    if (!stat.isFile()) throw new Error('file must be a regular file');
    if (stat.size > MOD_PACKAGE_MAX_BYTES) throw new Error('file is larger than 1 MiB');
    const content = await readFile(path);
    result.bytes = content.length;
    if (content.length > MOD_PACKAGE_MAX_BYTES) throw new Error('file is larger than 1 MiB');
    result.sha256 = createHash('sha256').update(content).digest('hex');
    // The shared schema checks logo, cover and card limits as well as the
    // complete package budget, so validation and packing accept the same art.
    const parsed = modManifestSchema.safeParse(JSON.parse(content.toString('utf8')));
    if (!parsed.success) result.issues = formatIssues(parsed.error);
    else {
      result.ok = true;
      result.manifest = parsed.data;
      result.warnings = modWarnings(parsed.data);
    }
  } catch (error) {
    result.issues.push(error instanceof Error ? error.message : String(error));
  }
  return result;
}

if (isMain(import.meta.url)) {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3) {
    console.error('Usage: mods:validate <file>');
    process.exitCode = 1;
  } else {
    const result = await validateModFile(path);
    for (const warning of result.warnings) console.warn(warning);
    if (result.ok && result.manifest) {
      console.log(
        `OK ${result.manifest.id}@${result.manifest.version} (schema ${result.manifest.schemaVersion}, ${result.bytes} bytes, ${result.sha256})`,
      );
    } else {
      for (const issue of result.issues) console.error(issue);
      process.exitCode = 1;
    }
  }
}
