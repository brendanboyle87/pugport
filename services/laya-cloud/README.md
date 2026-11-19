# Task Router cloud inference service

This service runs the `pugport-laya-v4` checkpoint in one process on an Apple Silicon Mac. It loads the model once at startup and listens only on `127.0.0.1:8787`. Cloudflare Tunnel supplies the public HTTPS endpoint. The service does not collect training samples, use Supabase, or change the PugPort client.

The backend matches `scripts/laya-mac-bench.py`: `laya.load(..., backend="eager", fast=False, compile=False)`, FP32 model weights, disabled AMP, and `torch.float32`. `LAYA_DEVICE` defaults to `mps`; `cpu` is also supported. There is no automatic device fallback. The checkpoint must be a complete local directory; offline model loading is enforced by the shared worker configuration.

## Install on an Apple Silicon Mac

Use native arm64 Python 3.12 and the complete repository layout. The service imports `valid_state` and `pack_state` from `scripts/laya-worker.py`, so copying only `app.py` is insufficient. Keep checkpoint files outside the repository.

```sh
mkdir -p "$HOME/pugport-laya/logs"
chmod 700 "$HOME/pugport-laya/logs"
python3.12 -m venv "$HOME/pugport-laya/venv"
"$HOME/pugport-laya/venv/bin/python" -m pip install -r "$HOME/pugport-laya/repo/services/laya-cloud/requirements.txt"
```

