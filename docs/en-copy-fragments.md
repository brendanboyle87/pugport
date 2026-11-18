# English copy fragments and translation gaps

Round 1 audit, 2026-10-15. This register proposes later code work; it changes no source keys or translations. Locations refer to baseline 823a9b0.

## True fragments

36 inspected rendered sentence groups below need a whole template. Plus signs describe separate nodes or expressions, not literal punctuation. A slash between English alternatives means separate whole patterns for separate states. Number slots in these proposed new patterns are illustrative; existing catalog slots must stay unchanged until a separately approved code round. Preserve inline links/code through a translation-aware component where needed rather than creating more independently translated fragments.

This register focuses on grammatical sentences and word-boundary failures. An icon next to a complete label, a number in a separate badge, or a label paired with an input is not itself a broken sentence. The ignored fragment-candidates.json retains the broader mechanical JSX inventory for follow-up; it is not a count of defects. Recheck plural forms and rendered spacing when implementing templates.

| # | File:line | Rendered pieces | Whole English template(s) | Why code is needed |
| ---: | --- | --- | --- | --- |
| 1 | [src/ui/App.tsx:1086](../src/ui/App.tsx#L1086) | 任务完整执行链加载失败（ + error + ）。 | Could not load the full task history ({0}). | Separate parenthesis nodes are not a complete translatable sentence. |
| 2 | [src/ui/App.tsx:1105](../src/ui/App.tsx#L1105) | 完整记录加载失败（ + error + ）。下面只是摘要… | Could not load the full record ({0}). Showing only the last 1,000 characters, without events. The record is still saved locally. | One error and recovery explanation must be translated together. |
| 3 | [src/ui/App.tsx:1208](../src/ui/App.tsx#L1208) | 父任务 + parent ID + 的关联子任务 · 未报告父执行记录 ID | Subtask of {0} · Parent run ID not reported | The possessive clause needs English word order. |
| 4 | [src/ui/ClaimsCheck.tsx:40](../src/ui/ClaimsCheck.tsx#L40) | 执行器说完成了 + count + 项 + reviewed/unreviewed suffix | The executor reports {0} completed items. Each claim was reviewed: / The executor reports {0} completed items. Not reviewed; evidence is self-reported: | Use two whole templates, preserving the verification distinction. |
| 5 | [src/ui/Connectors.tsx:402](../src/ui/Connectors.tsx#L402) | 已连接“ + alias + ” | Connected “{0}” | The closing quote is a separate text node. |
| 6 | [src/ui/Connectors.tsx:463](../src/ui/Connectors.tsx#L463) | 首次连接 + provider + ，需要先配置应用的 OAuth 客户端… | To connect {0} for the first time, configure its OAuth client, then sign in to authorize access. You only need to configure each service once. | The provider belongs inside a whole sentence. |
| 7 | [src/ui/Connectors.tsx:572](../src/ui/Connectors.tsx#L572) | 为“ + alias + ”完成授权 | Authorize “{0}” | The current suffix translates only the closing quote and drops the final action. |
| 8 | [src/ui/Connectors.tsx:577](../src/ui/Connectors.tsx#L577) | 打开 + provider + 授权 | Authorize with {0} | The action and provider need one translatable label. Keep it no longer than the composed current label. |
| 9 | [src/ui/Connectors.tsx:712](../src/ui/Connectors.tsx#L712) | 断开“ + alias + ”并删除本机保存的凭据？… | Disconnect “{0}” and remove its saved credentials from this computer? Your mail, cloud files, calendars, tasks and contacts will be kept. | Preserve the full confirmation and retention explanation together. |
| 10 | [src/ui/ConversationFolders.tsx:310](../src/ui/ConversationFolders.tsx#L310) | 删除「 + folder name + 」后，对话将回到未分类… | Delete “{0}”? Its conversations will return to Uncategorized. Their content and pins will be kept. | The whole conditional sentence depends on the folder name. |
| 11 | [src/ui/ConversationFolders.tsx:634](../src/ui/ConversationFolders.tsx#L634) | 正在整理 + processed + / + total + 条对话… | Organizing conversations: {0} of {1}… | The count and verb must stay together. |
| 12 | [src/ui/ConversationFolders.tsx:654](../src/ui/ConversationFolders.tsx#L654) | 分类已应用。 / 建议如下： + count + 条对话， + groups + 个分类。 | Applied: {0} conversations in {1} categories. / Suggested: {0} conversations in {1} categories. | Use a complete pattern for each status. |
| 13 | [src/ui/ConversationPanel.tsx:340](../src/ui/ConversationPanel.tsx#L340) | 每章用新的上下文写…同时最多 + max + 个，其余排队… | Each chapter starts with fresh context to keep later chapters consistent. Up to {0} agents run at once; the rest wait in the queue. All share story notes for characters, timelines and foreshadowing. | An inserted count splits a long grammatical sentence. |
| 14 | [src/ui/DelegationProgress.tsx:111](../src/ui/DelegationProgress.tsx#L111) | 交接记录：已确认工具 + confirmed + 项 · 待核验 + unconfirmed + 项 | Handoff: {0} confirmed tool calls · {1} awaiting verification | The count classifiers and verbs need one template. |
| 15 | [src/ui/Executors.tsx:554](../src/ui/Executors.tsx#L554) | 会删掉 + account + 在这台电脑上的登录文件和配置… | Delete the sign-in files and settings for {0} on this computer? They cannot be restored from {1}. Run history and usage will be kept. Enter the account name to confirm: | Use account and platform destination slots; retain the permanent-deletion warning. |
| 16 | [src/ui/Executors.tsx:1515](../src/ui/Executors.tsx#L1515) | Key 只保存在这台电脑上，只用于调用 + provider + 。 | This key stays on this computer and is used only for {0}. | The final punctuation is its own node. |
| 17 | [src/ui/Extensions.tsx:834](../src/ui/Extensions.tsx#L834) | 需要补充 + count + 项连接设置 | Connection settings missing: {0} | The current isolated prefix is Complete, which reverses the meaning in isolation. |
| 18 | [src/ui/ExternalAgents.tsx:761](../src/ui/ExternalAgents.tsx#L761) | 本期从 + date + 开始 | Current period starts {0} | English needs the verb before the date. Use the selected locale for the date too. |
| 19 | [src/ui/ExternalAgents.tsx:893](../src/ui/ExternalAgents.tsx#L893) | 这条答复用到了 + names + 的第三方回复，只作参考… | This answer uses third-party replies from {0} as reference material. Later messages will not send it to executors. Quote it to continue working on it; that message runs without tools. | The names split the subject and possessive clause. |
| 20 | [src/ui/ManualResetEditor.tsx:129](../src/ui/ManualResetEditor.tsx#L129) | date or 日期未注明 + 到期 | Expires {0} / Expiry date not specified | English needs the verb before the date; missing dates need a separate whole message. |
| 21 | [src/ui/MediaWorkflows.tsx:679](../src/ui/MediaWorkflows.tsx#L679) | 视频约每 + seconds + 秒取样 · 每文件最多 + count + 个候选 | Video sampled about every {0} seconds · Up to {1} candidates per file | Adverbs, units and counts form one sentence. |
| 22 | [src/ui/MediaWorkflows.tsx:748](../src/ui/MediaWorkflows.tsx#L748) | 匹配位置：第一份 + start/end + 秒；第二份 + start/end + 秒 | Matching spans: first file {0}–{1} seconds; second file {2}–{3} seconds | Four values belong to one comparison. |
| 23 | [src/ui/ResetCreditsSummary.tsx:136](../src/ui/ResetCreditsSummary.tsx#L136) | date + 到期 + optional status | Expires {0} / Expires {0} · {1} | The expiry verb must move ahead of the date. |
| 24 | [src/ui/ResetCreditsSummary.tsx:155](../src/ui/ResetCreditsSummary.tsx#L155) | 为 + account + 使用这张重置卡？使用后不可撤销。 | Use this reset card for {0}? This cannot be undone. | The account must follow the English verb phrase. |
| 25 | [src/ui/ResetCreditsSummary.tsx:194](../src/ui/ResetCreditsSummary.tsx#L194) | 卡片到期与额度窗口重置不同。 + enabled/disabled + ；明细可能仅为部分卡片。 | Card expiry differs from quota-window reset. Automatic use is enabled; the list may show only some cards. / Card expiry differs from quota-window reset. Automatic use is off; the list may show only some cards. | Use whole enabled/disabled sentences rather than a hanging semicolon node. |
| 26 | [src/ui/RunEventLedger.tsx:153](../src/ui/RunEventLedger.tsx#L153) | 已显示 + shown + / + total + 条；本地记录 + local + 条。… | Showing {0} of {1} events; {2} events are saved locally. Compare sequence numbers and times with the trace details. | A Chinese classifier splits the two clauses. |
| 27 | [src/ui/RunEventLedger.tsx:158](../src/ui/RunEventLedger.tsx#L158) | 来源记录有 + gaps + 个序号缺口，不能据此宣称记录完整。 | The source record has {0} sequence gaps. It cannot establish a complete history. | Keep the missing-evidence limitation in one sentence. |
| 28 | [src/ui/SlackGateway.tsx:372](../src/ui/SlackGateway.tsx#L372) | 在 Slack 里私信机器人： + pair code + （10 分钟内有效，只能用一次） | Send “pair {0}” to the bot in a Slack direct message. The code expires in 10 minutes and works once. | Do not translate only the text surrounding the code element. |
| 29 | [src/ui/SlackGateway.tsx:382](../src/ui/SlackGateway.tsx#L382) | date + 配对 | Paired {0} | English puts the action before the date. |
| 30 | [src/ui/SubscriptionSummary.tsx:17](../src/ui/SubscriptionSummary.tsx#L17) | 账号标识： + ID + （本地匿名标识） | Account ID: {0} (local anonymous ID) | The suffix and punctuation must be translated with the ID label. |
| 31 | [src/ui/SwarmWorkspace.tsx:364](../src/ui/SwarmWorkspace.tsx#L364) | 并行省了 + duration | Saved {0} by running in parallel | The English prepositional phrase must follow the duration. |
| 32 | [src/ui/TasteTest.tsx:291](../src/ui/TasteTest.tsx#L291) | date + 试写选出 + optional reason | Selected by trial writing on {0} / Selected by trial writing on {0} · {1} | English needs the date after the action. |
| 33 | [src/ui/Trajectory.tsx:277](../src/ui/Trajectory.tsx#L277) | 完整公开事件审计缺少 + count + 条事件；历史未采集内容无法恢复。 | The public event audit is missing {0} events. Events not captured at the time cannot be recovered. | The count is embedded in a complete warning. |
| 34 | [src/ui/UsagePage.tsx:190](../src/ui/UsagePage.tsx#L190) | reported + / + total + 次有报告 | Reported in {0} of {1} runs | English requires a preposition before the numeric fraction. |
| 35 | [src/ui/UsagePage.tsx:220](../src/ui/UsagePage.tsx#L220) | reportedRuns + 次有用量 | Usage reported in {0} runs | The verb phrase must move ahead of the count. |
| 36 | [src/ui/Workspace.tsx:1262](../src/ui/Workspace.tsx#L1262) | 它运行期间，范围外有 + count + 个文件被改动： + paths + optional 等 | While this task ran, {0} files outside its scope changed: {1}. / While this task ran, {0} files outside its scope changed, including: {1}. | Do not imply this task caused the changes; use a separate truncated-list template. |

## Spacing checks, not confirmed code defects

These 10 inspected joins are not counted above. They can already form natural English, or may be fixed by context-safe edge spaces. Check all uses before adding spaces; do not prescribe code changes merely because a number is a separate node. Use proper singular/plural handling if a count can be one.

| Location | Pieces to check |
| --- | --- |
| [src/ui/App.tsx:581](../src/ui/App.tsx#L581) | 实际请求 + passed/failed + date |
| [src/ui/AgentPresets.tsx:238](../src/ui/AgentPresets.tsx#L238) | customCount + /50 个自定义角色 |
| [src/ui/Extensions.tsx:562](../src/ui/Extensions.tsx#L562) | 找到 + count + 项 |
| [src/ui/Extensions.tsx:786](../src/ui/Extensions.tsx#L786) | tool count + 个功能 + （声明为只读） when applicable |
| [src/ui/ManualResetEditor.tsx:110](../src/ui/ManualResetEditor.tsx#L110) | USD + remaining + / + total + 剩余 |
| [src/ui/MediaWorkflows.tsx:647](../src/ui/MediaWorkflows.tsx#L647) | files + 个文件 · + results + 项匹配 · + errors + 项读取问题 |
| [src/ui/MemoryEvidence.tsx:47](../src/ui/MemoryEvidence.tsx#L47) | 请求 + calls + 次 · 缓存 + count + 条 · + ms + ms |
| [src/ui/Trajectory.tsx:262](../src/ui/Trajectory.tsx#L262) | tools + 条工具记录 · 原生 + native + · PugPort + pugport + linked suffix |
| [src/ui/UsagePage.tsx:620](../src/ui/UsagePage.tsx#L620) | 订阅调用 + subscription + 次 · 按用量调用 + usage + 次 · 类型未确认 + unknown + 次 |
| [src/ui/Workspace.tsx:325](../src/ui/Workspace.tsx#L325) | 上次同步 + time + · sessions + 个会话 · messages + 条记录 |

## Shared keys that need different English

### Audit batch C, 2026-10-29

The navigation headings below still share keys with actions or individual items. Batch C limits
`Studio.tsx` edits to Run history rows and explicitly excludes `navGroups`; the heading-only scope
exception has been requested but has not been confirmed. These splits are recorded for the navigation
batch, not applied to the source or the shared English values:

| Current key | Heading context                | Separate heading key | Heading English | Existing context to preserve               |
| ----------- | ------------------------------ | -------------------- | --------------- | ------------------------------------------ |
| 置顶        | Studio pinned chats heading    | 已置顶               | Pinned          | 置顶 / Pin remains the row action.         |
| 项目        | Studio projects heading        | 项目列表             | Projects        | 项目 / Project remains singular elsewhere. |
| 任务        | Studio `navGroups` Tasks label | 任务列表             | Tasks           | 任务 / Task remains singular elsewhere.    |

The active batch C quota label is one complete shared template, `剩余 {0}%` → `{0}% left`, used by
`UsageBar` and executor account cards. The composer placeholder uses `想做什么？` → `Ask anything`;
mention and search instructions are a separate first line in the Add menu.

### Earlier audit

All 6 rows are **needs separate keys**. A glossary rename cannot fix singular and plural contexts sharing one Chinese key. Keep current translations until the source contexts can be distinguished. The settings label Connect and the verb Connect already agree; that alone is not a reason to split 连接. 排队 is currently a status key in shared/swarm.ts, so do not infer an unobserved action conflict.

| Key | Group/category source | Group English | Individual source | Individual English | Reason |
| --- | --- | --- | --- | --- | --- |
| 对话 | src/ui/ConversationFolders.tsx:183; src/ui/settings-categories.ts:5; src/ui/Studio.tsx:969/1307/1768 | Chats | src/ui/DesktopFeatures.tsx:338 | Chat | Navigation heading versus the desktop notification-title fallback. |
| 设备 | src/ui/settings-categories.ts:11; src/shared/participants.ts:29 | Devices | src/ui/ParticipantReply.tsx:50; src/ui/Mentions.tsx:36 | Device | Settings/group heading versus one participant. |
| 角色 | src/shared/participants.ts:26 (used by Mentions.tsx:29) | Roles | src/ui/Mentions.tsx:33; src/ui/ParticipantReply.tsx:54 | Role | A list heading versus a singular identity tag. |
| 执行器 | src/shared/participants.ts:27 (used by Mentions.tsx:29) | Executors | src/ui/Mentions.tsx:34; src/ui/ConversationFolders.tsx:591 | Executor | The participant group versus a single executor choice. |
| 技能 | src/ui/ConversationPanel.tsx:22 | Skills | src/ui/Extensions.tsx:600 | Skill | A plural tab versus the type of one extension. |
| 工具 | src/ui/Extensions.tsx:331 | Tools | src/ui/Extensions.tsx:600 | Tool | The tools settings group versus one extension type. |

## Extraction by-products, not true fragments

1142 active keys occur only as literal pieces of a template in the extractor’s source roots. Their map entry has templateByproductOnly: true; every template-part occurrence includes its whole pattern. Never rewrite these as standalone UI text. A piece reused as an actual StringLiteral or JSXText elsewhere has templateByproductOnly: false even if some occurrences are template parts.

For example, [SlackGateway.tsx:179](../src/ui/SlackGateway.tsx#L179) renders the whole pattern 第 {0} 步，共 3 步. The extracted pieces 第 and 步，共 3 步 are not two React text nodes there. Conversely, the count in Extensions.tsx:834 really is a separate JSX expression.

## Hard-coded platform destinations

21 active keys mention 回收站 inside a longer value, including template by-products. Every occurrence is listed below. For cross-platform filesystem copy, replace the hard-coded destination in later code with a slot populated by the existing [trashName](../src/server/platform/trash.ts#L18) helper (or its UI equivalent): Recycle Bin on Windows, Trash on macOS. Recently deleted is an app list, not an OS destination. Preserve the destination placeholder alongside every pre-existing slot.

Windows-only PowerShell messages can retain Recycle Bin; mail-service trash belongs to the service, not the OS. Agent-only tool/prompt entries remain excluded from the English copy pass. Neither exception is permission to change them now.

| Key | Current English | All source occurrences | Treatment |
| --- | --- | --- | --- |
| 。登录文件夹没能移到回收站，仍留在原处。 | . The login folder couldn't go to the Recycle Bin and is still in place. | src/ui/Executors.tsx:525 | Use platform-name slot where cross-platform; template-only by-product |
| 不在主文件夹所在的磁盘上，无法移到回收站；没有删除它 | Not on the disk that holds the home folder, so it can't go to the Trash; it was not deleted | src/server/platform/trash.ts:240; src/server/platform/trash.ts:279 | Use platform-name slot where cross-platform |
| 删除文件时直接移到回收站 | Move deleted files straight to the Recycle Bin | src/ui/App.tsx:2074; src/ui/App.tsx:2076 | Use platform-name slot where cross-platform |
| 回收站操作未完成{0} | Recycle Bin operation not completed{0} | src/server/platform/trash.ts:42 | Use platform-name slot where cross-platform |
| 回收站文件夹无效（不是普通文件夹）。 | The Trash folder is not valid (not a regular folder). | src/server/platform/trash.ts:213 | Use platform-name slot where cross-platform |
| 回收站里同名的项目太多 | Too many items with the same name in the Trash | src/server/platform/trash.ts:284 | Use platform-name slot where cross-platform |
| 在这台电脑上的登录文件和配置，不能从回收站还原；执行记录和用量保留。输入账号名确认： | 's login files and settings on this computer. They can't be restored from the Recycle Bin; run history and usage are kept. Type the account name to confirm: | src/ui/Executors.tsx:554 | Use platform-name slot where cross-platform |
| 对任务已授权的删除，PugPort 直接移到系统回收站，不额外确认；原生 CLI 仍会检查权限。 可在回收站还原；放不进回收站的文件会跳过，不会永久删除。 | For authorized deletions, PugPort moves files to the system trash without another confirmation; native CLIs still check permissions. You can restore files from the trash. Files that cannot be moved there are skipped and never permanently deleted. | src/ui/App.tsx:2078 | Use platform-name slot where cross-platform |
| 已移除 {0}。登录文件夹没能移到回收站，仍留在原处。 | Removed {0}. The login folder couldn't go to the Recycle Bin and is still in place. | src/ui/Executors.tsx:525 | Use platform-name slot where cross-platform |
| 已移除 {0}，登录信息在回收站里，需要时可以还原。 | Removed {0}. Its login is in the Recycle Bin if you need to restore it. | src/ui/Executors.tsx:524 | Use platform-name slot where cross-platform |
| 执行当前任务已授权的删除时，调用 PugPort 工具 recycle_files 把项目内的文件或文件夹移到回收站（可恢复，PugPort 不额外确认）；此设置不扩大任务范围，也不取消原生 CLI 的权限检查。不要用命令永久删除。 | For deletions authorized by the current task, use PugPort's recycle_files tool to move project files or folders to the Recycle Bin (recoverable, with no additional PugPort confirmation). This setting does not expand the task's scope or override native CLI permission checks. Do not permanently delete items with shell commands. | src/server/controller.ts:2294 | Agent-only: skip |
| 无法在回收站登记： | Couldn't register in the Trash: | src/server/platform/trash.ts:250 | Use platform-name slot where cross-platform; template-only by-product |
| 无法在回收站登记：{0} | Couldn't register in the Trash: {0} | src/server/platform/trash.ts:250 | Use platform-name slot where cross-platform |
| 未能移到回收站（ | Couldn't move to the Recycle Bin ( | src/server/platform/trash.ts:280 | Use platform-name slot where cross-platform; template-only by-product |
| 未能移到回收站（{0}） | Couldn't move to the Recycle Bin ({0}) | src/server/platform/trash.ts:280 | Use platform-name slot where cross-platform |
| 登录信息移到回收站，执行记录和用量保留。 | Login data goes to the Recycle Bin. Execution history and usage are kept. | src/ui/Executors.tsx:508 | Use platform-name slot where cross-platform |
| 移动、改名、删除用 organize_files（可以操作项目以外的文件夹，删除进回收站，每次都可撤销），不要用命令直接移动或删除。 | Use organize_files to move, rename, or delete files. It supports folders outside the project, sends deleted files to the Recycle Bin, and allows undo for each operation. Do not move or delete files directly with commands. | src/server/controller.ts:2337 | Agent-only: skip |
| 管理标签或文件夹、标记已读、归档和移入回收站。 | Manage labels or folders, mark mail as read, archive it or move it to trash. | src/ui/Connectors.tsx:53 | Mail-service destination: keep service terminology |
| 请用 paths 传入要移到回收站的文件或文件夹路径列表。 | Pass a list of file or folder paths to move to the Recycle Bin with paths. | src/server/recycle-bin.ts:22 | Agent-only: skip |
| 这台电脑的系统不支持移到回收站。 | This computer's system can't move items to the Recycle Bin. | src/server/platform/trash.ts:30; src/server/recycle-bin.ts:103 | Use platform-name slot where cross-platform |
| ，登录信息在回收站里，需要时可以还原。 | . Its login is in the Recycle Bin if you need to restore it. | src/ui/Executors.tsx:524 | Use platform-name slot where cross-platform; template-only by-product |

The large PowerShell literal in platform/trash.ts:53 contains Windows-only messages at lines 78, 85 and 99 that the catalog length filter does not extract separately. Do not report those as covered merely because 回收站 is in the catalog.

## Untranslated

These are delivery gaps. A catalog entry does not mean a non-DOM sink invokes the translator.

| Surface | File:line | Current behavior | Later change |
| --- | --- | --- | --- |
| Desktop notification title/body | [DesktopFeatures.tsx:338](../src/ui/DesktopFeatures.tsx#L338), notification call at 346 | The fallback title 对话 and the bodies 等待你的确认 / 任务已完成 / 任务失败 / 任务已停止 are passed straight to Notification. DOM translation never visits them. | Translate only the fallback title and system body before constructing Notification; preserve user-written conversation titles. |
| Native quit error | [electron/shell.ts:224](../src/electron/shell.ts#L224) | showErrorBox receives PugPort 无法退出 and fallback 后台清理失败，请重试。 without t(). | Translate the title and known fallback. Preserve unknown diagnostic details. |
| Native backend error | [electron/main.ts:251](../src/electron/main.ts#L251) | PugPort 后台不可用 and 启动失败；不会连接已有的未知服务。 bypass t(). | Translate known title/fallback before showErrorBox. |
| Native startup fallback | [electron/main.ts:260](../src/electron/main.ts#L260) | The data-location-specific branch already uses t(), but generic error.message and 桌面启动失败。 remain raw. | Translate known messages; do not claim the whole branch is untranslated. |
| CLI output | [src/cli](../src/cli), e.g. ask.ts:25, ask.ts:84, quota.ts:34, pugport.ts:40 and pugport.ts:87 | CLI text goes to terminal output. src/cli is outside i18n-extract.mjs roots and does not use the DOM translator. | Define a CLI locale/translation entry point in a later round, then cover help, errors, progress, quota and interactive prompts. No CLI code changes now. |

Counts: 36 rendered sentence groups; 6 shared-key conflicts; 1142 template-only by-products; 21 platform-name keys; 3 untranslated surface families (notifications, native dialogs, CLI), detailed in 5 rows. These are separate inventories and must not be added as a count of unique catalog keys.
