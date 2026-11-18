# Grok image input

PugPort sends managed image attachments to the selected Grok ACP session as image
content blocks (`type`, `mimeType`, base64 `data`). Base64 belongs in the image
block, not in the text prompt. A pinned Grok account, model and effort stay pinned;
adding an image does not redirect the task to Claude or another executor.

## Verified compatibility

On 2026-10-05, the installed Grok CLI **1.0.46** returned
`promptCapabilities.image=false`, but accepted a standard ACP image block and
correctly identified four differently coloured shapes and their relative positions.
The test used a synthetic image, an empty temporary working directory, no MCP
servers, no tools and `dontAsk`. It made one model request to `grok-4.7`, with zero
tool calls. No user image was used.

The handshake identifies this version through
`_meta.grokShell=true` and `_meta.agentVersion=1.0.46`, not `agentInfo`.
The compatibility exception is exact-version only. Discovery advertises Grok image
input for this verified version; execution independently checks the handshake.
An explicit future `promptCapabilities.image=true` is accepted by the transport,
but a new version must also be verified in discovery before routing images to it.

Upstream reference:
[Grok prompt parser at 2bdd1d6](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/prompt_parser.rs#L135)
and
[native image insertion](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/acp_session_impl/turn.rs#L1230).

## Failure and continuation behavior

- Unsupported image input fails before a model turn. It never falls back to the
  legacy text-only command with images silently omitted.
- Native `image_dropped` closes tool access, cancels the turn and fails with a
  readable explanation. `image_compressed` produces a size-adjustment notice.
- Selected visual executors retain bounded, validated image history, including
  explicitly quoted older images. Conversation ownership checks remain in force.
- Text steering continues within the native session. A new message containing
  attachments is queued; the text-only steering protocol must not swallow images.
- OCR or another vision model is not required for this version. This change does
  not automatically forward images to a different model after a content refusal.

Regression coverage is in `grok-images.test.ts`, `attachments-workflow.test.ts`,
`attachment-policy.test.ts`, `attachments.test.ts` and `routing.test.ts`.
