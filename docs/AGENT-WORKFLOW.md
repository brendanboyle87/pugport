# Owner's agent workflow

This is the owner's preferred workflow for agents working directly on their behalf. Other contributors may use any editor, model, or process that meets the shared requirements in [Contributing](../.github/CONTRIBUTING.md). They do not need pstack, Ponytail, Codex, or a paid AI account. Reporting an idea or bug requires none of these tools.

For owner-directed changes, use pstack and Ponytail once per coherent change, including follow-up fixes. Apply only guidance relevant to the task. The task sizes below override upstream instructions that would require design competitions or delegation for every function-boundary change. A read-only question does not require a code review.

## Match the process to the change

- Small, well-understood changes use one implementation owner, affected-caller checks, and a final review. Do not create parallel designs merely because two functions change.
- Independent frontend and backend work may run in parallel after agreeing their shared contract. Use a separate reviewer where a defect could be missed.
- Changes to credentials, permissions, billing estimates, deletion, migrations, or concurrent scheduling need explicit boundary checks and behavioral regression tests. Explore competing designs only when there is an unresolved design choice.

Do not reload all skills, rediscover the repository, or repeat the full test suite after every correction. Recheck what changed. Run full application checks on the final candidate as described in AGENTS.md. Documentation and automation changes follow their narrower checks. CI remains configured independently.

## Before and after a change

1. Read pstack's `poteto-mode/SKILL.md` and `ponytail/SKILL.md` from the installed skill directory. In Codex, this is `$CODEX_HOME/skills` or `~/.codex/skills`. State briefly that both are in use.
2. Use the relevant pstack guidance within the task size above. Apply Ponytail's default `full` level. Trace affected callers and reuse existing components before adding code.
3. Run the relevant checks in [AGENTS.md](../AGENTS.md). For a UI change, inspect the rendered result. A successful build alone does not verify the interaction.
4. Read and apply `ponytail-review/SKILL.md` to the completed change and connected code. Fix concrete findings within the authorized task. Report results and anything not checked.
5. When the owner corrects a repeated mistake, apply pstack's `correct/SKILL.md`. Prefer a shared owner, type, validation, or behavioral test that prevents recurrence. Add prose only when the rule requires judgment.

Do not run the whole-repository `ponytail-audit` for every small change. The review covers the current change. `ponytail-debt`, `ponytail-gain`, and `ponytail-help` are available when relevant. If a preferred skill is missing, report that fact and use its official guidance when useful. Continue the task's checks without requiring a contributor to install it. Do not claim an unavailable skill ran.

## Codex compatibility

Pstack's upstream instructions target Cursor. Apply these host mappings in Codex while preserving the engineering checks:

- Select supported child models and effort for the assigned work when the host allows it. Routine checks can use lower effort; difficult design or correctness review can use higher effort. Do not automatically inherit the main agent's highest effort. When the host requires inheritance, state that limitation. Use native `collaboration` agents with an explicit scope and distinct write ownership. Multiple reviewers are independent reviews, not a claim of different model families.
- Replace `Task`, `poteto-agent`, and `comment-sicko` with ordinary Codex agents given the relevant skill and task. For comment review, read the changed comments and keep explanations of non-obvious reasons. Do not claim that an unavailable named agent ran.
- Use the current local workspace. Separate concurrent edits by file. Use a worktree when isolation is needed. Cursor cloud-task options do not apply.
- Use the installed `skill-creator` for skill changes, `unslop` and repository checks for cleanup, and CUA plus existing automated tests for UI verification. Use terminal tools for CLI checks. These are host substitutions for `create-skill`, `deslop`, `control-ui`, and `control-cli`.
- Keep Codex configuration in Codex. Do not run the Cursor-only `setup-pstack` procedure or create `~/.cursor/rules/pstack-models.mdc` for this project.
- A playbook step that commits, opens a PR, sends a message, publishes, or merges still requires the authorization defined in [AGENTS.md](../AGENTS.md). Record an inapplicable step as skipped with its reason.

## Sources and installed versions

The maintainer's setup uses these pinned upstream revisions:

| Package | Official source | Revision | Installed skills |
| --- | --- | --- | --- |
| pstack 0.15.25 | [cursor/plugins, pstack](https://github.com/cursor/plugins/tree/182f2ce414e83224915c190d2f63239c1608d0a5/pstack) | `182f2ce414e83224915c190d2f63239c1608d0a5` | 54 |
| Ponytail 5.3.1 | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail/tree/6f1c2bfff0c837d268929a7c4e490918eb4fab29) | `6f1c2bfff0c837d268929a7c4e490918eb4fab29` | 6 |

To reproduce the owner's optional tool setup, install the skill directories with Codex's `skill-installer`. Keep sibling directories together because pstack uses relative references. Codex names use the directory's lowercase name. Cursor-only frontmatter fields are retained as upstream metadata, and explicit-only helper policies are mapped to Codex invocation policy. The main `poteto-mode` entry permits the owner's requested regular use.

These are local skill files, not the packages' lifecycle hooks. Local provenance and file hashes are stored in `~/.codex/skill-installations/`. No third-party hook or service is needed for this workflow.

## Checks that preserve behavior

| Requirement | Existing enforcement |
| --- | --- |
| New Bot configuration survives restart, remains visible when disabled, and preserves old settings | `tests/external-agent-addition.test.ts` |
| Bot addition works through the shared dialog and does not send a message or open a login window automatically | `tests/bot-addition-renderer.test.ts`, included by the default `tests/*.test.ts` command |
| Uninstalled default CLIs stay hidden while configured accounts remain manageable | `tests/native-discovery-visibility.test.ts` |
| Changed Bot settings discard old service and desktop readings, including an immediate read after clearing the usage URL | `tests/external-agents.test.ts`, `tests/web-usage-live.test.ts` |
| Completed quota failures and authentication errors do not remain in the initial loading state | `tests/quota-display.test.ts`, `tests/controller-identity-evidence.test.ts` |
| Claude metadata scans can read usage without changing task execution or inherited privacy controls | `tests/claude.test.ts` |
| Managed Mac login preserves profile isolation and clears process state after exit or launch failure | `tests/macos-account-login.test.ts` |
| The Mac account dialog enables supported providers and a second Codex login leaves the original credentials unchanged | `tests/codex-macos-login-ui.test.ts` |

Keep this table tied to behavioral checks. Do not add tests that only search for the wording of these instructions.
