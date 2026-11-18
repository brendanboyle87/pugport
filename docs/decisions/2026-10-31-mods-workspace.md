# Mods own the workspace

The host provides the workspace and chat drawer described below.

Owner clarification, 2026-11-01: PugPort sets no design rules for Mods. Third-party
authors may style them however they like; only the interface contract in the
[author guide](../MODS.md) must match. This supersedes the earlier author styling
and store artwork guidance. Host behavior remains unchanged.

## Layout and ownership

- A visible web `mainView` fills its owning pane below one 32px host bar (the
  title-bar height, with the platform title-bar environment value when available).
  The bar contains the Mod identity, Chat toggle and a menu for details, hiding
  and removal. The existing left navigation stays intact.
- Chat is a 400px right drawer, limited to the available width. The existing
  message list, draft and send path stay mounted in their original component;
  closing the drawer hides them without losing drafts. Escape closes it and
  returns focus to Chat. Inserting a draft opens and focuses the drawer.
- A package containing `mainView` and companion panels uses only `mainView`
  while visible. Companion surfaces remain mounted but hidden, preserving
  unsaved state; hiding the Mod hides all its surfaces and restores plain chat.
  Packages with only right/sidebar panels retain their existing layout.
- First-pane ownership remains window-local, including pop-outs. The Mod never
  relocates a chat or changes its project. Store Open reuses the most recently
  attached eligible chat, or creates an ordinary chat and attaches the Mod.
  New attachments record their attachment time; older bindings fall back to the
  instance creation time because their historical attachment order is unknown.
  Opening checks the expected instance again before changing visibility.

## States and interaction

Loading occupies the surface until the bridge handshake; failure offers a short
message and Reload. Hidden frames retain local state but report visibility false.
Host theme changes reach all mounted frames. A microphone session retains its
existing host-owned Stop indicator for safety; this is session feedback, not a
second navigation toolbar.

The drawer uses a short rightward slide, buttons retain the existing pressed and
focus feedback, and store details have a quiet entrance. Reduced motion removes
these transitions. Keyboard users can reach all actions; focus cannot disappear
behind an overlay. Layouts are inspected at 760px and at wide desktop widths in
both themes. Frames flex exactly into their available area without fixed minimum
heights or decorative gutters.

## Store and authoring

The store uses optional card art in the grid and cover art in details. Missing
card art uses a centred crop of the cover. Image validation enforces the technical
limits documented in the author guide. Validation failures never become
user-facing JSON.

Authors can use `mainView` and `ui.chat({open})`. Host theme tokens are optional
data that a Mod may use or ignore.
`host.info().layout` describes the slot; the `chat` event reports drawer state.
Companion slots return `E_UNAVAILABLE` for `ui.chat`. No other new capability or
permission is introduced, and existing state revisions remain unchanged.
