const row = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

export function environmentFailure(output: string): boolean {
  return /\b(?:EACCES|EPERM)\b[^\n]{0,180}\b(?:listen|bind|connect|spawn|symlink|junction)\b|\b(?:listen|bind|connect|spawn|symlink|junction)\b[^\n]{0,180}\b(?:EACCES|EPERM)\b|operation not permitted|network (?:access )?(?:is )?(?:denied|blocked|disabled)|(?:denied|blocked) network|sandbox[^\n]{0,100}(?:refus|den(?:y|ied)|reject|not allowed)|(?:refused|denied|rejected)[^\n]{0,100}sandbox/i.test(
    output,
  );
}

// Preserve quoting and internal whitespace: changing either can change shell semantics.
export const normalizedCommand = (command: string) => command.replace(/\r\n/g, '\n').trim();

export function commandCheck(data: Record<string, unknown>) {
  const name = String(data.nativeTool ?? data.tool ?? '')
    .replace(/[_-]/g, '')
    .toLowerCase();
  if (
    data.kind !== 'commandExecution' &&
    data.kind !== 'execute' &&
    !['bash', 'shell', 'exec', 'execcommand', 'runcommand', 'shellcommand', 'runterminalcmd'].includes(name)
  )
    return undefined;
  const input = row(data.input);
  const command = String(input.command ?? input.cmd ?? data.command ?? '');
  const succeeded =
    data.status === 'completed' &&
    data.isError !== true &&
    !(typeof data.exitCode === 'number' && data.exitCode !== 0) &&
    (data.kind !== 'commandExecution' || data.exitCode === 0);
  const failed =
    ['failed', 'completed'].includes(String(data.status)) &&
    !succeeded &&
    (data.status === 'failed' || data.isError === true || (typeof data.exitCode === 'number' && data.exitCode !== 0));
  // Only actual tool output is evidence, never its input or the executor's final prose.
  const output = [data.output, data.result, data.failureDetail, data.failureMessage, data.error]
    .filter((value) => value !== undefined)
    .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
    .join('\n');
  return {
    command,
    key: normalizedCommand(command),
    succeeded,
    failed,
    limited: failed && environmentFailure(output),
    output,
    reason: output.slice(0, 2000),
  };
}
