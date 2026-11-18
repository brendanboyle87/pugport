"""Loopback-only Laya ASGI service. Request text exists only in memory."""

import asyncio
import atexit
from collections import OrderedDict, deque
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager, nullcontext, redirect_stderr, redirect_stdout, suppress
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import importlib.util
import ipaddress
import json
import logging
import math
import os
from pathlib import Path
import sys
import threading
import time


ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("laya_cloud_worker", ROOT / "scripts/laya-worker.py")
worker = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(worker)
MODEL_VERSION = worker.MODEL_VERSION
MAX_BODY = worker.MAX_INPUT
KEEPWARM_SECONDS = 60.0
MAX_QUEUE_WAIT_SECONDS = 2.5
EU_COUNTRIES = frozenset("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO CH GB".split())
_output_lock = threading.RLock()
# Keep aggregate logs usable while native model writes to stdout/stderr are silenced.
_audit_stream = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
atexit.register(_audit_stream.close)


@contextmanager
def quiet_model():
    # Python redirects miss native writes and handlers that retained an older stderr.
    with _output_lock:
        previous = logging.root.manager.disable
        logging.disable(sys.maxsize)
        saved = []
        saved_streams = (sys.stdout, sys.stderr, sys.__stdout__, sys.__stderr__)
        try:
            with open(os.devnull, "w", encoding="utf-8") as quiet:
                for descriptor in (1, 2):
                    backup = os.dup(descriptor)
                    saved.append((descriptor, backup))
                    os.dup2(quiet.fileno(), descriptor)
                with redirect_stdout(quiet), redirect_stderr(quiet):
                    yield
        finally:
            for stream in saved_streams:
                with suppress(Exception):
                    stream.flush()
            for descriptor, backup in reversed(saved):
                os.dup2(backup, descriptor)
                os.close(backup)
            logging.disable(previous)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_key")
        result[key] = value
    return result


def _invalid_constant(_value):
    raise ValueError("invalid_number")


def strict_json(body):
    return json.loads(body.decode("utf-8"), object_pairs_hook=_unique_object,
                      parse_constant=_invalid_constant)


@dataclass
class Runtime:
    agent: object
    questions: dict
    state_budget: int
    model_sha256: str
    device: str = "cpu"
    inference_context: object = nullcontext
    synchronize: object = lambda: None
    _lock: object = field(default_factory=threading.Lock, repr=False)

    def predict(self, state):
        with self._lock, quiet_model(), self.inference_context():
            packed, packing = worker.pack_state(state, self.agent.tok, self.state_budget)
            raw = self.agent.predict(packed, self.questions)
            raw.setdefault("usage", {}).update(packing)
            self.synchronize()
            # Validate inside the protected worker, without surfacing model exceptions.
            if len(json.dumps(raw, ensure_ascii=False, allow_nan=False).encode("utf-8")) > worker.MAX_OUTPUT:
                raise ValueError("output_too_large")
            return raw, packing["packed_state_tokens"]


