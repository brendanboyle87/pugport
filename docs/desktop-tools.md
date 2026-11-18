# Desktop terminal and browser

The conversation's desktop tools panel contains a local terminal, an embedded browser, and an explicit connection to an already running Chrome debugging service. It is available on demand in ordinary and project conversations. It does not create an AI task or submit terminal text to a model.

## Local terminal

The terminal starts in the directory confirmed by the backend for that conversation. The renderer supplies only the conversation ID, never a shell command, environment or working directory. Windows uses PowerShell without a profile; other systems use the configured absolute shell path or `/bin/sh`.

This is a human-operated shell with the user's normal local permissions, not an AI read-only workspace. Input and output stay in the desktop process and its owning window. There is no persistent transcript or model/tool audit attachment. A bounded in-memory buffer supports attachment to the current terminal; large output is batched and older output can be dropped. Switching between the panel's tabs or the collaboration panel keeps the terminal running. Explicitly closing the desktop panel, closing its window, or a renderer crash ends that owned terminal. Open terminals participate in the application's quit confirmation.

The native implementation is `node-pty` 1.1.0. Windows uses the package's bundled ConPTY DLL to avoid the older PID-list cleanup helper. The distribution must include the matching native package and its binaries; an unavailable native component produces an error rather than a fake terminal. Hidden Windows Electron testing covers an actual shell, input/output, and exit. macOS/Linux native execution and their final packages require validation on those systems.

## Embedded browser

Electron owns a `WebContentsView`; the application renderer owns only the navigation controls and reports its visible bounds. Each conversation has a separate persistent browsing partition. Incognito conversations use a new in-memory partition and clear that storage on close. Embedded pages receive no PugPort preload, Node integration or desktop IPC API.

Navigation accepts HTTP and HTTPS. The session blocks PugPort's server port, local files, downloads, and device permissions. These checks also apply to redirects, frames and subresources. A new-window link stays in the owned view. The view is hidden when another panel tab, application menu or modal is in front. Closing a view retains the ordinary conversation's browsing storage, but removes the live page.

This does not turn the embedded browser into a model tool. The existing `test_page` tool and configured MCP servers keep their separate permission and audit paths.

## Existing Chrome

The user supplies an explicit local HTTP debugging origin such as `http://127.0.0.1:9222`. The panel contacts only `/json/version`, `/json/list` and an explicitly selected `/json/activate/<id>`. It shows up to 100 page targets. Refresh and activation re-read the current target list; disconnect cancels outstanding requests and does not close Chrome.

The panel does not launch Chrome, change its debugging flags, read a browser profile, read cookies, or automatically grant model access. Chrome must already expose the debugging service; an unavailable service is reported as a connection failure.

For model access, the panel can show a reviewable configuration for the official `chrome-devtools-mcp@1.12.0` using `--browser-url` and `--no-usage-statistics`. The user imports and authorizes this separately through the existing Extensions UI. Project MCP selection and global enablement still apply. Merely generating this configuration does not verify a live Chrome/model interaction.

## Dependencies and sources

- [xterm.js 6.0.0](https://www.npmjs.com/package/@xterm/xterm/v/6.0.0), MIT, and [FitAddon 0.11.0](https://www.npmjs.com/package/@xterm/addon-fit/v/0.11.0), MIT. Used through their public APIs; notices are retained in `licenses/xterm-MIT.txt` and `licenses/xterm-addon-fit-MIT.txt`. [Official addon guide](https://xtermjs.org/docs/guides/using-addons/).
- [node-pty 1.1.0](https://www.npmjs.com/package/node-pty/v/1.1.0), MIT with bundled component notices in the package's complete `LICENSE`. It was already a transitive MXC dependency and is now a direct dependency.
- [Electron WebContentsView API](https://www.electronjs.org/docs/latest/api/web-contents-view). Electron is an existing dependency.
- [Official Chrome DevTools MCP configuration](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md). Its Apache-2.0 package is only named in an optional user-reviewed configuration; this feature does not install or bundle it.

The implementation uses PugPort's existing desktop bridge and permission boundaries. No Orca source was copied.

## Focused checks

`tests/desktop-tools.test.ts` covers sender ownership, path resolution, bounded terminal input/output, window-crash races, browser isolation and layout, private browsing, explicit Chrome targeting, and disconnect cancellation. `tests/desktop-tools-renderer.test.ts` runs a hidden real Electron window with a real native PTY, a synthetic local web page, and a synthetic CDP HTTP service. It checks tab switching, hiding and restoring retained tools, the private-app boundary, terminal exit, and close/reopen races during pending opens. `tests/project-workflow-integration-renderer.test.ts` exercises the actual Studio entry points, collaboration forms, and preservation of both composer and work-form drafts. These checks do not use a real Chrome profile, external website or model account. Application-shell regressions remain covered by the existing desktop navigation and link tests.
