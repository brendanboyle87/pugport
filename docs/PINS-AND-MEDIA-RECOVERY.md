# Conversation pins and media recovery

Messages can be pinned from their heading or right-click menu. The conversation keeps its original order; a slim tracker stays above the history scroller. Its list is collapsed by default and supports up to 20 pins. Clicking the summary opens the original message, including messages outside the initially rendered history. Pins persist independently from sidebar conversation pins and project folders.

Task tracking follows canonical message/workflow IDs, explicit continuation links and current local job state. It never uses matching text to associate different tasks. Missing state remains unknown. Selecting **Track as a follow-up** changes only the human record; it never completes, pauses or cancels the actual task. Follow-up choices are To follow up, Waiting for confirmation and Done. Refresh reads local conversation history without submitting a model request. A separate pin revision synchronizes windows without changing conversation recency.

The layout takes the one-line, click-to-original behavior from [Teams](https://support.microsoft.com/en-us/teams/chat/pin-a-chat-message-to-the-top-of-a-chat-in-microsoft-teams), and the expandable multiple-pin idea from [Telegram](https://telegram.org/blog/pinned-messages-locations-playlists). PugPort adds live local-task status and an explicit human follow-up mode. The existing color and icon system is retained.

## Media checkpoints

An inventory check on resume validates membership and file stamps. It does not discard saved fingerprints. Reused vectors do not count as new inference. Positive evidence is republished from its cache after freshness checks. Completed negative checks are now saved separately and keyed by the source stamps, feature identity, decoder, ordered anchors, sampling options and verifier version.

A negative checkpoint means the bounded sampling procedure has been completed. It is not proof that two entire videos contain no matching footage. An interrupted decode, a read error, a source change or cancellation does not create a reusable negative checkpoint. Old versions did not save these negative checks; work that was never saved cannot be recovered retroactively.

Verification workers claim the same queue from opposite ends, once per pair. Two baseline pairs retain the existing four-reader maximum. Explicit assistant lanes can add up to two single-reader pair checks under the same owner, queue, cache and checkpoint store. A mathematical bound rejects an offset early only when all remaining positions together cannot reach the existing four-match minimum. It does not prune a match that can still satisfy that rule.

Decoded frame signatures use a separate bounded table in the same checkpoint database. The key includes exact time, decoder/version, canonical source identity and nanosecond file stamps. Repeated reads share work only with the same abort signal. The cache stores small numerical signatures, not decoded image or video files. File changes and decode failures invalidate reuse.

## Temporary local verification copies

Fresh video pair checks can stage their inputs under `%LOCALAPPDATA%/PugPort/Cache/media-verification/<job-id>`. The current cache defaults to 8 GiB and preserves at least 4 GiB free. It copies only the video inputs needed by fresh pair checks, serializes source copies, and keeps the existing verification concurrency. Cached completed pairs do not trigger copies. A file reused by other remaining pairs can stay in the cache, subject to inactive LRU eviction; the last use releases it. The cache closes and cleans its owned files when a job completes or is paused.

The original files remain untouched. Evidence, pair checkpoints and frame-signature keys continue to refer to the originals. Async-local routing changes only physical video frame reads; concurrent pairs cannot redirect each other's decoder paths. Original and temporary-file identities are checked around copying and verification, and temporary-file identity is checked around every frame read before a signature can be cached. A source change, damaged copy or cancelled read cannot publish a reusable result. A bounded, cancellable stream copy avoids orphaned background copies on timeout.

When launched from a Windows packaged-app environment, [MSIX redirects AppData writes](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes). The cache accepts only the exact PugPort cache suffix mapped into `Packages/<package-family>/LocalCache/Local`, then validates the physical ancestors again. Ordinary junctions and unrelated aliases remain rejected.

Files too large for the cache, insufficient disk space or copy failures fall back to the original read path. Cleanup is restricted to files created in the cache's marked private namespace, including carefully identified leftovers from a dead owner; it does not send cache files to the user Recycle Bin or delete source media.

## Automatic recovery

Only jobs active during shutdown or a crash are eligible to recover. Explicit user/workflow pauses, cancellations, failures and completed jobs remain stopped. The bridge revalidates the original conversation, project and workflow ancestors, then resumes the same local job. It does not start a new scan or submit an agent run.

Desktop recovery is bounded to three attempts in one minute. It preserves the renderer and unsent drafts, renews its local session token, and confirms cleanup of the old owned children before starting a replacement backend. Windows requires process containment because terminating a parent does not automatically terminate its children. A bootstrap waits for an anonymous Windows Job Object guard before importing the server; identity is challenged through the original IPC channel and process birth time. Replacement waits for the previous job to have zero active processes and for the guard to exit successfully. A failed readiness handshake or timeout cleans the failed replacement too. Recovery must not attach to an unrelated HTTP server or act on a reused PID.

## Recycling

Candidate similarity and sparse full-span evidence remain separate from recycling proof. Existing recycling requires a fresh independent retained copy, original scope and full-byte or supported full-image confirmation. Partial overlap does not authorize recycling a short clip. Neither a checkpoint nor a queue-direction change expands deletion authority.

## Explicit delegated accounts

Delegating to a named account such as **Second Grok** retains the account resolved by `resolveAgent`. Delegating to a generic platform such as **Grok** still permits automatic account selection. The old extra step that stripped an explicit account's runtime ID has been removed; model/effort selection for each child, session routing rules and existing quota relay remain independent.

## Dynamic assistant scheduling and progress

Two scoped assistant owners may claim the existing queue from the tail; they cannot submit arbitrary paths, shell commands or evidence. Starting a model session is separate from local decoding. Once attached, local checks continue without a model request for every pair. A stopped assistant returns only its unfinished claim. The parent joins late attachments before closing shared staging. Restarted assistants are interrupted records, including when their parent was explicitly paused.

The local governor samples whole-machine CPU, available memory, staging backlog and copying every five seconds. It permits zero to two extra checks. In-flight checks finish normally when the budget falls. Sustained healthy samples increase the budget; CPU above 92%, critically low free memory and repeated staging backlog reduce it. This is a tested scheduling envelope, not a measurement of the hardware's maximum capacity. Throughput comparisons exclude reused pair checks and require at least 90% matching work composition in both windows before they can reduce the budget for a slowdown.

The conversation progress card shows the combined candidate-pair count, each assistant's actual tail checks, CPU/free memory and current assistant concurrency. Candidate evidence, read/verification errors and incomplete enumeration appear separately. Actual concurrency can temporarily exceed the newly reduced target while previously admitted checks finish. Unknown or unstable estimates remain hidden. A completed batch posts its scope and limits in the same conversation; it is not a claim that all possible matches on the drive were exhaustively checked or that every evidence row was recycled.

Ready staged pairs no longer wait for an unrelated source copy. Successful checks consume references immediately; inactive private-copy cleanup may finish after the shared copy gate clears. Failed or interrupted verification still joins cleanup, and cache shutdown waits for all owned operations. Staging counters are in-memory measurements and do not add filesystem scans to the governor.
