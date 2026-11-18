# Routing rules: design

Status: evolving design. Named profiles, project defaults and explicit conversation overrides are implemented; see [Managed child workspaces and project routing](managed-child-workspaces.md). Source/time selectors below remain proposals unless separately identified as implemented.

PugPort's promise is that one window uses every AI account the user pays for, with nothing wasted. Smart
routing does that by default. Users will also want fixed assignments ("code goes to Codex", "keep Claude B for
evenings", "Slack questions use the cheap model"). This document fixes where such rules live, so they can grow
without spreading through the router.

## Today

### Automatic executor checklist

Settings' normal routing section lists enabled executor cards with provider marks, plan badges and checkboxes.
All cards are allowed until a checklist is saved. `Settings.automaticExecutors` stores card IDs; an optional
`ConversationRouting.automaticExecutors` replaces that global list for every task in the conversation.
Both settings editors refuse a selection with no enabled card and explain why. Cards remain enabled and can
still be explicitly selected.

External `dispatch_task` / `POST /api/external/tasks` and `send_message` accept `executors` and `exclude` arrays
of exact card names or providers. Names are resolved and validated before creating a task. `executors` replaces
the inherited conversation/global checklist; `exclude` subtracts from that list. Unknown names are errors.
An empty automatic pool is refused unless the task explicitly pins an executor.

Precedence: explicit executor pin (`@@`, composer selection, dispatch `agent`) > task checklist > conversation
checklist > global checklist. Internal selections carry `automaticExecutorSelection`, so topic rules,
planners, waste scoring, quota/technical/content relays, member allocation and cross-review cannot bypass this
stage-one hard filter by inserting a runtime/provider pin. Automatically named swarm members obey it too;
participants the user explicitly called remain callable. Generic children and reviewers do not inherit the
parent's pin exemption. When all allowed cards lack quota, existing waiting/reporting behavior remains.
Routing explains skipped cards with `Excluded by checklist: Claude`; it never silently widens the checklist.

Every entry point ends in the same pipeline:

```
desktop composer ─┐
terminal (pugport)─┤
MCP dispatch_task ─┼─> workspace.send ─> one-for-all policy ─> controller.start ─> routing.route()
Slack (external)  ─┤      (MessageInput)   (intent, task judgment)                (RouteDecision)
agent delegate    ─┘
```

Inside `routing.route()` (`src/server/routing.ts`) the decision is made in one pass, `routeOnce`:

1. **Hard filters**: enabled and installed executors, `executionPolicy` (cli-only / cli-first / api-only),
   explicit `runtimeId` / `provider` / `model` (the @ pin), excluded providers on relay, capabilities (images,
   writes, adult content, tool-less execution for requests carrying other people's words: `untrustedContent`
   needs `capabilities.toolless`), schedule windows, API budgets that are exhausted or expired.
2. **Category preference**: `routePolicy(settings)[category]` (`src/shared/route-policy.ts`) orders platforms per
   task category; legacy `designProvider` / `architectureProvider` / `routineProvider` fill gaps.
3. **Scoring**: quota headroom (`scarceHeadroom`), reset opportunity (use quota that resets soon), expiring API
   credit priority (`apiBudgetState` phases), account health cooldowns, quota reservations of running tasks,
   CLI-before-API when CLI headroom is healthy. Right after the reset opportunity comes predicted waste
   (`src/server/quota-waste.ts`): what an account's longest window, or a time-limited API credit, will still have
   unused at its reset at that account's usual pace (quota history), damped while history is short; it never counts
   for a model below the requested tier, and a continued conversation keeps its native session's account.
   Codex reset cards also count toward waste: only cards that are available, give a full reset and have a valid
   future expiry are considered. Using the same consumption pace and `n/(n+1)` history damping, PugPort predicts, in
   order of earliest expiry, whether each card can be used when any window has 15% left, taking into account normal
   window resets and a previous card restoring every window. Each card that cannot be used adds 100 window
   percentage points times the confidence to the existing waste; with several windows the lowest confidence applies,
   and if any window lacks enough consumption evidence no card waste is predicted. A next window of unknown length
   is treated as one where the card can be used. Expired cards, unknown cards and cards that would be used anyway add
   no waste. When accounts on the same platform tie on tier, native continuation, waste and actual quota, the one
   with an available card gets a single spare-capacity preference; this does not add to its current quota or
   concurrency slots. Pinned executors, user rules, reserve lines and API budget checks still run first.
   These predictions and this ordering never read the auto-use switch and never redeem a card. The route reason
   states the number of wasted cards, the earliest expiry and why the account is used more first.
   The auto-use switch `autoUseResetCards` is off by default and controls redemption on its own: either a real
   pending request would still be routed to that account by normal routing once its quota is restored, and the
   relevant window is used up; or the earliest valid card expires within 24 hours and less than 50% of the quota is
   left. Before redeeming, PugPort checks the conditions and the switch again against a fresh server reading.
   Redemptions run one at a time per account and their state is persisted; the next card becomes usable only after
   fresh quota and card readings arrive. Automatic uses are shown on the account card.
   Before the final expiry phases, a capped API credit with an expiry may precede CLI-first only when its predicted
   unused amount is at least max($10, 10% of the credit left), it passes every capability, budget, concurrency and
   tool-less check, and every CLI candidate it would displace has measured zero waste. Unknown CLI waste does not
   qualify. Pins, chosen
   platforms, category rules, native continuation and reserve lines still hold for this earlier waste preference.
   The existing final expiry phases (within seven days, three days and under one day) still precede CLI-first as
   a last safety net, independently of predicted waste. Sub-tasks also get a per-account member allowance
   (`memberAllowance` in `src/server/member-allocation.ts`: more members on an account with more quota left or
   resetting soon, fewer while it recovers from a rate limit) and go to the account with the lightest load against
   its allowance. The swarm coordinator asks for the strongest tier; read-only members prefer the light tier.
   When PugPort picks a Cursor model itself (never a pinned one), `chooseCursorPool`
   (`src/shared/cursor-models.ts`) picks the quota pool: light work starts in Cursor's own pool (Composer, Grok),
   hard work in the frontier pool (Claude, GPT, Gemini…), ordinary work in the pool with more left; a pool near its
   reserve gives way to a healthier one, and Auto comes last.
4. **Fallback**: technical fallback to the same platform, then Cursor's fallback pool, then any platform; relay
   after a run fails for quota or content reasons. A pinned executor's quota fallback to Cursor keeps its model
   family (Grok stays Grok, Claude stays Claude), whatever the task's difficulty. Adult content routed to Grok may use Grok through Cursor when
   native Grok cannot take it. A Codex or Claude content refusal goes down `Controller.contentRelay`: native Grok →
   Grok through Cursor → GLM through Cursor, skipping steps that cannot run, at most two relays per message, never
   for anything involving minors, images or a resumed session. Any other provider policy block (`provider-refused`:
   Anthropic's refusal or Usage Policy block, OpenAI/Azure content filters, xAI, Gemini, DeepSeek, Moonshot, Zhipu
   moderation) goes down `Controller.refusalRelay`: ordinary automatic routing picks the next executor from a
   model vendor not yet tried (an Anthropic API refusal also rules out Claude Code and Cursor's Claude models), so
   the checklist and pin-only billed API cards still hold; at most three vendors per message, and the final
   note lists each provider's reason. A pinned executor or card that refuses moves on too (design decision,
   2026-10-30) and the chat says the pinned choice refused; pinning one billed card never allows another, even
   under API-only. Routes the user confirmed before they ran are not switched.

What makes rules hard to add today:

- Preferences live in several places (route policy, three legacy settings, `schedule.preferExpiringQuota`, API
  budget phases, `executionPolicy`), each read at a different point of `routeOnce`.
- A request does not say where it came from, so no rule can match "from Slack" or "from the terminal".
- A decision explains itself only through scattered notes and rejection strings.

## Target

Keep the four stages, but give each one a single home and make user rules data, evaluated in one place.

```
RouteRequest (+ source) ─> 1 hard constraints ─> 2 user rules ─> 3 smart scoring ─> 4 fallback ─> RouteDecision
                           (never overridden)    (data, ordered)  (quota, expiry,    (relay)       (+ reasons[])
                                                                   health)
```

### Rule model

```ts
type RoutingRule = {
  id: string;
  enabled: boolean;
  label: string; // shown in the UI and in explanations: "Code goes to Codex"
  when: {
    category?: RouteCategory[]; // design / architecture / general / routine / mature
    source?: Array<'desktop' | 'terminal' | 'slack' | 'mcp' | 'agent'>;
    project?: string[]; // project paths
    time?: { days?: number[]; from: string; to: string }; // local time window
  };
  then: {
    require?: string[]; // route keys ('codex', 'api:deepseek') or runtime ids; nothing else may run it
    prefer?: string[]; // try these first, in order, while they have quota
    avoid?: string[]; // skip unless nothing else can run it
    reserve?: { runtimeId: string; keepPercent: number }; // leave headroom on an account
  };
  /** When a `require` cannot be met: wait for quota, or fall back to smart routing. */
  unmet?: 'wait' | 'fallback';
};
```

Semantics, fixed so they never need re-litigating:

- Rules never override stage 1. A rule that requires an executor without image support does not get images.
- Rules are evaluated top to bottom; every matching rule applies. Precedence within the result:
  `require` > `avoid` > `prefer`. Two `require` rules that conflict make the request unroutable with an
  explanation, not a silent pick.
- `prefer` only reorders; stage 3 still skips an account with no quota left. That keeps "nothing wasted" true
  even with rules.
- An @ pin on one message beats every rule for that message.
- The existing route policy becomes built-in rules (one per category), migrated once; the legacy provider
  settings are folded in and removed.

### One module

`src/server/routing-rules.ts`, pure and synchronous:

```ts
applyRules(request: RouteRequest, rules: RoutingRule[], candidates: Candidate[], now: number):
  { candidates: Candidate[]; waitUntil?: number; reasons: string[] }
```

`routeOnce` calls it once, between the hard filters and scoring. No other file reads rule data.

### Source tagging

`MessageInput` and `RunInput` gain `source`. Each entry point sets it once: the desktop composer `desktop`,
`pugport` `terminal`, the MCP server `mcp`, the Slack gateway `slack`, delegated sub-tasks `agent`. Workflows keep
it so the UI can show it and rules can match it.

### Explanations

`RouteDecision` gains `reasons: string[]`, written by each stage in plain words, for example
`Rule "Code goes to Codex" → Codex B (weekly quota 61% left)`. The reply's persona label, the run record and the
terminal footer all show the first reason; the run record shows all of them.

### Storage and UI

- Rules are stored in settings as `routingRules` with a schema version; validated with zod on write.
- UI: one ordered list under conversation settings, created from templates (by task type, by source, by time,
  keep an account in reserve). No free-form editor in the first version.

### Tests

Golden tests: fixture snapshots + rules + request → expected executor and reasons. The rule engine is pure, so
these run in milliseconds and cover precedence, unmet behaviour, time windows and migration.

## Plan

1. `source` plumbing and `RouteDecision.reasons` (no behaviour change).
2. Extract `applyRules` from `routeOnce`; migrate route policy to built-in rules (no behaviour change, proven by
   the existing routing tests plus golden tests).
3. Rules UI with templates.
4. Time-window and reserve rules.

Each step ships on its own and leaves routing behaviour unchanged until the user adds a rule.
