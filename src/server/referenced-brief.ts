import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';

// "按" only right before the path, so 按钮 (button) and similar words never make a target file a brief.
const cue =
  /任务书|需求文档|说明文档|规格|按照|依照|根据|照着|按\s*[^\s，。]+\.(?:md|txt)\b|\b(?:brief|spec|specification|according to|as described in)\b/iu;
const briefName = /brief|spec|task|plan|任务|需求/iu;
// shortcut: only the first 20k bytes per file count; revisit if brief summaries need more context.
const limit = 20_000;

const inside = (root: string, file: string) => {
  const path = relative(root, file);
  return !!path && !path.startsWith('..') && !isAbsolute(path);
};

/**
 * Project-local brief/spec files (.md/.txt) the request points to, for routing difficulty only:
 * their text, null when one is referenced but cannot be read, undefined when none is referenced.
 */
export function referencedBrief(text: string, projectPath: string): string | null | undefined {
  const paths = [...new Set(text.match(/[^\s"'`<>|*?，。、；：（）()]+\.(?:md|txt)\b/giu) ?? [])].filter(
    (path) => cue.test(text) || briefName.test(basename(path)),
  );
  // Named as the brief to follow, not as a file to create: missing or kept elsewhere, it is still unsized work.
  const namedAsBrief = (path: string) => {
    const sentence = text.split(/[。！？!?；;\n]/u).find((part) => part.includes(path)) ?? text;
    return (
      briefName.test(basename(path)) &&
      cue.test(sentence) &&
      !/新建|创建|写一份|\b(?:create|write|add)\b/iu.test(sentence)
    );
  };
  let result: string | undefined;
  for (const path of paths) {
    if (path.includes('://')) continue;
    const file = resolve(projectPath, path);
    // A brief kept outside the project is never read.
    if (!inside(projectPath, file)) {
      if (namedAsBrief(path)) return null;
      continue;
    }
    try {
      if (!statSync(file).isFile()) continue;
      const real = realpathSync(file);
      if (!inside(realpathSync(projectPath), real)) continue;
      const fd = openSync(real, 'r');
      try {
        const buffer = Buffer.alloc(limit);
        const bytes = readSync(fd, buffer, 0, limit, 0);
        result = [result, buffer.toString('utf8', 0, bytes)].filter(Boolean).join('\n\n').slice(0, limit);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !namedAsBrief(path)) continue;
      return null;
    }
  }
  return result;
}
