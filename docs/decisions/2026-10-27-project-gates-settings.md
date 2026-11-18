# Project GitHub rules in settings

Project GitHub rules are edited as one rule per line in project memory and settings. Branch patterns use `always-ask branch <glob>` and paths use `always-ask <glob>`. Missing saved lists inherit defaults; saved lists replace defaults, and empty lists disable those defaults. A list is saved only when it differs from the defaults, so a project that adds one rule keeps the defaults it had then and does not pick up later additions to the default list. The remote default branch still always requires confirmation.

Adding any author email, including the first, loosens the outbound text scan and requires native confirmation. An `author` rule also disables GitHub connector file writes because that connector cannot verify its commit identity. This side effect is recorded here; this batch adds no separate UI for it.

The local HTTP route permits only tightening. The native desktop confirmation handles loosening and checks the project and description again before applying it. Rules remain enforced by the existing GitHub gate.
