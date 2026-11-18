/**
 * Conversation work modes (docs: .design/modes/design.md). Absent means Normal. A mode adds one prompt block after
 * personal instructions and never becomes a message, so no memory sink can store it.
 */
export const workModeIds = ['mods-author', 'navigator'] as const;
export type WorkMode = (typeof workModeIds)[number];

export const isWorkMode = (value: unknown): value is WorkMode => workModeIds.includes(value as WorkMode);

/** Interface copy, in the source language; en.json carries the English. */
export const workModeCopy: Record<WorkMode | 'normal', { label: string; description: string }> = {
  normal: { label: '普通', description: '照常聊天和处理任务。' },
  'mods-author': { label: 'Mod 作者', description: '在这个对话里制作和调试 PugPort Mod。' },
  navigator: { label: '领航', description: '领航员负责规划、派发和复核，子任务完成具体工作。' },
};

/** Markers the memory guard looks for; nothing outside RunInput.prompt may contain them. */
export const workModeMarker = '<pugport-mode';
export const modDebugMarker = '<pugport-mod-debug';

const precedence =
  "Project rules, the user's current request, tool permissions and the permission ceiling win over this block; it grants nothing.";

const modsAuthorIntro = `You are building a PugPort Mod in this chat. A Mod is a small web app that runs inside one chat in a sandboxed
iframe and talks to PugPort only through window.pugport. Your workspace folder is the current project folder;
read .pugport/MOD-SPEC.md and .pugport/pugport-mod.d.ts before writing, and look at .pugport/example for a
working reference.`;
const modsAuthorLayout =
  'Author layout: manifest.json (without ui), README.md, ui/<entry>.html plus optional .css/.js.';

const modsAuthorLead = `${modsAuthorIntro} ${modsAuthorLayout}
Design the Mod however you and the user like: PugPort has no design rules, only the interface in MOD-SPEC.md.
When a version is ready, call mod_load to pack, validate, install locally and show it in this chat; read its
result (validation issues, warnings, permissions that still need the user's approval) and fix what it reports.
Use mod_debug or the <pugport-mod-debug> block in the next message to see errors and logs from the running Mod;
reproduce from those, not from guesses. Do not publish, do not touch any catalog, do not write outside the
workspace folder. ${precedence}`;

const modsAuthorMember = `${modsAuthorIntro}
${modsAuthorLayout}
Do not call mod_load; report what you changed and the lead will load it.
${precedence}`;

const navigatorDispatchWrite = `3 Dispatch — hand every item to a sub-task with delegate_many (or delegate): a complete, standalone task
  text, write=true with files for changes, plan_id, tier (light for reading, standard/strong for judgement),
  acceptance.criteria. For code changes, first send the brief to a read-only reviewer (role 代码审查,
  tier strong) and fix the brief before dispatching the implementation. Leave agent empty unless the user named one.`;
const navigatorDispatchRead = `3 Dispatch — hand every item to a sub-task with delegate_many (or delegate): a complete, standalone task
  text, plan_id, tier (light for reading, standard/strong for judgement), acceptance.criteria. This chat is
  read-only, so sub-tasks cannot change files. Leave agent empty unless the user named one.`;

const navigatorLead = (
  write: boolean,
) => `You are the navigator of this chat. You never implement anything yourself: no file edits, no commands, no
drafts of code or documents in your reply. Your work is to understand, plan, dispatch, review and summarize.
Loop for every request:
1 Understand — read the request, the project notes and the history. If one decision truly needs the user,
  ask with ask_user and end the turn; otherwise decide and continue.
2 Plan — call set_plan with short items (id, title, read|write, assignee). Simple requests get one item;
  a greeting or a trivial question gets a direct answer, with no plan and no sub-tasks.
${write ? navigatorDispatchWrite : navigatorDispatchRead}
4 Review — collect with get_result (wait=any, handle the first finished item while others run). Judge each
  result against its acceptance criteria and the user's request; for changes, send a reviewer sub-task
  (role 第三方评审 or 代码审查) and treat must/should findings as a new sub-task for the implementer, nits as
  notes. Never mark a sub-task done on its own say-so; verified claims and file receipts count, prose does not.
5 Summarize — one answer in the user's words: what was asked, what was done and verified, what remains, and
  where the files are. Then call report_outcome once and stop.
Sub-tasks pick their own executor, model and effort; do not pass yours. ${precedence}`;

/**
 * The mode block for one run. `lead` is the root task of the turn; `member` a delegated child. A navigator's
 * children are ordinary delegated tasks and get no block. `write` is the user's permission ceiling for the turn.
 */
export function modePrompt(
  kind: WorkMode | undefined,
  variant: 'lead' | 'member',
  context: { write: boolean } = { write: true },
): string {
  if (kind === 'mods-author')
    return `<pugport-mode kind="mods-author">\n${variant === 'lead' ? modsAuthorLead : modsAuthorMember}\n</pugport-mode>`;
  if (kind === 'navigator' && variant === 'lead')
    return `<pugport-mode kind="navigator">\n${navigatorLead(context.write)}\n</pugport-mode>`;
  return '';
}

/** Sets or clears the snapshot without leaving an empty key on Normal tasks. */
export function withWorkMode<T extends { workMode?: WorkMode }>(input: T, mode: WorkMode | undefined): T {
  const { workMode: _previous, ...rest } = input;
  return (mode ? { ...rest, workMode: mode } : rest) as T;
}
