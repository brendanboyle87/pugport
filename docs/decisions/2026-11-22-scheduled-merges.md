# The owner's maintainer agent merges reviewed AI-made pull requests on a schedule

Date: 2026-11-22
Owner ruling: given to the owner's maintainer agent on 2026-11-22 in a planning task; no issue was created.

Decision: the owner's own maintainer agent, running on the owner's computer, may merge pull requests into `main` on Saturdays and Sundays at any time, and on Monday to Friday between 00:00 and 06:00 in the owner's local time. A pull request qualifies only when all of these hold:

- it is labeled `ai-made` and was opened by the owner's account;
- the agent reviewed the change before opening it, or reviewed it again after any later push;
- every check on its current head commit passed. The agent may re-run failed jobs of a finished run, at most twice for each head commit;
- GitHub reports it mergeable, it is not a draft, and it has no unresolved review threads or code-scanning alerts and no request for changes;
- it carries neither `needs-owner-ruling` nor `do-not-merge`;
- it does not change `AGENTS.md`, anything under `.github/`, dependencies (`package.json`, `package-lock.json`), install or setup scripts, release and signing configuration, or database migrations.

Merges are squash merges, authored with the owner's GitHub noreply address.

Reason: reviewed AI-made work whose checks pass should land without waiting for the owner to merge it by hand.

Scope: only the pull requests described above. These stay with the owner:

- pull requests from other contributors and Dependabot updates;
- fixes prepared in private security advisory forks, and publishing advisories;
- releases, tags and repository settings.

The agent stops merging while `main` fails its checks after a merge, and resumes once a fix or the owner restores it. A label alone still does not authorize a merge.

Replaces: none. It narrows "Only the owner merges" in [AGENTS.md](../../AGENTS.md) for these cases only.