def load_runtime():
    """Load exactly once at startup; imports stay lazy for model-free local tests."""
    with quiet_model():
        checkpoint = Path(os.environ["LAYA_CHECKPOINT"]).expanduser().resolve(strict=True)
        device = os.environ.get("LAYA_DEVICE", "mps")
        if device not in {"mps", "cpu"}:
            raise ValueError("invalid_device")
        question_file = checkpoint / "questions.json"
        with question_file.open("rb") as handle:
            question_bytes = handle.read(MAX_BODY + 1)
        if len(question_bytes) > MAX_BODY:
            raise ValueError("questions_too_large")
        questions = strict_json(question_bytes)
        if not isinstance(questions, dict) or set(questions) != set(worker.CHOICES):
            raise ValueError("invalid_questions")
        for key, choices in worker.CHOICES.items():
            question = questions[key]
            if (not isinstance(question, dict) or question.get("type") != "choice"
                    or not isinstance(question.get("criteria"), dict)
                    or set(question["criteria"]) != set(choices)):
                raise ValueError("invalid_questions")
        with (checkpoint / "model.safetensors").open("rb") as handle:
            model_sha256 = hashlib.file_digest(handle, "sha256").hexdigest()
        import torch
        import laya
        from laya.common import state_room

        torch.set_num_threads(4)
        agent = laya.load(str(checkpoint), device=device, backend="eager", fast=False,
                          compile=False, expected_sha256={"model.safetensors": model_sha256})
        if agent.device.type != device:
            raise RuntimeError("device_mismatch")
        agent.model.float()
        agent.amp_enabled = False
        agent.dtype = torch.float32
        state_budget = min(state_room(agent.tok, agent._to_internal(question),
                                     agent.cfg.get("max_len", 512),
                                     agent.cfg.get("head_max_len", 192))
                           for question in questions.values())
        if state_budget <= 0:
            raise ValueError("state_budget_too_small")
        return Runtime(agent, questions, state_budget, model_sha256, str(agent.device),
                       torch.inference_mode, torch.mps.synchronize if device == "mps" else lambda: None)


@dataclass(eq=False)
class _Job:
    state: dict
    future: object
    enqueued_at: float
    started: bool = False


class _HttpError(Exception):
    def __init__(self, status, reason, retry_after=None):
        self.status = status
        self.reason = reason
        self.retry_after = retry_after


class _Disconnected(Exception):
    pass


def _default_log(record):
    _audit_stream.write(json.dumps(record, allow_nan=False) + "\n")
    _audit_stream.flush()