The direct dependency pins are Laya 0.4.15, PyTorch 2.15.0, Transformers 5.22.0, and Uvicorn 0.54.0. The model stack matches the Mac benchmark record; this service still needs a target-host acceptance run. PyPI metadata was checked on 2026-10-30, including a CPython 3.12 macOS arm64 wheel for [PyTorch 2.15.0](https://pypi.org/project/torch/2.15.0/), plus [Laya](https://pypi.org/project/laya/0.4.15/), [Transformers](https://pypi.org/project/transformers/5.22.0/), and [Uvicorn](https://pypi.org/project/uvicorn/0.54.0/). Transitive dependencies are not a fully locked environment.

## Run and check

```sh
export LAYA_CHECKPOINT="$HOME/pugport-laya/models/pugport-laya-v4"
export LAYA_DEVICE=mps
export LAYA_PORT=8787
"$HOME/pugport-laya/venv/bin/python" -B "$HOME/pugport-laya/repo/services/laya-cloud/app.py"
```

Run the entry point above, which fixes the host to loopback and the worker count to one and disables server request diagnostics. Do not start extra Uvicorn workers or enable access/debug logs. One worker owns the model, queue, and rate counters. `LAYA_CHECKPOINT` is required; `LAYA_PORT` is optional and must be 1–65535.

From another local terminal, use synthetic input only:

```sh
curl --fail http://127.0.0.1:8787/healthz
curl --fail http://127.0.0.1:8787/v1/judge \
  -H 'Content-Type: application/json' \
  -H 'CF-IPCountry: CA' \
  --data '{"state":{"message":"Translate hello to French.","recent_context":"","reference_text":"","attachments":[],"candidate_executors":[]}}'
```

`GET /healthz` returns `modelVersion`, `device`, and the number of waiting requests as `queueLength`. It does not run the model or consume the judge rate limit. It returns 503 until startup finishes or while shutting down.

`POST /v1/judge` accepts exactly `{"state": ...}`. The state has exactly the worker's five keys: `message`, `recent_context`, `reference_text`, `attachments`, and `candidate_executors`. The shared worker validates all field limits. The streamed request body is limited to 64 KiB, including JSON whitespace, independently of Content-Length. Duplicate keys at any level, unknown keys, nonstandard numeric constants, malformed JSON, and invalid UTF-8 are rejected.

A successful response contains `modelVersion`, the actual loaded `model.safetensors` SHA-256 as `modelSha256`, `device`, end-to-end `latencyMs` including queue time, the unmodified prediction fields in `raw` with the worker's packing metadata merged into `raw.usage`, and `region`. The state budget is the minimum `laya.common.state_room` across checkpoint `questions.json`, using the same tokenizer and defaults as the worker.

The EU/EEA countries plus Switzerland and the United Kingdom map to `region: "eu"`; other or missing Cloudflare country values map to `"other"`. This value does not authorize collection. The future collection endpoint must enforce its own consent rules.

## Queue, rate limit, and privacy

There is one active inference and room for eight waiting requests. Packing and prediction share the same model lock. A full queue returns 503 with `Retry-After`. Client disconnects remove waiting work immediately. A disconnected or canceled active request retains its model slot until the underlying inference ends; the next prediction cannot overlap it. Shutdown also waits for an active inference to finish. A hung model call therefore requires process recovery.

Judge requests are limited to 120 per rolling minute per `CF-Connecting-IP`; missing or invalid values share the peer IP bucket. The limiter retains at most 4,096 clients and expires inactive buckets after one minute. At capacity it returns 503 without evicting live limits; an exhausted client returns 429. Both include `Retry-After`. Counters reset on process restart.

Cloudflare headers are trusted only because this listener is loopback-only behind the local Tunnel connector. Do not expose it directly or proxy untrusted client-supplied Cloudflare headers. Other local processes can reach the listener and supply those headers; this service does not provide local-process authentication. Tunnel setup and target-host acceptance are separate deployment work.

The service persists no request bodies, predictions, IP addresses, samples, or exception text. Request state and the IP rate counters exist only in memory. Model stdout, stderr, and Python logging are suppressed while loading and predicting. Errors return fixed codes without tracebacks. Uvicorn access logs and request diagnostics are disabled by the entry point. Each application log line contains only:

```json
{
  "timestamp": "2026-10-30T00:00:00+00:00",
  "status": 200,
  "latencyMs": 275.1,
  "packedTokenCount": 300,
  "country": "CA"
}
```

Country values are restricted to two ASCII letters; invalid values become `XX`. A disconnected request is logged with status 499. Avoid HTTP payload tracing, debug middleware, and external body logging when deploying the Tunnel.

## launchd

The template is `deploy/com.pugport.laya.plist`. Replace every `REPLACE_USER` with the Mac account name and adjust the repository/checkpoint paths if necessary. launchd does not expand `~` or shell variables inside this file. The template uses `~/pugport-laya/venv`, the repository layout above, and separate log files under `~/pugport-laya/logs`.

After reviewing the substituted file:

```sh
plutil -lint "$HOME/pugport-laya/repo/services/laya-cloud/deploy/com.pugport.laya.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cp "$HOME/pugport-laya/repo/services/laya-cloud/deploy/com.pugport.laya.plist" "$HOME/Library/LaunchAgents/com.pugport.laya.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.pugport.laya.plist"
curl --fail http://127.0.0.1:8787/healthz
```

This is a per-user LaunchAgent. It starts in the user's login session; unattended boot behavior and Mac sleep settings must be verified separately. `KeepAlive` restarts an exited process, with a 30-second throttle.

## Update the checkpoint

Place a complete new checkpoint in a new directory. Do not overwrite files used by the running process. Verify its source and expected SHA-256 before switching. Keep the old directory for rollback. The service validates the ten question definitions, hashes `model.safetensors`, and gives that hash to Laya's loader. The response reports that hash rather than a hard-coded value.

Stop the LaunchAgent, change `LAYA_CHECKPOINT` in the installed plist to the new directory, lint it, and bootstrap again. Check health and run a synthetic judge request; compare `modelSha256` with the expected file hash. To roll back, stop it and restore the previous checkpoint path. Startup failures intentionally omit exception details; verify paths, environment, dependency installation, and device availability locally without enabling request-body logging.

## Rotate logs

Rotate during a maintenance window so launchd reopens the files. Renaming a live log alone leaves the running process writing to the old file.

```sh
launchctl bootout "gui/$(id -u)/com.pugport.laya"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
for name in service service-error; do
  path="$HOME/pugport-laya/logs/$name.log"
  if [ -f "$path" ]; then mv "$path" "$HOME/pugport-laya/logs/$name.$stamp.log"; fi
done
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.pugport.laya.plist"
curl --fail http://127.0.0.1:8787/healthz
```

Review disk use and remove old rotated files according to the host's retention policy. Logs contain operational aggregates only; they are not a training store.

## Local model-free tests

From the repository root, these tests need only Python's standard library. They inject a fake agent and tokenizer; they neither import Torch/Laya nor make network requests or load a checkpoint.

```sh
python -B -m unittest discover -s tests -p laya_cloud_test.py
```

The public test seam is `Runtime(agent, questions, state_budget, model_sha256, device="cpu", inference_context=nullcontext, synchronize=lambda: None)` and `create_app(runtime=...)`. Call `await app.startup()` and `await app.shutdown()`, or drive its ASGI lifespan. `runtime_factory` can replace startup loading, and `clock` and `log_sink` support deterministic rate and privacy checks. Production always uses the default loader.

Model-free tests do not establish MPS numerical parity, production latency, launchd behavior, Tunnel routing, or target-host dependency compatibility. Those need a separate acceptance run on the target Mac.

## Training samples and database migration

The PugPort app sends samples directly to Supabase using its public publishable key. No database key or delete token belongs on the Mac service. Migration [`0002_laya_samples.sql`](../../supabase/migrations/0002_laya_samples.sql) creates two RLS-protected tables with no direct privileges for `anon` or `authenticated`. Only these RPCs are granted to those roles:

| RPC                   | Arguments                                                                                 | Result                    |
| --------------------- | ----------------------------------------------------------------------------------------- | ------------------------- |
| `submit_laya_sample`  | `install_id uuid`, `token text`, `model_version text`, `app_version text`, `sample jsonb` | Inserted sample UUID      |
| `delete_laya_samples` | `install_id uuid`, `token text`                                                           | Number of deleted samples |

The client generates an installation UUID and 32 cryptographically random bytes for a delete token, encoded as hex or base64url, and retains both locally. Tokens must be 32–512 UTF-8 bytes; the database stores only hex SHA256 of the UTF-8 token. The first upload registers the installation. Later uploads and deletions must match its token. A wrong, missing, invalid, or unknown-install delete token returns `INVALID_LAYA_TOKEN`.

The sample limit is 65,536 UTF-8 bytes of PostgreSQL's normalized `jsonb::text`, which can be larger than compact JSON sent over HTTP. Oversize samples return `LAYA_SAMPLE_TOO_LARGE`; SQL NULL returns `INVALID_LAYA_SAMPLE`. Each installation may upload 500 samples in a rolling 24 hours; excess uploads return `LAYA_SAMPLE_QUOTA_EXCEEDED`. Per-installation row locking serializes registration, quota checks, and deletion, and quota timestamps are taken after the lock is acquired.

Deletion removes the installation's samples and installation row. The client must stop and clear pending uploads before deleting: a later upload can register the installation again. Other installations are unaffected. The public key does not provide a global abuse quota; this migration implements only the requested per-installation cap.

### Retention scheduling

The migration deliberately does not enable `pg_cron` or change server configuration. **An owner-controlled daily schedule is required** to execute:

```sql
select public.delete_expired_laya_samples();
```

This owner-only function deletes samples older than two years and returns the count. Use an existing owner database scheduler (including an already configured `pg_cron`) or an external owner-controlled job. Retention is not automatic until that job is configured. Installation hashes remain until token-authenticated deletion, so expiration does not silently reset token ownership. Neither RPC grants client access to the cleanup function.

### Disposable PostgreSQL checks

[`tests/laya_samples_test.sql`](../../tests/laya_samples_test.sql) checks permissions, RLS, hashing, byte limits, quotas, deletion, retention, and concurrent transactions. It requires a fresh PostgreSQL 14+ database, the standard `dblink` extension, and local owner authentication. Never run it on the real project. On a disposable database, bootstrap the Supabase role names, apply only this migration, and run the tests:

```sh
psql -X -v ON_ERROR_STOP=1 -c 'create role anon; create role authenticated; create role service_role;'
psql -X -v ON_ERROR_STOP=1 -f supabase/migrations/0002_laya_samples.sql
psql -X -v ON_ERROR_STOP=1 -f tests/laya_samples_test.sql
```

The migration received static and independent review in this batch. These database tests were not executed here because no local PostgreSQL server or running Docker daemon was available. Applying the migration and scheduling retention are separate deployment work; the Mac deployment does neither.
