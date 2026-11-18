# Routing

When you leave the executor picker on **Automatic**, PugPort chooses the account card, model and reasoning effort for each run using local rules and live usage readings — never an extra paid model call.

## How PugPort paces subscription windows

Many subscriptions enforce one or more rolling usage windows (for example, a 5-hour window plus a 7-day window, or model-specific windows). PugPort compares accounts using two signals on windows longer than 6 hours:

### Straight-line pacing

For each non-short usage window (longer than 6 hours) with a known reset time, PugPort draws a straight line from 100% at the start of the window to 0% at the reset time:

- **Ideal remaining usage (`ideal`)** is the percentage that would be left right now if you spent usage at a steady rate until reset.
- **Usable remaining usage (`left`)** is `100% - usedPercent - max(5, reserve) * running tasks`; with reset cards, it is `100 * (1 + cards) - used - max(5, reserve) * running tasks`.
- **Pace ratio (`pace.value`)** is `left / max(ideal, 1)`.
  - A ratio **above `1.0`** means the account is **behind its straight-line spend** — it has more usage left than steady spending requires, so routing prefers to use it.
  - A ratio **below `1.0`** means the account is **ahead of pace** — it has been used faster than the straight line, so routing lets it rest when another account is on pace.
  - Accounts within 20% of the highest pace value are treated as roughly tied on pace.

### Predicted waste before reset

Using local usage history, PugPort also estimates whether an account will still have unused capacity left when its window resets. If one account is projected to waste usage at reset (in steps of 10% or more) while another won't, routing prioritizes the account whose usage would otherwise expire unused.

### Reserve percentage and 5-hour windows

In **Settings** → **Smart routing** → **Usage limit policy**, **Usage reserve** (`reservePercent`) keeps a safety buffer on each non-short window:

- Normally, automatic routing stops assigning work to an account once its remaining usage hits your reserve percentage.
- Within **24 hours** of a window's reset, the reserve relaxes to at most **2%**.
- Within the final **6 hours** before reset, the reserve drops to **0%** so you can finish the remaining usage before it resets.
- Short windows (6 hours or shorter, such as 5-hour windows) don't hold back a blanket reserve percentage, but if a 5-hour window has **5% or less** left, PugPort redirects long tasks (or high-effort tasks) to another account so the short window doesn't trip mid-run.

## Reset cards

For Codex accounts that report live reset credits (`codexRateLimits`):

- **How reset cards affect pacing** — each available, non-expired reset card adds 100% capacity (`1 + cards`) to the straight-line calculation, and if the earliest card expires before the window resets, PugPort uses the card's expiry time as the pacing deadline so the current window plus the card are spent before the card expires.
- **Automatic redemption** — if you turn on **Auto-use a reset card at the usage limit** in **Settings** → **Smart routing** → **Usage limit policy**, PugPort automatically redeems the earliest-expiring card on a native ChatGPT-authenticated Codex account in two cases:
  1. A task is waiting and the account has reached its reserve line.
  2. A reset card will expire within **24 hours** and the account has already used more than **50%** of its current window (`remaining < 50%`).

## Expiring API credit and its window

Pay-as-you-go API cards are skipped during normal automatic routing so PugPort doesn't spend money when you still have subscription usage available. The exception is **expiring API credit**:

- When you configure a local budget on an API card with a dollar limit (`limitUsd`), an expiry time (`expiresAt`), and **Prefer it and speed up near expiry** (`preferExpiring`), PugPort paces that credit over a **14-day window** before expiry (starting at `max(startedAt, expiresAt - 14 days)`).
- At any point in that window, `plannedUsd` is the straight-line amount that should have been spent by now.
- Whenever `spentUsd < plannedUsd`, the API card gets positive catch-up priority (`(plannedUsd - spentUsd) / limitUsd`), enters automatic selection alongside subscriptions, and scales up its allowed catch-up concurrency (up to your configured burst limit) as expiry approaches (`normal` > 7 days left, `priority` ≤ 7 days, `accelerated` ≤ 3 days, `sprint` < 1 day).

## Keeping the prompt cache warm and yielding when ahead of pace

### Staying on the same account for prompt cache warmth

Provider prompt caches stay warm for about **5 minutes** (`cacheTtlMs = 5 * 60_000`). When you send a follow-up in an existing conversation:

- PugPort prefers to stay on the account card that holds the conversation's native session so the provider can reuse its warm prompt cache instead of re-reading the whole conversation on a different account.
- If that account just finished a run within the last **5 seconds** and its post-run usage reading is still settling, PugPort waits briefly (~5 seconds) for that card rather than jumping to another account.

### When a continued chat moves to another account

A continued conversation moves off its current account when:

1. **The current account hits its usage limit, reserve line or technical cooldown**, or can't satisfy a new requirement (such as image input or a newly pinned model).
2. **The current account yields because it is ahead of pace** (`pace.value < yieldBelow`) while another account of the same model tier is on pace (`pace.value >= 1.0`). The threshold `yieldBelow` depends on cache warmth and context size:
   - **Cold cache (≥ 5 minutes since last run) or a new task under 50,000 tokens:** `yieldBelow = 1.0` (yields as soon as it falls ahead of the straight line).
   - **Warm cache (< 5 minutes) on the same task, or with ≥ 50,000 tokens:** `yieldBelow = 0.7` (stays on the warm account until its pace ratio drops below `0.7`).
   - **Warm cache (< 5 minutes) with a large context (≥ 200,000 tokens):** `yieldBelow = 0.5` (stays on the warm account even longer to avoid re-sending 200k+ tokens).
3. **Expiring API credit needs catch-up on a new task:** if your follow-up starts a new task in the chat, the warm session is under 200,000 tokens, and an expiring API credit is at least **`$50`** behind its straight-line schedule (`newTaskSwitchUsd = 50`), routing switches to that API card.

