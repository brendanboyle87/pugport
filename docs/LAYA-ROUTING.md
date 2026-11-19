# Task Router routing and review records

Task Router v4 provides routing advice. PugPort still owns executor availability, explicit user selections, strict routing rules, account quotas, permission ceilings, budgets and the actual execution. Model output never grants a tool or write permission. Conflicting advice is discarded. Compacted input has a separate, bounded parallel assessment path described below; ordinary fallback does not call a second classifier.

## Settings and runtime

Open **Settings → Advanced → Routing advice**. The inference service is off on a fresh installation until you supply the absolute Python executable and checkpoint directories. The checkpoint is not distributed with PugPort. The Python worker is local, offline and persistent; it warms the model before declaring itself ready. It verifies the fixed v4 weight digest and does not download models or install dependencies.

The supported runtime currently requires CUDA. Missing CUDA, invalid files, loading, a busy worker or a failed prediction immediately falls back to local rules. Each ready-worker prediction has a 1.5-second deadline; startup runs separately in the background. There is no inference queue and no per-message reload. Changing the runtime configuration stops only PugPort's own worker. No existing AI subscription or API key is used by this classifier.

Input separates the current message, up to four recent trusted messages, quoted reference text, attachment names/types and the dynamic executor directory. It never reads attachment contents. The worker calculates a shared state budget from all ten question heads, then packs input before inference. It retains the beginning and end of the current question/reference, recent context and bounded metadata, rather than silently discarding the final question. Original messages are not rewritten into a different task. Explicit assignment/exclusion parsing is deliberately narrow; conditional or ambiguous instructions are recorded as conflicts. Project read-only and command prohibition can narrow existing authority, never expand it.

Advice about task type and difficulty is used only where normal automatic routing has left a choice open. Human model/effort pins and approved/strict routes remain authoritative. Search, document and media judgments are retained for review; they do not by themselves enable unavailable capabilities or authorize an action. This first integration is not a guarantee that every one of the ten heads is correct.

### Long input and parallel assessment

Packing, an underlying truncation flag, or a request exceeding the classifier's byte limit makes the classification incomplete. Its task-type/difficulty choices are not trusted for routing. Automatic routing provisionally requests a strong tier and high effort, subject to the existing account/model constraints. This is a resource precaution, not a claim that all long messages are difficult.

After the foreground run starts, a separate tool-less, read-only assessment may run if execution capacity remains. It receives the full current question and quotations, bounded recent context, and attachment metadata. It uses normal routing and budgets, has a 30-second deadline, cannot call tools or delegate, and never changes the active answering model. Valid advice applies only to subsequent unstarted steps. Explicitly selected routes, continuations, delegated/coordinator tasks and inputs larger than 128,000 characters skip this assessment; unavailable capacity, cancellation or invalid output leaves the provisional advice intact. Disabling Task Router also disables this long-input assessment path. The auxiliary run can consume ordinary executor/API allowance; it is not a second local Task Router prediction.

`raw.usage` records `input_compacted`, original and packed state token counts, the state budget and changed fields. `source_compacted` records transport-level shortening of the current question/quotations. `outcome.assessment` links the auxiliary run, its status, advice and reason. The record retains the original policy separately from the final routes, so a reviewer can distinguish an initial decision from later advice.

Command prohibition is enforced at the shared bridge and native adapter boundary. It closes opaque external tools as well as command helpers. Cursor uses its native read-only mode for this restriction, which also limits native file editing; Grok closes its MCP tool path. These are explicit restrictions on that turn, not new account defaults. Native CLI implementations are tested with synthetic protocol fixtures; this does not certify third-party CLIs against arbitrary malicious behavior.

## Fixed local record directory

**Save local routing records for review and model training** is checked by default. It saves data locally; it does not upload, export or train a model. Turning it off stops new records and preserves old ones. Incognito chats, delegated worker messages and background-triggered prompts are excluded. Mid-task user supplements are logged as `origin: steering`; their predictions are for review and do not reroute the already-running executor.

The directory is always `<PugPort dataDir>/routing-training/`, independent of the source checkout. The layout is:

```text
<dataDir>\routing-training\
  2026-10-26\
    <message UUID>.json
  2026-10-27\
    <message UUID>.json
```

Dates use local time from the message's saved timestamp. Open the fixed folder from the Task Router settings panel. The record ID is `YYYY-MM-DD/UUID`, stable across retries of the same message. New user messages get distinct IDs even if their wording repeats. Do not use the wording alone as an identity.

Each JSON record includes the user question, exact bounded classifier input, v4 version/digest, prediction/probabilities, constraints and conflicts, fallback reason, and final executor/model/effort routes. An initial queued placeholder is filled once after judgment; it is not a second sample. Later retries cannot overwrite an existing real observation or reset its training status. Final route/outcome evidence may still update as the task finishes. `capture.redacted` and `capture.truncated` identify credential redaction and capture limits. These are raw observations, not approved training labels; the classifier's own prediction must not be treated as ground truth.

Known credential patterns are redacted, and limits are marked explicitly. Redaction is not a complete personal-data anonymizer. The files may contain private question/context text. They are application data, outside the Git repository, and must be reviewed before a manual export. Permanently clearing a project's PugPort data also deletes its routing records while preserving the linked source directory.

## Review and avoiding duplicate training

Use these states, in order:

1. `pending`: a new observation waiting for review.
2. `reviewed`: a reviewer corrected and approved the expected output.
3. `reserved`: a training/export batch claims the reviewed record using a unique `batchId`.
4. `used`: that batch successfully used the record, with its `modelVersion` recorded. This state is terminal.

`excluded` keeps unsuitable data out of training. Reservation release requires the same batch ID and returns the sample to `reviewed`. A different batch cannot take a reservation or mark it used. Repeated calls from the same batch are idempotent. A crash does not automatically release reservations: reconcile the original batch before releasing it. A multi-record transition is atomic per file, not one transaction over the whole batch; reread IDs after any interrupted transition.

Never train directly from all dated files. Select reviewed samples, deduplicate by task/template cluster, keep translations and related variants in one split, reserve the IDs, export to the training package, and mark them `used` only after the actual training succeeds. Used and excluded IDs must stay out of future exports. An agent can resume an interrupted batch by its stable ID. No automated export or training is started by PugPort.

The local HTTP API requires the UI session token for reads and writes:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/laya/status` | Runtime state, settings, fixed folder and recording error |
| `GET /api/laya/records?date=2026-10-26&status=reviewed&limit=200` | Bounded date/status selection |
| `POST /api/laya/records/transition` | `{ids, status, batchId?, modelVersion?}` |
| `DELETE /api/laya/records` | Clear only local routing records |
| `PATCH /api/settings` | `{laya: {enabled?, recordTraining?, pythonPath?, checkpointPath?}}` |

Do not print or embed the session token in reports. Retrieval is limited to 200 records per request; use date filters rather than assuming a truncated response covers every sample. Files remain directly readable by date when a larger offline review is needed.

## Verification boundaries

The default test suite uses synthetic model/CLI responses and temporary data directories. Real local GPU inference is a separate smoke check; it must not start paid executor tasks, train a model or read user secrets. Keep real smoke output and dated acceptance counts outside the tracked source tree. CPU fallback performance and other operating systems are not certified by a Windows/CUDA smoke result.
