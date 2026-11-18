import path from 'node:path';
import { splitCommandLine } from './command-line.ts';

export const readOnlyGitSubcommands = [
  'log',
  'show',
  'diff',
  'status',
  'blame',
  'grep',
  'rev-parse',
  'merge-base',
  'ls-files',
  'cat-file',
  'ls-tree',
  'describe',
  'shortlog',
  'branch',
  'tag',
  'remote',
  'stash',
  'worktree',
] as const;
export type GitCommandCheck =
  { ok: true; argv: string[]; subcommand: string; cwd: string } | { ok: false; reason: string };
const forbidden = [
  '--output',
  '--open-files-in-pager',
  '--ext-diff',
  '--textconv',
  '--filters',
  '--show-signature',
  '--help',
  '--no-index',
  '--stdin',
  '--batch',
  '--batch-check',
  '--batch-command',
  '--batch-all-objects',
  '--git-dir',
  '--work-tree',
  '--exec-path',
  '--contents',
  '--ignore-revs-file',
];
const globals = new Set([
  '--no-pager',
  '-P',
  '--no-optional-locks',
  '--literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
]);
const listOptions =
  '--contains --no-contains --merged --no-merged --points-at --sort --format --column --no-column --color -i --ignore-case -l --list'.split(
    ' ',
  );
const branchOptions = new Set([
  ...listOptions,
  ...'-a --all -r --remotes -v -vv --verbose --show-current --no-color --abbrev --no-abbrev'.split(' '),
]);
const tagOptions = new Set(listOptions);
const attachedValueOptions = '--sort --format --contains --no-contains --merged --no-merged --points-at'.split(' ');

export function checkReadOnlyGitCommand(command: string, projectPath: string): GitCommandCheck {
  const fail = (reason: string): GitCommandCheck => ({ ok: false, reason });
  if (!command || command.length > 4000) return fail('Command must contain 1 to 4000 characters.');
  if (/[\n\r\0]/.test(command)) return fail('Control characters are not allowed.');
  let quote = '';
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (/[;&|<>$\x60()]/.test(char)) return fail('Shell operators must be quoted.');
  }
  if (quote) return fail('Quotes must be balanced.');
  const [program, ...argv] = splitCommandLine(command);
  if (!(process.platform === 'win32' ? /^(git|git\.exe)$/i : /^(git|git\.exe)$/).test(program ?? ''))
    return fail('Command must start with git.');
  let index = 0;
  let cwd = path.resolve(projectPath);
  const fold = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const insideProject = (value: string) => {
    if (fold(value).split(/[\\/]/).includes('.git')) return false;
    const relative = path.relative(fold(path.resolve(projectPath)), fold(path.resolve(cwd, value)));
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  for (; index < argv.length && argv[index]!.startsWith('-'); index++) {
    const option = argv[index]!;
    if (globals.has(option)) continue;
    if (option !== '-C') return fail('This global git option is not allowed.');
    const dir = argv[++index];
    if (!dir || dir.split(/[\\/]/).includes('..') || !insideProject(dir))
      return fail('Git folder must stay inside the project.');
    cwd = path.resolve(cwd, dir);
  }
  const subcommand = argv[index++] ?? '';
  if (!(readOnlyGitSubcommands as readonly string[]).includes(subcommand))
    return fail('This git subcommand is not read-only.');
  const args = argv.slice(index);
  let afterSeparator = false;
  const forbiddenOptions = [
    ...forbidden,
    ...(subcommand === 'grep' ? ['--file'] : []),
    ...(subcommand === 'describe' ? ['--dirty', '--broken'] : []),
  ];
  for (const arg of args) {
    // A preceding option can consume -- as its value; never let it hide a dangerous option.
    // Paths shaped like forbidden options are conservatively refused too.
    if (arg === '--') {
      afterSeparator = true;
      continue;
    }
    if (subcommand === 'diff' && (afterSeparator || !arg.startsWith('-')) && !insideProject(arg))
      return fail('Git diff paths must stay inside the project and outside .git.');
    const name = arg.split('=')[0]!;
    if (arg.startsWith('--') && forbiddenOptions.some((option) => option.startsWith(name)))
      return fail('This git option can execute programs, write files or read external input.');
    if (
      /^-[^-]/.test(arg) &&
      (arg.includes('O') ||
        (subcommand === 'grep' && arg.includes('f')) ||
        (subcommand === 'blame' && arg.includes('S')))
    )
      return fail('This short git option is not allowed.');
  }
  if (subcommand === 'branch' || subcommand === 'tag') {
    const separator = args.indexOf('--');
    const options = separator < 0 ? args : args.slice(0, separator);
    const list = options.some((arg) => arg === '-l' || arg === '--list');
    const allowed = subcommand === 'branch' ? branchOptions : tagOptions;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '--' && i === separator) continue;
      if ((separator < 0 || i < separator) && attachedValueOptions.includes(arg))
        return fail('Branch and tag value options require --option=value.');
      if ((separator >= 0 && i > separator) || !arg.startsWith('-')) {
        if (!list) return fail('Branch and tag patterns require --list.');
      } else if (!allowed.has(arg.split('=')[0]!) && !(subcommand === 'tag' && /^-n\d*$/.test(arg)))
        return fail('Only listing branches and tags is allowed.');
    }
  }
  if (subcommand === 'remote') {
    const [action, ...rest] = args;
    const name = (value: string) => !!value && !value.startsWith('-');
    const valid =
      !args.length ||
      (args.length === 1 && ['-v', '--verbose'].includes(action!)) ||
      (action === 'get-url' &&
        rest.length >= 1 &&
        name(rest.at(-1)!) &&
        rest.slice(0, -1).every((arg) => ['--push', '--all'].includes(arg))) ||
      (action === 'show' && rest.length === 2 && rest[0] === '-n' && name(rest[1]!));
    if (!valid) return fail('Only local remote listings and URLs are allowed.');
  }
  if (subcommand === 'stash' && !['list', 'show'].includes(args[0] ?? ''))
    return fail('Only stash list and stash show are allowed.');
  if (
    subcommand === 'worktree' &&
    (args[0] !== 'list' || args.slice(1).some((arg) => !['--porcelain', '-v', '--verbose', '-z'].includes(arg)))
  )
    return fail('Only worktree list is allowed.');
  return { ok: true, argv, subcommand, cwd };
}