When PugPort moves a continued conversation to another account, it carries over a verified handoff summary and recent conversation context.

## Cooldown after repeated technical failures

When an executor fails with a technical error (`runtime-network-error`, `runtime-timeout`, `runtime-process-closed` or `runtime-protocol-incompatible`):

- PugPort increments that card's consecutive technical failure streak and places the card in a **technical cooldown** for **1 minute**, **5 minutes**, **15 minutes**, then **60 minutes** (`[1, 5, 15, 60]` minutes for streaks 1, 2, 3 and 4+).
- While a card is in cooldown, **automatic routing skips it** and routes work to your other available accounts (recording the streak count and the `HH:MM` cooldown expiry time in the route reasons).
- If you **explicitly pin** that card yourself, PugPort still runs your task on it so you can test or force a retry.
- As soon as a run completes on that card, its failure streak and cooldown clear immediately.

Free preset cards do not enter technical cooldown.

## Cursor as a multi-model card

Cursor subscriptions work differently from single-vendor CLIs because one Cursor account can run models from several families across two separate usage pools:

- **Cursor Models pool (`cursor`)** — Cursor's own models (`Composer`) and hosted `Grok` models (`Grok 4.5 / 4.6 / 4.7`).
- **Other Models pool (`other`)** — frontier models from OpenAI (`GPT`), Anthropic (`Claude`), Google (`Gemini`), DeepSeek, Kimi and GLM.
- **`Auto` (`dynamic`)** — Cursor's dynamic router, which checks both pools. Models marked `NO ZDR` or newly discovered unverified models are never picked automatically.

How PugPort routes with Cursor:

1. **Choosing between Cursor pools** — when Cursor is selected without a pinned model, **light** tasks prefer the **Cursor Models** pool (`Composer`) to save your frontier pool for harder work; **strong** tasks prefer **Other Models**; **standard** tasks compare the two pools' straight-line pace and headroom, and switch to the other pool if the preferred pool is within **10%** of its reserve line.
2. **Same-model fallback through Cursor (`cursorFallback`)** — if a task is aimed at Claude, Codex or Grok, and all of your native accounts for that service are below their reserve line or in technical cooldown, PugPort can run the **same model family through your Cursor card** (provided the task has no image attachments and isn't classified as adult content). You can turn this fallback off on the Cursor card.

A referenced brief outside the project is treated as unknown size, selecting the strong tier. Routing also counts a stated number of files when estimating task size.

## Routing profiles and rules

Open **Settings** → **Smart routing** to configure **Routing profiles**:

- **Up to 30 named profiles** — create profiles for different kinds of work (for example, daily coding, fiction writing, or budget saving) and pick one in the chat composer footer or set it as a project's default in **Project settings**. Choosing **Automatic (global and conversation rules)** uses your global and per-chat rules.
- **Natural-language rule parser** — type or dictate your preferences in plain language under **Describe your rules** and click **Turn into rules** (or **Parse again**). PugPort parses them locally without calling a model.
- **Task categories** — built-in categories are **Code** (`code`), **Writing** (`writing`), **Translation** (`translation`), **Images** (`vision`), **Research** (`research`), **Adult content** (`adult`) and **Everything else** (`other`), plus up to 30 custom keyword categories and fiction-writing roles (`chapterAgents`, `mask`, `coordinator`, `merger`).
- **Ordered candidates & Enforce (`strict`)** — each rule holds up to 8 candidates (a provider or a specific account card, plus an optional model and effort).
  - Under **Rule candidate selection**, choose whether available candidates are picked **Use candidate order** (`ordered`) or **Compare usage left across available candidates** (`quota`).
  - Turn on **Enforce** (`strict`) when a category must never fall back outside its candidate list. (Low-confidence category matches skip strict rules, except for `adult` content rules which always hold.)

## Pinning an executor or model, and excluding models

- **Pinning** — picking an executor card, model or reasoning effort in the composer footer (or mentioning `@Executor` in your message) pins that choice. A pin overrides soft routing rules and technical cooldowns; an explicit account pin remains binding on a usage-limit handoff. A technical failure can trigger a relay to another executor, with a notice explaining the change.
- **Excluding executors** — in **Settings** → **Smart routing** → **Automatic routing** → **Executors allowed for automatic routing**, uncheck any account card you want automatic routing to leave alone. You can still call unchecked cards manually with `@` or the executor picker.
- **Excluding models** — in a routing profile's **Exclude these models from automatic selection** field, enter comma-separated model IDs or `*` wildcards (for example `claude-opus-*, gpt-5-pro`). Excluded models are skipped during automatic selection and automatic handoff, while a model you explicitly pin in the composer still runs.

## Reading the route reasons shown for a run

Open any run in **Run history** (or click the run badge on a reply) to see why PugPort picked that account and model:

- **Account and model summary** — shows the account card used, its identity, the model and effort, and whether the run executed in tool-less mode or was handed off from another card (`From <card> → <card>`).
- **Route reasons (`reasons`)** — lists each step of the decision in order:
  - **Task classification & tier** — the detected category (`code`, `writing`, `research`, etc.), complexity score, and target model tier (`light`, `standard` or `strong`).
  - **Rule or pin match** — whether the choice came from a manual pin, a routing profile rule, or automatic selection.
  - **Cache & pacing** — whether PugPort stayed on the current account to keep the prompt cache warm, yielded to another account that was on pace, prioritized predicted waste before reset, used a reset-card pace calculation, or prioritized expiring API credit.
  - **Skipped candidates & warnings** — why other cards were passed over (for example, below the reserve percentage, 5-hour window under 5%, in technical cooldown until `HH:MM`, or skipped as a pay-as-you-go API card while subscriptions had usage left).
