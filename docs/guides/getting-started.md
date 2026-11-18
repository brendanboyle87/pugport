# Getting started

PugPort brings your AI command-line tools and API keys into one desktop workspace. It runs the official CLIs you already use, checks real usage limits from each service, and routes each task to an account with usage left.

## Install from source

You need at least one executor signed in (Claude Code, Codex CLI, Grok CLI or Cursor CLI) or an API key. See [Platform support](../PLATFORMS.md) and [Cross-platform notes](../CROSS-PLATFORM.md) for current platform status.

### Windows (x64)

Windows x64 is the primary desktop target. Install Node.js `24.21.0` or newer and npm. Claude Code on Windows also needs Git for Windows.

```powershell
git clone https://github.com/pugport/pugport.git
cd pugport
.\Setup-Windows.ps1
.\Start-PugPort.cmd
```

If PowerShell blocks the script, inspect it first, then run `powershell -ExecutionPolicy Bypass -File .\Setup-Windows.ps1` for that session only.

`Setup-Windows.ps1` copies your local `node.exe` into `.runtime\node.exe`, runs `npm.cmd ci`, installs and brands the local Electron binary, runs `typecheck`, `test:ci` and `build`, and creates a desktop shortcut. Pass `-WithLocalComponents` if you also want to download the optional local models during setup (`setup:markitdown` for document conversion, `setup:voice` ~240 MB, `setup:memory-search` ~590 MB, `setup:image-search` ~210 MB).

Other Windows launchers in the checkout:

- `Start-PugPort.cmd` (or `launchers\Start-PugPort.vbs` without a console window) — starts the Electron desktop app, building first if `dist\electron\main.cjs` is missing.
- `launchers\Start-Web.cmd` — starts only the local server and opens `http://127.0.0.1:4317` in your browser.
- `npm.cmd run package:desktop` — packages an unpacked Windows desktop build under `release\`.

### macOS

macOS requires native Node.js 24 LTS (`24.21.0+`) and Git. On Apple Silicon, use an `arm64` Node binary and run setup on the Mac itself — don't copy `node_modules` or `.runtime` from Windows.

```sh
git clone https://github.com/pugport/pugport.git
cd pugport
bash launchers/setup-macos.sh
bash launchers/start-macos.command
```

`launchers/setup-macos.sh` runs `npm ci`, installs the Electron binary, and runs `typecheck`, `test:ci` and `build`. To build a local unsigned `.app` bundle after building, run `npm run package:desktop` (outputs `release/PugPort-darwin-arm64/PugPort.app` on Apple Silicon, or `darwin-x64` on Intel). See [Mac desktop status](../MAC-PORT.md).

### Linux

The Electron desktop isn't verified on Linux yet. Linux `x64` and `arm64` machines are supported as headless device nodes and SSH-connected remote servers:

```sh
git clone https://github.com/pugport/pugport.git
cd pugport
npm ci
npm run build
./dist/bin/pugport node install
```

See [Remote servers and devices](remote-servers-and-devices.md) for pairing a Linux machine or connecting one from the **Usage** page.

## First launch and where data lives

When you start PugPort:

- The desktop backend listens on `127.0.0.1:4317` by default. If another program holds port `4317` (and you didn't set `COMBORUNNER_PORT` or `AGENT_STUDIO_PORT`), the desktop app picks a free loopback port and writes it to `desktop-endpoint.json` (`%USERPROFILE%\.pugport\desktop-endpoint.json` on Windows, `~/Library/Application Support/PugPort/desktop-endpoint.json` on macOS, `~/.local/share/pugport/desktop-endpoint.json` on Linux) so the `pugport` CLI and MCP server can find it.
- Closing the window hides PugPort to the system tray so running and queued tasks continue. Choose **Quit PugPort** in the tray menu to exit completely.
- Local data lives in `.data/` for source checkouts, `%APPDATA%\ComboRunner\data` for packaged Windows builds, or the path in `COMBORUNNER_DATA_DIR`. To keep a source checkout's database outside OneDrive or another cloud-synced folder, quit PugPort, copy `.data` to a local folder (such as `C:\PugPortData`) that already contains `studio.sqlite`, and write `{ "dataDir": "C:\\PugPortData" }` to `.data/data-location.json`.

If no account is ready yet, the workspace banner shows **Connect account** so you can set one up right away without losing anything you typed in the composer.

## Adding accounts

Open **Usage & connections** in the sidebar and select the **Connections** tab (or click **Connect account** from the workspace banner).

### Native CLI subscriptions

PugPort automatically scans your computer for official CLIs on startup and when you click **Refresh**:

- **Codex** (`codex`)
- **Claude** (`claude`)
- **Grok** (`grok`)
- **Cursor** (`cursor-agent`)

Installed CLIs appear automatically with their sign-in state, detected models and usage limits. Missing default CLIs stay out of the main list; click **Install or connect a client** to install or connect one.

### Second subscription accounts

If you pay for more than one subscription on the same service (for example, two Codex or Claude accounts), you can connect each one as its own card:

1. Open **Usage & connections** → **Connections** and click **Add**.
2. Under **Subscription accounts**, pick the service (`Codex`, `Claude`, `Grok` or `Cursor`), give the card a name (such as `Second Codex`), and create it. (Adding a second Cursor account requires Windows; terminal sign-in for isolated accounts is supported on Windows and macOS.)
3. Click **Sign in**. PugPort creates an isolated home directory under `<dataDir>/accounts/<id>` and opens the official CLI sign-in in a terminal window so your main CLI sign-in is untouched.
4. Once you finish signing in, PugPort checks the account automatically. If you accidentally sign in with the same identity as another card on the same service, PugPort flags the duplicate on the card.

You can rename any account card, turn it off with its switch without deleting its sign-in, or remove it. Removing an isolated account offers two choices: move its credentials folder to the system Recycle Bin / Trash, or type the card's name to delete its credentials permanently.

### API keys and custom endpoints

To add a pay-as-you-go API key or a free model endpoint:

1. Open **Usage & connections** → **Connections** → **Add**.
2. Choose **API** for paid providers (`DeepSeek`, `Meta Model API`, `OpenAI`, `Anthropic`, `xAI`, `Google Gemini`, `OpenRouter`, `Kimi (Moonshot)`, `Kimi (International)`, `Zhipu GLM`, `Qwen`, `MiniMax`, `Mistral` or `Custom API`), or **Free** for free/local endpoints (`Ollama`, `LM Studio`, `OpenRouter`, `Gemini`, `Groq`, `GitHub Models` or `Custom URL`).
3. Enter your API key and optional model. Your API key is stored in a separate file per account in the private per-user secrets directory (outside the synced data folder) and is never echoed back to the browser after saving.
4. For **Anthropic**, if your key isn't bound to a single workspace, expand the card settings and fill in **Workspace ID (optional)** (`wrkspc_…`).
5. For **Custom API**, pick the wire protocol (**Azure OpenAI Responses**, **OpenAI Responses**, **OpenAI Chat Completions** or **Anthropic Messages**), enter the base URL and model/deployment name, and optionally enter input/output prices (USD per 1M tokens) so PugPort can calculate spend. On macOS you can also set the context window and the output limit per reply under **Context and output limits (optional)**; left blank, and on every other system, they stay at 32,768 and 4,096 tokens. A model that reasons before it answers spends reasoning and answer from the same output limit, so give it 32,768 or more.
6. Optionally set a local budget on any API card: budget cap in USD, expiry time, per-run limit, concurrency cap, burst concurrency, and **Prefer it and speed up near expiry** so automatic routing spends expiring promotional credits before they expire.

Meta Model API defaults to `muse-spark-1.3` and offers only the four standard text models: `muse-wonder-1.0`, `muse-spark-1.3`, `muse-spark-1.2` and `muse-spark-1.1`. API usage is billed by Meta separately from your Muse web login. Use [Meta’s developer site](https://dev.meta.ai/) for API keys and billing. Contributor and multimedia models are excluded.

### Bots (`Muse` and `Grok Bot`)

Under **Usage & connections** → **Connections** → **Add** → **Bot**, you can add **Muse** (Meta's web chat) or **Grok Bot**. They stay out of your account list unless you add them, and you can call them in chat with `@@Muse` or `@@Grok Bot`.

## The Usage page

Open **Usage & connections** to see three tabs: **Quota**, **Spend**, and **Connections**.

### Usage limits and connections

- **Account cards** — shows each enabled subscription card, API card with a budget, and bot.
- **What each card shows** — connection status (**Ready**, **Sign-in required**, **Connection error** or **Not installed**), each usage limit window (5-hour, daily, weekly, monthly, or model-specific windows) with its remaining percentage and reset countdown, available Codex reset cards, Cursor model-pool bars and credits, and Grok billing/credits.
- **Details** — expand **Details** on any card to see the subscription plan, account identity fingerprint, usage source, environment (`Local` vs `WSL`), last update time, manual reset-time overrides, and the **Test connection** button in the **Connections** tab.
- **Devices** and **Remote servers** — below your account cards, PugPort lists paired Tailscale device nodes and servers from `remote-servers.json` with their CPU, memory, disk, service health and days left before expiry.

### Spend

Switch to **Spend** to inspect consumption and execution health from your local ledger:

- Filter by **Time range** (**24h**, **7d**, **30d**, or **All**), **Execution** (**All**, **CLI**, or **API**), **Project**, and **Executor**. Every chart and table uses the same filters.
- Review spend, successful tasks, cache share, failures, run time and fallbacks with sample coverage. Subscription reference cost stays separate from pay-per-use spend.
- Inspect trends and executor/model details, then use **By task**, **By project**, or **Per call** below for individual records.
