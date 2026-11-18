import type { ProjectSshQuery, RemoteParamType } from '../shared/project-cli-context';

export type QueryDraft = Omit<ProjectSshQuery, 'argv' | 'push' | 'params'> & {
  arguments: string;
  parameters: string;
  repository: string;
  refs: string;
};

export const queryDraft = ({ argv, params, push, ...query }: ProjectSshQuery): QueryDraft => ({
  ...query,
  arguments: argv.join('\n'),
  parameters: Object.entries(params ?? {})
    .map(([name, type]) => `${name}=${type}`)
    .join('\n'),
  repository: push?.repository ?? '',
  refs: push?.refs.join('\n') ?? '',
});

export function queryFromDraft({
  arguments: args,
  parameters,
  repository,
  refs,
  ...query
}: QueryDraft): ProjectSshQuery {
  const entries = parameters
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^([a-z][a-z0-9_]{0,31})\s*=\s*(sha|branch|relpath|word|int)$/.exec(line);
      if (!match) throw new Error('参数格式有误，请每行填写名称=类型。');
      return [match[1]!, match[2]! as RemoteParamType] as const;
    });
  if (entries.length > 8 || new Set(entries.map(([name]) => name)).size !== entries.length)
    throw new Error('参数名不能重复，最多填 8 个。');
  const pushRefs = refs
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if ((repository.trim() || pushRefs.length) && (!repository.trim() || !pushRefs.length || !query.background))
    throw new Error('推送需要开启后台运行，并填写裸仓库和推送引用。');
  return {
    ...query,
    argv: args.split('\n'),
    ...(entries.length ? { params: Object.fromEntries(entries) } : {}),
    ...(repository.trim() ? { push: { repository: repository.trim(), refs: pushRefs } } : {}),
    ...(query.cwd ? { cwd: query.cwd.trim() || undefined } : {}),
  };
}
