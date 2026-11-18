import { DEFAULT_ALWAYS_ASK } from '../../shared/project-gates.ts';
import type { ProjectGates } from '../../shared/types.ts';
import { effectiveGates, glob } from '../github-gate.ts';

export type Tier = 'docs' | 'code' | 'owner';
export type TierInput = {
  paths: string[]; // Callers include previous_filename for renames; pathsFromFiles does both.
  pathsTruncated?: boolean;
  authorIsCollaborator: boolean;
  gates?: ProjectGates;
};
export type TierResult = { tier: Tier; external: boolean; label: `tier:${Tier}`; reasons: string[] };

// Any path with a segment starting with "." (.github, .claude, .cursor, .pi, .husky, .devcontainer, .npmrc, …) is
// tooling or agent configuration and is owner-only without being listed here.
export const OWNER_PATHS: readonly string[] = [
  '**/AGENTS.md',
  '**/AGENTS.override.md',
  '**/AGENT.md',
  '**/CLAUDE.md',
  '**/CLAUDE.local.md',
  '**/GEMINI.md',
  '**/SECURITY.md',
  '**/CODEOWNERS',
  'docs/AGENT-WORKFLOW.md',
  'docs/skills/**',
  'docs/decisions/**',
  'docs/ui-glossary.md',
  'docs/CLA.md',
  // Working rules AGENTS.md links to (tests/maintainer-tiers.test.ts keeps this in sync).
  'docs/live-ui-and-subagents.md',
  'docs/project-development-workflows.md',
  'docs/managed-child-workspaces.md',
  '**/package.json',
  '**/package-lock.json',
  '**/npm-shrinkwrap.json',
  'licenses/**',
  'LICENSE*',
  'NOTICE*',
  'THIRD_PARTY_NOTICES.md',
  'docs/DEPENDENCY-LICENSES.json',
  'docs/NPM-LICENSE-SUPPLEMENTS.json',
  'src/server/sandbox/**',
  '**/permission-*',
  '**/github*',
  '**/github*/**',
  '**/project-trust*',
  '**/local-api-guard*',
  '**/caller-*',
  '**/approval-rules*',
  '**/ssh-options*',
  'src/server/git-read-only*',
  'src/server/agent-bridge*',
  'src/shared/bridge-catalog*',
  'src/server/remote-job-scripts*',
  'src/server/judge-*',
  'src/server/node/peer-auth*',
  'src/electron/**',
  'src/server/maintainer/**',
  'launchers/**',
  'bin/**',
  'scripts/**',
  '**/*.ps1',
  '**/*.sh',
  '**/*.cmd',
  '**/*.bat',
];
export const DOCS_PATHS: readonly string[] = [
  'docs/**/*.md',
  'docs/**/*.png',
  'docs/**/*.jpg',
  'docs/**/*.jpeg',
  'docs/**/*.gif',
  'docs/**/*.webp',
  'docs/**/*.svg',
  'README.md',
  'README.*.md',
  'CONTRIBUTING.md',
];

/** Both names of every changed file from GitHub's PR file list; a list shorter than changed_files is truncated. */
export function pathsFromFiles(
  files: { filename: string; previous_filename?: string }[],
  changedFiles?: number,
): { paths: string[]; pathsTruncated: boolean } {
  const paths = files.flatMap((file) => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]);
  return { paths, pathsTruncated: changedFiles === undefined || files.length < changedFiles };
}

// A path GitHub would not normally produce (dot segments, empty segments, control or non-ASCII characters) could
// match differently on a case- or Unicode-folding filesystem, so it is owner-only.
const unusual = (path: string) =>
  /[^\x20-\x7e]/.test(path) || path.split('/').some((part) => part === '' || part === '.' || part === '..');

export function classifyPullRequest(input: TierInput): TierResult {
  const paths = input.paths.map((path) => path.replaceAll('\\', '/').replace(/^(?:\.\/|\/)+/, ''));
  const external = !input.authorIsCollaborator;
  const ownerPatterns = [
    ...OWNER_PATHS,
    ...DEFAULT_ALWAYS_ASK.paths,
    ...(effectiveGates(input.gates).alwaysAsk?.paths ?? []),
  ];
  const ownerOnly = (path: string) =>
    unusual(path) ||
    path.split('/').some((part) => part.startsWith('.')) ||
    ownerPatterns.some((p) => glob(p, path, true));
  let tier: Tier;
  let reasons: string[];
  if (input.pathsTruncated || !paths.length) {
    tier = 'owner';
    reasons = [input.pathsTruncated ? 'file list incomplete' : 'no files'];
  } else {
    const ownerPaths = paths.filter(ownerOnly);
    const codePaths = paths.filter((path) => !DOCS_PATHS.some((pattern) => glob(pattern, path, true)));
    if (ownerPaths.length) {
      tier = 'owner';
      reasons = ownerPaths.slice(0, 5).map((path) => `${JSON.stringify(path).slice(1, -1)} is owner-only`);
    } else if (!codePaths.length) {
      tier = 'docs';
      reasons = [`${paths.length} files, all human-facing docs`];
    } else {
      tier = 'code';
      reasons = codePaths.slice(0, 5).map((path) => `${path} is code`);
    }
  }
  if (external) reasons = [...reasons.slice(0, 4), 'author is not a collaborator'];
  return { tier, external, label: `tier:${tier}`, reasons };
}

export async function collaboratorPermission(
  run: (args: string[]) => Promise<string>,
  repo: string,
  login: string,
): Promise<{ trusted: boolean; permission: string }> {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
    repo.split('/').some((part) => part === '.' || part === '..') ||
    !/^[A-Za-z0-9-]+(\[bot\])?$/.test(login)
  )
    return { trusted: false, permission: 'invalid' };
  if (login.endsWith('[bot]')) return { trusted: false, permission: 'none' };
  try {
    const permission = (
      await run(['api', `repos/${repo}/collaborators/${login}/permission`, '--jq', '.permission'])
    ).trim();
    return { trusted: ['admin', 'maintain', 'write'].includes(permission), permission };
  } catch {
    return { trusted: false, permission: 'none' };
  }
}
