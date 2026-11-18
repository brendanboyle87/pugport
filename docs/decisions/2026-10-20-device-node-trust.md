# Paired device nodes have the owner's local-task trust

Date: 2026-10-20
Owner ruling: supplied directly in the device-node files task; no issue or public comment was created.

Decision: a paired node is the owner's own computer and gets the same trust as a local task on the main. Writes default on, with `PUGPORT_PEER_READ_ONLY=1` as an opt-out. Ignore the old `PUGPORT_PEER_ALLOW_WRITE` variable.

Reason: the owner deliberately pairs their own computers and authorizes work in a chosen folder there.

Scope: device messages and MCP dispatch may write only with a chosen device folder and an explicit write grant. Keep node protected-folder checks and external caller ceilings. Folder-id allow-lists, Codex-only routing, network-off rules and credential-isolation gates do not apply. Delegation, agent-bridge writes and rerun-as-write remain separate work.

Replaces: the OPEN item in [MAC-PORT §2](../MAC-PORT.md#2-design-decisions) and the deferred N2-N4 gating assumptions. This does not authorize commits, publishing or unrelated cloud actions.

## 2026-10-21 amendment: optional folder and full access

The owner confirmed that device tasks must run commands, use the network, install software and change settings on their own paired computers. This supersedes the chosen-folder requirement above. Auto/build device messages may write unless read-only is selected; chat remains read-only. Without a folder, the node creates and validates `~/PugPort-Workspace`, also used for desktop forwarding.

Device-origin writes use full access and automatic tool approval; project trust is never persisted. pi is excluded because its automatic mode cannot execute the required commands. External caller ceilings, incognito refusal, tool-less untrusted tasks, write opt-out and the prohibition on device-to-device forwarding remain in force. Installation and settings tasks need not change files in the working folder to complete.

Device source forwarded to the local desktop through the external API now requires the desktop forward token.

Later the same day the live Mac test showed Grok's own auto classifier refusing writes outside the folder, so the owner chose that Claude and Grok also run device-origin writes with `bypassPermissions`, matching Codex's full access. Local tasks keep their usual modes. The default folder moved from `~/PugPort/Workspace` to `~/PugPort-Workspace` because macOS paths ignore case and `~/PugPort` was the node's own `~/pugport` checkout, whose AGENTS.md the CLIs loaded.
