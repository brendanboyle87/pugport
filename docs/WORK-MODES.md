# Work modes: Normal, Mods author and Navigator

A chat can work in one of three modes. Pick it with the **mode chip**, the small icon next to **+** in the composer.

- **Normal** shows only the icon. Chats and tasks work as usual.
- **Mods author** builds and debugs a PugPort Mod in this chat.
- **Navigator** has a lead that plans, hands out the work, reviews it and sums up. Sub-tasks do the actual work.

The mode is saved on the chat. A change applies from your next message: a running or queued task keeps the mode it started with, so the chip is locked while a turn is running. There is no settings page and no global default. A new chat starts in Normal. Side chats and work lanes have no mode. A forked chat keeps its mode.

Choose **×** on the chip, or **Normal** in its menu, to go back.

## What a mode changes

Each mode adds one block of instructions to what PugPort sends the executor, right after your personal instructions. Project rules, your current request, tool permissions and the permission ceiling always win over it; the block grants nothing.

The block is never a message. It doesn't reach chat history, local memory files (`history.jsonl`, `handoff.md`), Hindsight, project rules, the history search index or Task Router's routing input. It appears only in the run's own record of the prompt it received. A test guard checks this.

## Mods author

Start one with **Extensions › Mods › Create a Mod**, or switch any ordinary chat to Mods author with the mode chip. Then describe the Mod you want.

### The folder

The first message creates the chat's own folder, `mods-workspace/<id>` in PugPort's data folder. PugPort puts its reference files in `.pugport/`:

- `MOD-SPEC.md`: the Mod interface, sections 1–6 and 9 of the [Mods author guide](MODS.md)
- `pugport-mod.d.ts`: the `window.pugport` API
- `example/`: the Reading notes example

The Mod itself is the usual author layout: `manifest.json` (without `ui`), `README.md` and `ui/<entry>.html` with optional `.css` and `.js`.

The executor runs in this folder and may write to it, even when the message would otherwise be read-only. It writes nowhere else.

To build somewhere else, open the mode menu and choose **Folder: … · Change…**. PugPort accepts an empty folder, or a folder that already has the author layout. It refuses a folder inside a project you added, or inside PugPort's data folder outside `mods-workspace`. PugPort never runs anything from the folder, including a `package.json` build script: Mods that have their own build scripts keep building their own way.

### Load and debug

The executor calls `mod_load` when a version is ready. PugPort then:

1. packs the folder,
2. checks the manifest and reports problems with their field paths,
3. installs the result on this computer and
4. shows it in this chat.

If a new permission needs your approval (model use, voice or bank connections), the Mod is saved but not installed until you choose **Allow and load** on the card in the chat. The executor can't approve permissions. `mod_load` runs at most once every 10 seconds.

While a Local build is open, the Mod bar has a **Debug** menu:

- **Reload frame**
- **Errors · Logs** since the last load, with the latest errors
- **Permissions** and whether they're approved
- **Manifest valid** with any warnings from the last load
- **Send to chat**, which puts a short digest in the composer as a draft; you decide whether to send it

You don't need to send anything for the executor to see errors. Errors, console lines and refused requests from the Mod frame reach the next turn automatically, in a block of at most 4 KiB marked as observations, not instructions. The executor can also call `mod_debug` for the full list.

### In the Store

The **Loaded** tab marks a Mod built this way with **Local build** and the chat it was built in, plus **Edit in chat · Open folder · Export JSON**. **Edit in chat** opens the original chat; if that chat was deleted, it opens a new Mods author chat for the same folder. For a Mod you imported as JSON, **Edit in chat** in its details unpacks the JSON into a new Mods author chat's folder.

Deleting the chat or uninstalling the Mod never deletes its folder. Nothing is ever published: **Export JSON** gives you the packed file to share yourself.

## Navigator

In Navigator mode, the chat's main task is a lead. It understands the request, writes a short plan (`set_plan`), hands every part to a sub-task (`delegate`, `delegate_many`), reviews the results with reviewer sub-tasks, sums up and reports the outcome. It doesn't edit files or run commands itself. A greeting or a trivial question gets a direct answer, with no plan and no sub-tasks.

- **The lead is read-only.** Its own run can't change anything; file-changing tools are hidden from it.
- **Sub-tasks follow your permission.** In a chat where you allow changes, the lead gives implementation sub-tasks write access with their files. In a read-only chat, sub-tasks can't write either.
- **Project chats** become swarm chats, with the Swarm view and swarm limits. **Everyday chats** turn on collaboration, with the smaller family limits (12 sub-tasks, 3 running at once). Leaving Navigator restores the chat as it was. Incognito everyday chats can't use Navigator.
- **Runs on.** In the mode menu, **Runs on: Auto · Choose…** picks the executor, model and reasoning effort for the lead, with the same controls as the message route. The chip shows the choice, for example *Navigator · Opus 5.5 · High*. When that executor can't take a turn (it's cooling down, out of usage or not installed), PugPort uses another one and says so in the route note. Your choice stays saved. An executor you pick for a single message still wins, and sub-tasks always choose their own.
- **Strongest tier.** The lead uses the strongest model tier and higher effort, except for a greeting.

If a project rule contradicts the mode, for example “always edit files yourself”, the project rule wins. The lead still can't write, so it delegates.

See also: [Mods author guide](MODS.md) and [Task Router](LAYA-ROUTING.md).
