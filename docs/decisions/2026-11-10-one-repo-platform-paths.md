# Windows and Mac share one repository and one `main`, separated by path

Date: 2026-11-10
Owner ruling: approved on 2026-11-10 in a planning task; no issue was created.

Decision: Windows, macOS and later Linux work stay in one repository on one `main`. Changes are classed by path as Windows-only, Mac-only, POSIX, platform core or shared, and each class decides which operating-system checks a change must pass. No separate repository or long-lived branch per operating system.

Reason: separate repositories or branches would make every shared change land twice and let the two sides drift. Path classes let a Mac-only change merge without waiting on Windows and the reverse, while shared code is checked on both.

Scope: repository layout, branch flow, labels and checks. A feature added for one operating system must leave the others' behaviour unchanged, with the difference behind `src/server/platform/*` helpers. This record does not decide how outside contributions are received, signing, releases, or any repository setting. It does not authorize pushing, merging or publishing.

Replaces: none. It confirms "Keep one shared source tree" in [MAC-PORT §2](../MAC-PORT.md#2-design-decisions).
