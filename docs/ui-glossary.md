# English UI glossary

Round 2 decisions approved by the owner on 2026-10-15. These replace the round 1 proposals. The historical spelling counts below describe the round 1 catalog, not the current translations. KEEP retains established terminology.

## Voice and safety rules

- Use sentence case, second person and short active sentences. Never use Please. Errors say what happened and the next safe action; do not invent a retry.
- Approved 2026-10-15: use n't, 're, 'll, 've, it's, that's, there's and what's. Do not contract at a clause ending (as they are), contract nouns (the task's running), or use 'd. Leave quoted third-party text, provider messages, code and CLI text as written.
- Approved 2026-10-15: use straight apostrophes ('). Use only “ ” for quotation marks, including “Stop following”; retain literal quotes required by code, JSON, HTML or selectors.
- Approved 2026-10-15: Quick chat at the start of a label or sentence, quick chat mid-sentence. Spell queuing.
- Approved 2026-10-15: use limit window for 额度窗口 and Extra usage for Anthropic's 额外的使用额度. Use hand off as a verb, handoff as a noun, and auto handoff for the automatic feature.
- Tray, Quick chat and button text may only get shorter. Approved short forms: Refresh usage, Reading usage…, Usage unknown, Weekly limit (7 days), Daily limit (24 hours), 5-hour limit, -day limit, -minute limit. Apply the same pattern to other period lengths.
- Keep units (seconds, files, tokens, USD); tokens are not words. Preserve proper names, API names and CLI syntax.
- Preserve every key, key order, entry count, placeholder and leading/trailing space. The baseline has 6364 values, 6288 active keys and 76 stale entries; leave stale entries, agent-only text and the workspace SQL key untouched.
- One key has one English value everywhere. Split context-dependent keys in a code round; do not force one translation. Template fragments must stay compatible with their full patterns. [withSpacing](../src/shared/i18n/index.ts#L88) preserves edge spaces and adds the space after a label's colon (预计耗时： → Estimated duration: ), but infers no other English word boundaries; see the [fragment register](en-copy-fragments.md).
- Keep Chinese characters and full-width punctuation out of English values. Do not introduce < or & in prose. Existing HTML/code/selector/version text, OAuth & Permissions, Agents & AI Apps, Usage & connections, Permissions & security, Q&A and Image search & OCR are exceptions. & is a Windows menu mnemonic marker; preserve its intended behavior. [Tray HTML translation](../src/electron/locale.ts#L53) inserts text and attributes without escaping.
- Update labels and every instruction that cites them together. Slack has a separate [English table](../src/server/slack-gateway.ts#L99) and [manifest descriptions](../src/shared/slack-gateway.ts#L38). README edits in this round cover label references only.

## Terms

<!-- prettier-ignore -->
| Source concept | Round 1 spellings (historical counts) | English | Definition | Avoid | Decision |
| --- | --- | --- | --- | --- | --- |
| 标注 | — | Annotate | Draw marks on an image or page screenshot; annotation(s) for the result, mark for each shape. | markup as a UI action | PROPOSED |
| 信箱 | New in v1 | Inbox | System notices that need attention, shown from the sidebar. | mailbox, system-notices | PROPOSED |
| 主人卡片 | — | Owner card | The approval card the owner must accept before PugPort pushes, opens a PR, or merges. | silent push | PROPOSED |
| 问题卡 | — | Question card | An inline question with two answer buttons; a later user message or user-initiated continuation answers it. | prompt, poll, dialog | PROPOSED |
| 审核意见（必须改 / 建议改 / 小问题） | — | Review notes (must fix / should fix / nit) | The reviewer's graded findings on a result; only must fix and should fix go back for a redo. | review comments, issues, blockers | PROPOSED |
| 执行器 | executor: 222; executors: 48 | Executor | The native CLI or API runtime that performs a task. | execution engine, runner, agent as a blanket replacement | KEEP |
| 卡片 / 账号 | card: 29; cards: 13; account: 178; accounts: 60 | Account; account card | An account is a configured identity; its card is the UI representation. Reset cards are a different resource. | using card for every account, merging reset cards with accounts | KEEP |
| 角色 | role: 57; roles: 8 | Role | A reusable set of instructions, model choices and skills for new tasks. | persona, character outside fiction | KEEP |
| 对话 | conversation: 164; conversations: 58 | Chat; Chats (heading) | A saved thread of messages and tasks. | conversation, dialogue; session for a saved chat | Approved 2026-10-15 |
| 项目 | project: 168; projects: 10 | Project | A named workspace associated with a local folder and chats. | workspace as an interchangeable navigation label | KEEP |
| 侧聊 | side chat: 36; side chats: 6 | Side chat | A separate short chat that uses main-chat context. | sidebar chat, side talk | KEEP |
| 蜂群 | swarm: 60; swarms: 0 | Swarm | A group of agents working on delegated parts of one task. | hive, colony | KEEP |
| 模式芯片 | — | Mode chip | The icon next to + in the composer that picks a chat's work mode; Normal shows only the icon. | mode toggle, mode switcher | Approved 2026-11-04 |
| Mod 作者 | — | Mods author | The work mode that builds and debugs a Mod in a chat, in its own folder. | Mod builder, creator mode | Approved 2026-11-04 |
| 领航 | — | Navigator | The work mode whose read-only lead plans, delegates, reviews and sums up; sub-tasks do the work. | lead, director, manager | Approved 2026-11-04 |
| 本地构建 | — | Local build | A Mod version built from a Mods author folder on this computer. | dev build, sideload | Approved 2026-11-04 |
| 例程 | routine: 25; routines: 0 | Routine | A saved recurring task or an external bot routine; qualify the host when needed. | recipe for a scheduled task | KEEP |
| 交接 | hand off: 6; handoff: 29; handoffs: 0; relay: 4; relays: 1 | Hand off (verb); handoff (noun) | Continuation of unfinished work with another executor and saved context. | handover; handoff for every queued message | Approved 2026-10-15 |
| 接力 | account relay: 1; relay continuation: 1; relay source: 1; relay: 4; relays: 1 | Handoff; auto handoff (automatic) | Continuing unfinished work on another account or executor after a usage limit. | relay | Approved 2026-10-15 |
| 智能路由 | smart routing: 1 | Smart routing | Automatic selection of an account, model and reasoning effort. | intelligent dispatch, smart scheduling for the same feature | KEEP |
| 额度 | quota: 227; quotas: 1 | Usage limit; usage limits; usage left | A provider limit on model use; usage left is the remaining allowance. | quota; balance for a nonmonetary allowance | Approved 2026-10-15 |
| 用量 | usage: 156 | Usage | Recorded consumption of tokens, calls or cost. | quota when describing consumption | KEEP |
| 设备 / 节点 | device: 86; devices: 23; node: 12; nodes: 0 | Device; node (technical only) | Another computer running PugPort; node describes its service role. | node as the settings category; Devices for one participant | KEEP; needs separate keys |
| 账号直连 | — | Account access | Reaching a connected server through the account's tunnel-only key, without the computer's own SSH setup. | account tunnel; direct connection; SSH sync | PROPOSED |
| Mod | — | Mod; Mods (plural) | A versioned package attached to one chat, with its own interface and saved state. | mode or plugin as a replacement for Mod | PROPOSED |
| 扩展（侧栏） | — | Extensions | Sidebar destination for Mods, Skills, Connections and Components. | Mods Store as the sidebar destination | Approved 2026-10-27 |
| 技能（扩展标签） | — | Skills | Installed and recommended skills. | singular Skill for the tab | Approved 2026-10-27 |
| 连接与服务 | — | Connections | External services, MCP tools and access from other apps. | Connect as the tab label | Approved 2026-10-27 |
| 组件（扩展标签） | — | Components | Local components and workflows. | singular Component for the tab | Approved 2026-10-27 |
| 外部服务 | — | Services | Service rows on the Connections tab. | changing the existing 服务 / Service key | PROPOSED |
| 扩展 | extension: 18; extensions: 14 | Extension | An optional capability added to PugPort. | plugin as an unapproved global rename | KEEP |
| 技能 | skill: 26; skills: 30 | Skill | Reusable task instructions loaded when relevant. | ability, technique | KEEP |
| 组件 | component: 20; components: 14 | Component | An installable local runtime or model dependency. | widget for a runtime component | KEEP |
| 连接 | connect: 52; connection: 55; connections: 16 | Connect (action/category); connection (saved setup) | Access to another service or tool through configured integration. | link as a blanket replacement | KEEP |
| 连接器 | connector: 26; connectors: 7 | Connector | An integration that exposes a service and its allowed actions. | connection when naming the implementation type | KEEP |
| 外部智能体 | external agent: 9; external agents: 13 | External agent | An agent outside PugPort that receives a task or supplies a reply. | executor for third-party replies | KEEP |
| 自动插话 | automatic task updates: 1; auto-steer: 1; interject: 5; interjection: 18; interjections: 2; interjecting: 4 | Auto-steer; steer (verb); steering (noun) | Sending a follow-up into the active task when its transport supports it. | interject, interjection, task updates, add to the current task | Approved 2026-10-15 |
| 快捷聊天 | Quick chat: 4; quick chat: 4; Quick Chat: 0 in en.json, 1 in the voice rules | Quick chat; quick chat mid-sentence | The global shortcut window for a short chat. | Quick Chat | Approved 2026-10-15 |
| 补充 | follow-up: 35; follow-ups: 2; correction: 14; corrections: 0; steer family: 10 (SQL excluded) | Follow-up | One message added to an active task. 插话 also uses follow-up when it means one message. | correction | Approved 2026-10-15 |
| queueing / queuing | queueing: 7; queuing: 3 | Queuing | Putting messages into a queue. | queueing | Approved 2026-10-15 |
| 排队 | queue: 28; queued: 70; queueing: 7; queuing: 3 | Queue (noun/action); queued (status) | Work waiting to start after earlier messages or for capacity. | queueing as a completed status; Queued on an action button | KEEP |
| 思考强度 | reasoning effort: 15; thinking effort: 1 | Reasoning effort | The selected amount of model reasoning, where supported. | thinking intensity, thinking effort | Approved 2026-10-15 |
| 可写入 / 只读 | can write: 3; writable: 17; read-only: 72 | Writable; read-only | Permission labels. Keep Rerun with write access for 按可写入重新执行. | Can write as a permission label; read-only as an OS isolation guarantee | Approved 2026-10-15 |
| 隐身对话 | incognito chat: 6; incognito conversation: 0 | Incognito chat | A chat PugPort does not retain after its incognito lifecycle ends. | private chat as a promise about provider retention | KEEP |
| 任务判断 | task judgment: 14; task judgments: 1; task assessment: 6; task classification: 2 | Task classification; task category (result) | The intent classifier and the category used by routing. | task judgment, task assessment, local judgment | Approved 2026-10-15 |
| 回收站 | recycle bin: 18 | Recycle Bin (Windows) | The Windows recoverable file deletion destination. | Trash as the Windows label | PLATFORM FIXED |
| 废纸篓 | trash: 11 | Trash (macOS) | The macOS recoverable file deletion destination. | Recycle Bin as the macOS label | PLATFORM FIXED |
| 最近删除 | recently deleted: 2 | Recently deleted | The in-app list of recently deleted chats. | Trash or Recycle Bin for this list | KEEP |
| 任务 | task: 466; tasks: 166 | Task | A unit of work requested by the user. | job unless referring to a background analysis job | KEEP |
| 运行 / 执行记录 | run: 233; runs: 44; execution: 77 | Run; run history | One execution attempt and its recorded output. | execution record in short navigation text | KEEP |
| 消息 | message: 188; messages: 71 | Message | One user or assistant entry in a chat. | task for every message | KEEP |
| 文件 | file: 165; files: 209 | File | A stored document or other filesystem item. | document for arbitrary binaries | KEEP |
| 文件夹 / 目录 | folder: 91; folders: 31; directory: 33 | Folder; directory in technical paths | A filesystem container. | catalogue, directory in ordinary file-picker instructions | KEEP |
| 设置 | settings: 134; configuration: 40 | Settings; configuration in technical diagnostics | Saved choices controlling app behavior. | setting when naming the whole settings area | KEEP |
| 模型 | model: 130; models: 25 | Model | A provider model used by an executor. | engine as a casual synonym | KEEP |
| 窗口 | window: 93; windows: 14 | Window | An app window; limit window means a provider accounting interval. | pane for an OS window | KEEP |
| 权限 / 授权 | permission: 53; permissions: 86; authorization: 43 | Permission; authorization | Permission specifies an allowed operation; authorization grants it. | approval as a synonym for all permissions | KEEP |
| 审批 / 确认 | approval: 29; confirmation: 28 | Approval; confirmation | Approval allows a restricted action; confirmation accepts a choice. | authorization for an ordinary confirmation dialog | KEEP |
| 历史 / 记录 | history: 83; record: 76; records: 94 | History; record | Saved past activity and one entry in it. | log when the content is a chat | KEEP |
| 工具 | tool: 86; tools: 81 | Tool | An operation callable by an agent. | function for a whole integration | KEEP |
| 回复 | reply: 75; replies: 37; answer: 50 | Reply | An answer sent in a chat. | response in casual labels unless it is an API response | KEEP |
| 模式 | mode: 74 | Mode | A selected way the app handles work. | state for a user choice | KEEP |
| 电脑 / 本机 | computer: 77; local: 222 | Computer; this computer | The machine running this PugPort instance. | local device when this computer is clearer | KEEP |
| 路径 | path: 70; paths: 21 | Path | A filesystem location. | URL for a disk path | KEEP |
| 证据 | evidence: 69 | Evidence | Observed output or checks supporting a result. | proof for unverified model claims | KEEP |
| 结果 | result: 67; results: 69 | Result | The output or outcome of work. | success for an unchecked result | KEEP |
| 命令 | command: 67; commands: 38 | Command | An instruction entered in a terminal or executed by a tool. | request for shell syntax | KEEP |
| 图片 / 图像 | image: 69; images: 35 | Image | A picture attachment or local image file. | photo for every image | KEEP |
| 页面 | page: 65 | Page | A screen within the app or a web page. | window when only a page changes | KEEP |
| 接口 | API: 63 | API | A programmatic service interface. | subscription for metered API access | KEEP |
| 验证 / 核验 | verification: 59; verify: 40; verified: 46 | Verification; verified | A check against observed evidence; verified only after that check. | verified for an executor claim alone | KEEP |
| 输出 | output: 59 | Output | Text or artifacts produced by a run. | result when only raw output is available | KEEP |
| 计划 / 套餐 | plan: 57; plans: 4; subscription: 54 | Plan; subscription plan | Plan means task steps; subscription plan means provider entitlement. | using plan without qualification when both meanings are present | KEEP; needs separate keys when grammar differs |
| 来源 | source: 56 | Source | The origin of a reading, quote or artifact. | evidence when only provenance is known | KEEP |
| 密钥 / 键 | key: 56; keys: 4 | API key; key (catalog or keyboard context) | A service credential, translation key or keyboard key; qualify the meaning. | token as a synonym for every key | KEEP |
| 云端 | cloud: 57 | Cloud | A service hosted outside this computer. | remote as a claim that local data is uploaded | KEEP |
| 搜索 | search: 56 | Search | Find matching content. | scan when no exhaustive scan occurs | KEEP |
| 调用 | call: 54; calls: 23 | Call | One invocation of a tool or service. | request count when calls and retries differ | KEEP |
| 过程（轨迹页签） | — | Steps | The Trace tab that lists everything a run recorded in order: model replies, tool calls, status, usage and errors. Was 调用 / Calls; the code id stays `calls`. | Calls, which covers only tool calls | Approved 2026-11-04 |
| 操作 | action: 25; actions: 53; operation: 30; operations: 27 | Action; operation in diagnostics | A requested change or tool operation. | execution for an ordinary UI click | KEEP |
| 范围 | scope: 50 | Scope | The boundary of allowed or selected work. | sandbox as a synonym for task scope | KEEP |
| 限制 | limit: 50 | Limit | An upper bound on work, usage or capacity. | quota for every numeric maximum | KEEP |
| 媒体 | media: 50 | Media | Image, audio or video content. | multimedia resources | KEEP |
| 会话 | session: 49 | Session | A native executor session with its own continuity. | chat for a transport session | KEEP |
| 机器人 | bot: 47 | Bot | An automated participant in an external messaging service. | agent for Slack installation instructions | KEEP |
| 重置 / 重置卡 | reset: 49; reset card: 10; reset cards: 8 | Reset; reset card | A provider allowance reset or a redeemable reset entitlement. | account card for a reset card | KEEP |
| 标识 | ID: 47; identity: 23 | ID; account identity | An identifier, or the provider identity behind an account. | name for a stable ID | KEEP |
| 记忆 | memory: 47 | Memory | Saved context reused for later tasks. | history as a promise that all history is recalled | KEEP |
| 代码 | code: 46 | Code | Program text, or a pairing code when qualified. | token for a one-use pairing code | KEEP |
| 服务 | service: 47 | Service | A background or external program exposing capabilities. | server for every integration | KEEP |
| 智能体 | agent: 50; agents: 30 | Agent | An AI participant that can reason or act. | executor for every external agent | KEEP |
| 分析 | analysis: 44 | Analysis | Inspection of content to produce findings. | verification when evidence has not been checked | KEEP |
| 指令 | instructions: 40 | Instructions | Guidance for task behavior. | commands for natural-language guidance | KEEP |
| 参考 | reference: 40 | Reference | Material used as supporting context. | authority for untrusted source content | KEEP |
| 进度 | progress: 41 | Progress | Work completed relative to what remains. | completed for a process that merely stopped | KEEP |
| 后台 | background: 39; backend: 30 | Background; backend (technical service) | Background means work outside the active view; backend is the local app service. | background and backend used interchangeably | KEEP |
| 状态 | status: 75; state: 39 | Status; state (technical snapshot) | Status is a visible stage; state is stored runtime information. | condition for ordinary task status | KEEP |
| 登录 | sign-in: 38; login: 36; sign in: 50 | Sign in (action); sign-in (noun) | Authenticate an account with its provider. | login as a verb | KEEP |
| 字符 | characters: 38 | Characters | The displayed text-length unit. | words for a character count | KEEP |
| 成员 | members: 38 | Member | A participant in a swarm. | child for every human-readable participant | KEEP |
| 进程 | process: 36 | Process | A running operating-system program. | task for an OS process | KEEP |
| 项目 / 条目 | items: 36 | Items | A neutral count when no more specific unit exists. | items when files or messages is known | KEEP |
| 轮次 | turn: 37 | Turn | One request and reply cycle within a session. | run when no new execution starts | KEEP |
| 详情 | details: 35 | Details | Additional information about a selected item. | detail information | KEEP |
| 测试 | test: 36 | Test | A controlled check of behavior or connectivity. | verification as a guarantee based on one test | KEEP |
| 输入 | input: 36 | Input | Content supplied to a task or field. | prompt for every UI input | KEEP |
| 跟进 | follow-up: 35; follow: 61 | Follow-up; follow | An additional message, or continued tracking of an external reply. | interjection for all follow-up messages | KEEP |
| 强度 | effort: 35 | Effort | A compact label for reasoning effort when the context is clear. | strength | KEEP |
| 下载 | download: 34 | Download | Transfer a resource to this computer. | install when the file is only downloaded | KEEP |
| 本地流程 | recipe: 34; workflow: 16; workflows: 6 | Local workflow; recipe (portable definition) | A reusable media-analysis procedure; a recipe is its imported/exported definition. | routine for a media workflow | KEEP |
| 访问 | access: 33 | Access | Permission or ability to reach a resource. | authorization when describing network reachability | KEEP |
| 词元 | tokens: 32 | Tokens | The model accounting units for input and output. | words; title-cased Tokens in body copy | KEEP |
| 报告 | report: 32 | Report | A structured record of findings. | proof | KEEP |
| 负载 | load: 32 | Load | Resource pressure; qualify loading data separately. | quota for CPU or memory pressure | KEEP |
| 候选 | candidate: 33; candidates: 26 | Candidate | An option or match still awaiting selection or verification. | match for an unverified candidate | KEEP |
| 账单 | billing: 31; cost: 20 | Billing; cost | Provider charges and the money consumed by use. | quota for a monetary charge | KEEP |
| 沙箱 | sandbox: 30 | Sandbox | The native runtime boundary enforcing access restrictions. | task scope as a promise of isolation | KEEP |
| 错误 | error: 30 | Error | A failure that states what happened and the next useful action. | an error occurred without detail | KEEP |
| 环境 | environment: 30 | Environment | The runtime or cloud context where a task executes. | workspace for every runtime environment | KEEP |
| 分类 | category: 30; categorization: 30 | Category; categorization | A group and the action of placing items in groups. | folder unless it is the named chat-folder UI | KEEP |
| 上下文 | context: 30 | Context | Information supplied to help interpret the current task. | memory when the information is only temporary | KEEP |
| 工作区 | workspace: 31 | Workspace | The app workspace or a provider workspace, qualified by provider. | project as an automatic replacement | KEEP |
| 附件 | attachment: 33; attachments: 24 | Attachment | A file or image attached to a message. | upload before transfer succeeds | KEEP |
| 子任务 | subtask: 29; child: 26; parent: 23 | Subtask; parent task | Delegated work and the task that created it. | child without task or agent in ordinary instructions | KEEP |
| 余额 / 积分 | balance: 27; credit: 26; credits: 11 | Balance; credits | Money or provider credits available to spend. | quota for every monetary balance | KEEP |
| 调度 | scheduling: 27 | Scheduling | Choosing when work starts and how it gets capacity. | routing when only the start time changes | KEEP |
| 桌面 | desktop: 27 | Desktop | The installed desktop app or operating-system desktop. | web app for native-only actions | KEEP |
| 规则 | rule: 27; rules: 76 | Rule | A saved condition affecting routing or permission behavior. | policy when referring to a single user-authored rule | KEEP |
| 比较 | comparison: 26 | Comparison | Inspection of differences or similarities. | verification when comparing candidates only | KEEP |
| 网页 | web: 26 | Web | Browser-based content or an external agent surface. | cloud for every web page | KEEP |
| 终端 | terminal: 24; CLI: 79 | Terminal; CLI | The command window and the command-line interface used in it. | console for every app window | KEEP |
| 网络 | network: 23 | Network | Connectivity between computers or services. | internet when access may be local only | KEEP |
| 截止时间 | deadline: 22 | Deadline | The requested latest completion time, not a guarantee. | expiry for task scheduling | KEEP |
| 到期 | expiry: 24; expired: 26 | Expiry; expired | The end of validity for a credential or entitlement. | reset for a card expiry | KEEP |
| 事件 | event: 21; events: 22 | Event | A recorded runtime occurrence. | message for every event | KEEP |
| 指纹 | fingerprints: 22 | Fingerprint | A derived signature used to compare content or identities. | proof of identical content without verification | KEEP |
| 分组 | groups: 22 | Group | A set of related results or controls. | swarm for ordinary result groups | KEEP |
| 资源 | resources: 21 | Resources | Available machine capacity or required runtime assets. | quota when referring to RAM or CPU | KEEP |
| 平台 | platform: 22 | Platform | A provider or operating system; name which one. | provider when the text means Windows or macOS | KEEP |
| 重放 | replay: 21 | Replay | Repeat an earlier operation or recorded stream. | retry when already-completed external actions would be repeated | KEEP |
| 优先级 | priority: 21 | Priority | The relative order in which waiting work is considered. | deadline as a synonym | KEEP |
| 程序 | program: 21 | Program | An executable application. | executor unless it is an AI runtime | KEEP |
| 备注 / 笔记 | note: 20; notes: 20 | Note | Saved contextual information or an explanatory annotation. | memory for every note | KEEP |
| 引用 | quote: 21 | Quote | Selected text included with attribution or message context. | instruction for untrusted quoted content | KEEP |
| 标题 | title: 20 | Title | The visible name of a chat or item. | heading when it is an editable item name | KEEP |
| 地址 | address: 42 | Address | A service location or contact address, qualified by type. | path for a network endpoint | KEEP |
| 格式 | format: 22 | Format | The structure or encoding of content. | type when referring to visual presentation only | KEEP |
| 选择 | selection: 27 | Selection | The currently chosen items or text. | scope when it only describes a UI selection | KEEP |
| 步骤 | step: 42; steps: 28 | Step | One stage in a task plan or setup procedure. | task when it is only part of one task | KEEP |
| 请求 | request: 107 | Request | An instruction or service call asking for work. | message when no chat entry exists | KEEP |
| 内容 / 文字 | content: 101; text: 90 | Content; text | The material in a message or document; text excludes binary media. | copy when referring to user-provided material | KEEP |
| 时间 | time: 122 | Time | A timestamp or duration, explicitly distinguished by label and units. | time used without units for elapsed work | KEEP |
| 用户 | user: 136 | You; user in technical descriptions | The person using PugPort or a named external-service user. | the user when directly addressing the reader | KEEP |
| 审查 | review: 53 | Review | A separate inspection of work or claims. | verified before checks finish | KEEP |
| 刷新 | refresh: 59 | Refresh | Read current state again. | reset when data is only reloaded | KEEP |
| 重试 | retry: 58 | Retry | Attempt the failed operation again when safe. | replay when completed writes would be repeated | KEEP |
| 默认 | default: 37 | Default | The choice used unless a user selects another. | automatic when the choice is simply fixed by default | KEEP |
| 未完成 | incomplete: 30 | Incomplete | Work that ended without fulfilling the request. | completed merely because the process exited | KEEP |
| 不可用 | unavailable: 76 | Unavailable | A resource that cannot be used at this time. | missing when it exists but is temporarily unreachable | KEEP |
| 未知 | unknown: 61 | Unknown | Information that has not been reported or established. | zero for an unavailable measurement | KEEP |
| 失败 | failed: 120 | Failed | An attempted operation that did not succeed. | blocked when an actual execution failed | KEEP |
| 等待中 | waiting: 84 | Waiting | Work held until a specific dependency or decision is available. | running for a task awaiting resources | KEEP |
| 运行中 | running: 78 | Running | Work currently executing. | queued before execution starts | KEEP |
| 已完成 | completed: 70; done: 45 | Completed; done in compact status text | Work reported as finished, separate from independent verification. | verified without evidence | KEEP |
| 已停止 | stopped: 42 | Stopped | Work whose execution has ended before continuing. | completed for a cancelled task | KEEP |
| 有效 / 无效 | valid: 24; invalid: 64 | Valid; invalid | An input or credential that meets or fails its required checks. | unavailable for malformed input | KEEP |
| 已安装 | installed: 43 | Installed | A component present and set up locally. | downloaded when installation has not completed | KEEP |
| 叫（@-mention） / 栏 | call; column | Mention; pane | Mention participants; pane is one section within a window. | call for mentions; column for panes | Approved 2026-10-15 |

## Context and follow-up work

- The bare 对话 key is the Chats heading; its desktop notification fallback needs a separate Chat key. Use New chat, Rename chat, Delete chat and chat history elsewhere. Avoid repeated chat in the same sentence.
- Follow-up has three uses; keep their wording apart:
  - 补充 is a message sent to a running task (“Sent as a follow-up”);
  - 跟进 on pinned messages keeps “Follow-up status”, “To follow up” and “Track as a follow-up”;
  - 跟进 of an external agent's reply uses “Following”, “Stop following” and “Stopped following”.

  Steer/steering names the action or feature.

- 设备, 角色, 执行器, 技能 and 工具 still need separate singular/plural keys. For example, Devices is a settings/group heading and Device is one participant. Keep their existing values until the code split. The [fragment register](en-copy-fragments.md) records the source locations and other grammar/platform-name splits.
- Keep Recycle Bin (Windows), Trash (macOS) and Recently deleted (in-app) distinct. A sentence that hard-codes 回收站 needs a platform name supplied by code.
- README feature prose remains a later pass: Safe account relay, Mid-task corrections, native interjections, quota references, and conversation references outside actual control labels.
- Desktop acceptance remains separate: settings categories (including composer, sidebar, errors and toasts), tray resources at narrow widths, Quick chat, and background-task status/ETA. Check light and dark themes. Text checks do not establish visual fit.
- PROPOSED: "Permission ceiling" (权限上限) names what a dispatched run inherits from its dispatcher: write, network and local Git commits. "Work lane" (工作线) is unchanged.
