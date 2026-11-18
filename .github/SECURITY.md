# Security Policy

PugPort runs local coding agents that can read and write files and execute commands, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through GitHub: open this repository's **Security** tab (shown as **Security and quality** in GitHub's current layout) and choose **Report a vulnerability**.

Include affected version, steps to reproduce, and impact. Remove any tokens, account identifiers or private project content from the report. We aim to acknowledge reports within 7 days.

## Scope

In scope: the local HTTP API (host/origin checks, session token), attachment storage, permission and approval handling, credential isolation between managed accounts, and anything that could leak credentials or run commands without the user's intent.

Out of scope: vulnerabilities in the upstream CLIs (Codex, Claude Code, Grok, Cursor, Pi). Report those to their maintainers.