class LayaApp:
    def __init__(self, runtime=None, *, runtime_factory=load_runtime, clock=time.monotonic,
                 log_sink=None, rate_limit=30, rate_window=60.0, max_clients=4096):
        self.runtime = runtime
        self.runtime_factory = runtime_factory
        self.clock = clock
        self.log_sink = log_sink if log_sink is not None else _default_log
        self.rate_limit = rate_limit
        self.rate_window = rate_window
        self.max_clients = max_clients
        self._clients = OrderedDict()
        self._pending = deque()
        self._active = None
        self._wake = asyncio.Event()
        self._startup_lock = asyncio.Lock()
        self._executor = None
        self._worker_task = None
        self._closing = False
        self._last_inference = self.clock()

    @property
    def queue_length(self):
        # The first admitted job reserves the active slot before the worker gets its turn.
        return max(0, len(self._pending) - (self._active is None))

    async def startup(self):
        async with self._startup_lock:
            if self._worker_task is not None:
                return
            if self._closing:
                raise RuntimeError("service_closed")
            if self.runtime is None:
                self.runtime = await asyncio.to_thread(self.runtime_factory)
            self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="laya")
            self._last_inference = self.clock()
            self._worker_task = asyncio.create_task(self._run_queue())

    async def shutdown(self):
        self._closing = True
        while self._pending:
            job = self._pending.popleft()
            if not job.future.done():
                job.future.set_exception(_HttpError(503, "unavailable", 1))
        self._wake.set()
        if self._worker_task is not None:
            # Do not cancel a running thread: it keeps the model slot until it exits.
            await self._worker_task
        if self._executor is not None:
            self._executor.shutdown(wait=True)

    async def _run_queue(self):
        while True:
            if not self._pending:
                if self._closing:
                    return
                self._wake.clear()
                delay = max(0.0, KEEPWARM_SECONDS - (self.clock() - self._last_inference))
                try:
                    await asyncio.wait_for(self._wake.wait(), timeout=delay)
                    continue
                except asyncio.TimeoutError:
                    pass
                if self._pending or self._closing:
                    continue
                # Use the same slot as real requests, without HTTP logs or rate accounting.
                job = _Job({"message": "Hello", "recent_context": "", "reference_text": "",
                            "attachments": [], "candidate_executors": []}, None, self.clock())
            else:
                job = self._pending.popleft()
                if self.clock() - job.enqueued_at > MAX_QUEUE_WAIT_SECONDS:
                    job.state = {}
                    if not job.future.done():
                        job.future.set_exception(_HttpError(503, "queue_expired", 1))
                    continue
            self._active = job
            job.started = True
            try:
                result = await asyncio.get_running_loop().run_in_executor(
                    self._executor, self.runtime.predict, job.state)
                if job.future is not None and not job.future.done():
                    job.future.set_result(result)
            except Exception:
                if job.future is not None and not job.future.done():
                    job.future.set_exception(_HttpError(500, "inference_failed"))
            finally:
                job.state = {}
                self._active = None
                self._last_inference = self.clock()

    def _admit(self, state):
        if self._closing or self._worker_task is None:
            raise _HttpError(503, "unavailable", 1)
        if len(self._pending) + (self._active is not None) >= 9:
            raise _HttpError(503, "queue_full", 1)
        job = _Job(state, asyncio.get_running_loop().create_future(), self.clock())
        self._pending.append(job)
        self._wake.set()
        return job

    def _abandon(self, job):
        if not job.future.done():
            job.future.cancel()
        elif not job.future.cancelled():
            job.future.exception()
        if not job.started:
            with suppress(ValueError):
                self._pending.remove(job)
            job.state = {}

    def _rate_check(self, client):
        now = self.clock()
        cutoff = now - self.rate_window
        while self._clients and next(iter(self._clients.values()))[-1] <= cutoff:
            self._clients.popitem(last=False)
        history = self._clients.get(client)
        if history is None:
            if len(self._clients) >= self.max_clients:
                raise _HttpError(503, "rate_capacity", 1)
            history = deque()
        while history and history[0] <= cutoff:
            history.popleft()
        if len(history) >= self.rate_limit:
            raise _HttpError(429, "rate_limited", max(1, math.ceil(history[0] + self.rate_window - now)))
        history.append(now)
        self._clients[client] = history
        self._clients.move_to_end(client)

    @staticmethod
    def _client_and_country(scope):
        headers = {}
        for key, value in scope.get("headers", []):
            headers.setdefault(key.lower(), []).append(value)
        countries = headers.get(b"cf-ipcountry", [])
        country = countries[0].decode("ascii", errors="replace").upper() if len(countries) == 1 else "XX"
        if len(country) != 2 or not all("A" <= char <= "Z" for char in country):
            country = "XX"
        addresses = headers.get(b"cf-connecting-ip", [])
        address = addresses[0].decode("ascii", errors="replace") if len(addresses) == 1 else ""
        try:
            client = str(ipaddress.ip_address(address))
        except ValueError:
            peer = scope.get("client")
            client = str(peer[0]) if peer else "unknown"
        return client, country

    @staticmethod
    async def _read_body(receive, headers):
        for key, value in headers:
            if key.lower() == b"content-length":
                try:
                    declared = int(value)
                    if declared < 0:
                        raise ValueError("invalid_length")
                except ValueError:
                    raise _HttpError(400, "invalid_request") from None
                if declared > MAX_BODY:
                    raise _HttpError(413, "body_too_large")
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                raise _Disconnected()
            chunk = message.get("body", b"")
            if len(body) + len(chunk) > MAX_BODY:
                raise _HttpError(413, "body_too_large")
            body.extend(chunk)
            if not message.get("more_body", False):
                break
        try:
            request = strict_json(body)
            if not isinstance(request, dict) or set(request) != {"state"} or not worker.valid_state(request["state"]):
                raise ValueError("invalid_request")
            json.dumps(request, ensure_ascii=False).encode("utf-8")
        except (ValueError, UnicodeError, RecursionError):
            raise _HttpError(400, "invalid_request") from None
        return request["state"]

    @staticmethod
    async def _disconnect(receive):
        while True:
            if (await receive())["type"] == "http.disconnect":
                return

    async def _wait_result(self, job, receive):
        disconnected = asyncio.create_task(self._disconnect(receive))
        try:
            completed, _ = await asyncio.wait((job.future, disconnected), return_when=asyncio.FIRST_COMPLETED)
            if disconnected in completed:
                self._abandon(job)
                raise _Disconnected()
            return job.future.result()
        except asyncio.CancelledError:
            self._abandon(job)
            raise
        finally:
            disconnected.cancel()
            with suppress(asyncio.CancelledError):
                await disconnected

    @staticmethod
    async def _respond(send, status, payload, retry_after=None):
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
                   (b"cache-control", b"no-store")]
        if retry_after is not None:
            headers.append((b"retry-after", str(retry_after).encode()))
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": body})

    async def _lifespan(self, receive, send):
        while True:
            message = await receive()
            if message["type"] == "lifespan.startup":
                try:
                    await self.startup()
                except Exception:
                    await send({"type": "lifespan.startup.failed", "message": "startup_failed"})
                    return
                await send({"type": "lifespan.startup.complete"})
            elif message["type"] == "lifespan.shutdown":
                await self.shutdown()
                await send({"type": "lifespan.shutdown.complete"})
                return

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            await self._lifespan(receive, send)
            return
        if scope["type"] != "http":
            return
        started = self.clock()
        status, packed_count, country = 500, 0, "XX"
        try:
            client, country = self._client_and_country(scope)
            if scope["path"] == "/healthz" and scope["method"] == "GET":
                if self.runtime is None or self._closing or self._worker_task is None:
                    raise _HttpError(503, "unavailable", 1)
                status = 200
                payload = {"modelVersion": MODEL_VERSION, "device": self.runtime.device,
                           "queueLength": self.queue_length}
            elif scope["path"] == "/v1/judge" and scope["method"] == "POST":
                self._rate_check(client)
                state = await self._read_body(receive, scope.get("headers", []))
                raw, packed_count = await self._wait_result(self._admit(state), receive)
                status = 200
                payload = {"modelVersion": MODEL_VERSION, "modelSha256": self.runtime.model_sha256,
                           "device": self.runtime.device, "latencyMs": round((self.clock() - started) * 1000, 3),
                           "raw": raw, "region": "eu" if country in EU_COUNTRIES else "other"}
            else:
                raise _HttpError(404, "not_found")
            await self._respond(send, status, payload)
        except _HttpError as error:
            status = error.status
            with suppress(Exception):
                await self._respond(send, status, {"error": error.reason}, error.retry_after)
        except _Disconnected:
            status = 499
        except asyncio.CancelledError:
            status = 499
            raise
        except Exception:
            status = 500
            with suppress(Exception):
                await self._respond(send, status, {"error": "request_failed"})
        finally:
            with suppress(Exception):
                self.log_sink({"timestamp": datetime.now(timezone.utc).isoformat(), "status": status,
                               "latencyMs": round((self.clock() - started) * 1000, 3),
                               "packedTokenCount": packed_count, "country": country})


def create_app(runtime=None, **kwargs):
    return LayaApp(runtime, **kwargs)


app = create_app()


def main():
    # No framework access logs, exception traces, URL logging, or proxy-header rewriting.
    logging.disable(sys.maxsize)
    try:
        import uvicorn
        port = int(os.environ.get("LAYA_PORT", "8787"))
        if not 1 <= port <= 65535:
            return 1
        uvicorn.run(app, host="127.0.0.1", port=port, workers=1, access_log=False,
                    log_config=None, log_level="critical", proxy_headers=False, server_header=False,
                    lifespan="on", ws="none")
        return 0
    except Exception:
        return 1


if __name__ == "__main__":
    # Native buffers may flush after prediction; only the dedicated audit FD stays open.
    with open(os.devnull, "w", encoding="utf-8") as quiet:
        os.dup2(quiet.fileno(), 1)
        os.dup2(quiet.fileno(), 2)
    raise SystemExit(main())
