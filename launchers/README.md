# launchers/

The main Windows entry points stay at the repository root: `Setup-Windows.ps1` (once) and `Start-PugPort.cmd`.

| File | Platform | What it does |
| --- | --- | --- |
| `Start-PugPort.vbs` | Windows | Starts the source desktop without a console; failed launches show an error and write `.data/launchers/last-start.log` |
| `Start-Web.cmd` | Windows | Starts only the local backend; open <http://127.0.0.1:4317> |
| `Start-Pi.cmd` | Windows | Opens the bundled Pi CLI directly, outside PugPort |
| `setup-macos.sh`, `start-macos.command` | macOS | Install/check/build and start from source for local Mac validation |

`Setup-Windows.ps1` generates the same VBS at `.data/launchers/start-pugport.vbs`. Regenerate it with `.\.runtime\node.exe scripts/create-windows-launcher.mjs`; this does not launch the app or change desktop shortcuts. The script locates the checkout relative to itself. Existing `.lnk` targets still contain absolute paths and must be updated after moving the checkout.

## Platform status

| Platform | Status |
| --- | --- |
| Windows x64 | Supported |
| macOS | Desktop validation in progress; source startup and unsigned local `.app` packaging available. See the acceptance limits below |
| Linux | Not started. CI runs the tests for information only; a green check does not mean Linux works |

The code base is shared across platforms, so there are no per-platform source folders. The porting checklist is in [docs/MAC-PORT.md](../docs/MAC-PORT.md).
