import { z } from 'zod';
import type { Gh } from './gh.ts';
import { repositorySchema } from './config.ts';

export const botLabels = {
  'tier:docs': { color: '0e8a16', description: 'Human-facing docs only' },
  'tier:code': { color: '1d76db', description: 'Code or UI text' },
  'tier:owner': { color: 'b60205', description: 'Touches maintainer-only files' },
  'needs-cla': { color: 'fbca04', description: 'Waiting for the CLA signature' },
} as const;
export const triageLabelAllowList = [
  'bug',
  'enhancement',
  'documentation',
  'question',
  'good first issue',
  'help wanted',
  'accessibility',
  'finding',
];
export const ownerOnlyLabels = [
  'duplicate',
  'invalid',
  'wontfix',
  'needs-owner-ruling',
  'owner-ruled',
  'claimed',
  'in-flight',
  'size:large',
  'size:waived',
  'ai-made',
];
export function allowedLabels(requested: string[], existing?: string[]): string[] {
  return [
    ...new Set(
      requested
        .map((v) => v.toLowerCase())
        .filter((v) => triageLabelAllowList.includes(v) && (!existing || existing.includes(v))),
    ),
  ];
}
export async function listLabels(gh: Gh, repository: string): Promise<string[]> {
  repositorySchema.parse(repository);
  const rows = await gh.json(z.array(z.object({ name: z.string() })), [
    'label',
    'list',
    '--repo',
    repository,
    '--json',
    'name',
    '--limit',
    '200',
  ]);
  return rows.map((row) => row.name);
}
export async function bootstrapLabels(
  gh: Gh,
  repository: string,
  create: (args: string[]) => Promise<boolean>,
  existing?: string[],
): Promise<{ created: string[]; present: string[]; complete: boolean }> {
  repositorySchema.parse(repository);
  const present = existing ?? (await listLabels(gh, repository)),
    created: string[] = [];
  for (const [name, label] of Object.entries(botLabels)) {
    if (present.includes(name)) continue;
    if (
      await create([
        'label',
        'create',
        name,
        '--repo',
        repository,
        '--color',
        label.color,
        '--description',
        label.description,
      ])
    )
      created.push(name);
  }
  return {
    present,
    created,
    complete: Object.keys(botLabels).every((name) => present.includes(name) || created.includes(name)),
  };
}
