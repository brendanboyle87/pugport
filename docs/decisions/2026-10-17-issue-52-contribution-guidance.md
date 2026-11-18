# Tool-neutral contributions and advisory PR size

Date: 2026-10-17

Issue: #52 in the earlier private development tracker (not public).

Owner ruling: The owner requested these changes in Codex on this date. The request and scope are recorded in the linked issue.

Decision: Pstack and Ponytail remain the owner's agent preferences. Other contributors can use their own tools. Suggestions need a description of the problem or desired outcome, not a development environment, implementation plan, claim, or CLA. Maintainers can help complete missing technical details. Code contributions still follow verification, secret handling, licensing, and maintainer review requirements.

Decision: Keep 500 counted changed lines as an advisory review threshold. A coherent larger PR needs neither a mandatory split nor a size waiver. Historical waivers remain as records. The bot keeps counting and reporting, but has no size-failure mode. Failures to obtain or validate GitHub metadata remain errors.

Reason: The previous mandatory tools, detailed forms, and size approval added friction for feedback and contributions. Review should focus on behavior, evidence, and whether the change belongs together.

Scope: Contributor guidance, issue and PR templates, the owner's task-sized agent workflow, and PR-size automation. Application behavior, security reporting, CLA terms, CI test jobs, and merge or release authorization are unchanged. Documentation and automation-only changes use relevant local checks; CI retains its configured checks.

Replaces: The blanket tooling and size-waiver requirements in AGENTS.md, docs/AGENT-WORKFLOW.md, and .github/CONTRIBUTING.md. No earlier decision record is replaced. PR #51's prior size approval remains historical evidence.
