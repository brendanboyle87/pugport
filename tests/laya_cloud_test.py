"""Cloud HTTP boundary tests. Standard library only; no model or network access."""
import asyncio
from contextlib import nullcontext, redirect_stderr, redirect_stdout
import hashlib
import importlib.util
import io
import json
import logging
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from laya_worker_test import CharacterTokenizer, state


spec = importlib.util.spec_from_file_location(
    "laya_cloud", Path(__file__).resolve().parents[1] / "services/laya-cloud/app.py")
cloud = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = cloud
spec.loader.exec_module(cloud)


class FakeAgent:
    tok = CharacterTokenizer()

    def __init__(self):
        self.calls = []
        self.entered = threading.Event()
        self.release = threading.Event()
        self.release.set()
        self.failure = None
        self.active = 0
        self.peak_active = 0

    def predict(self, packed, questions):
        self.active += 1
        self.peak_active = max(self.peak_active, self.active)
        self.entered.set()
        try:
            if not self.release.wait(5):
                raise RuntimeError("synthetic_test_timeout")
            self.calls.append((packed, questions))
            if self.failure:
                print(self.failure)
                print(self.failure, file=sys.stderr)
                logging.getLogger("fake_model").error(self.failure)
                raise RuntimeError(self.failure)
            return {"answers": {"task_type": {"choice": "coding"}},
                    "usage": {"model_tokens": 12}}
        finally:
            self.active -= 1


async def request(app, body=None, *, method="POST", path="/v1/judge", headers=(), chunks=None):
    if chunks is None:
        if body is None:
            body = {"state": state()}
        encoded = json.dumps(body, ensure_ascii=False).encode("utf-8") if not isinstance(body, bytes) else body
        chunks = [encoded]
    incoming = list(chunks)
    messages = []

    async def receive():
        if incoming:
            chunk = incoming.pop(0)
            return {"type": "http.request", "body": chunk, "more_body": bool(incoming)}
        await asyncio.Future()

    async def send(message):
        messages.append(message)

    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
             "scheme": "http", "method": method, "path": path,
             "raw_path": path.encode(), "query_string": b"", "root_path": "",
             "server": ("127.0.0.1", 8787), "client": ("127.0.0.1", 12345),
             "headers": [(b"content-type", b"application/json"), *headers]}
    await app(scope, receive, send)
    start = next(message for message in messages if message["type"] == "http.response.start")
    payload = b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body")
    return start["status"], dict(start.get("headers", [])), json.loads(payload)


class CloudTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.agent = FakeAgent()
        self.logs = []
        self.now = 100.0
        self.runtime = cloud.Runtime(self.agent, {"task_type": {"type": "choice"}},
                                     874, "a" * 64, device="cpu")
        self.app = cloud.create_app(self.runtime, clock=lambda: self.now, log_sink=self.logs.append)
        await self.app.startup()

    async def asyncTearDown(self):
        self.agent.release.set()
        await self.app.shutdown()

    async def wait_until(self, predicate):
        async with asyncio.timeout(3):
            while not predicate():
                await asyncio.sleep(0.005)

    async def test_judge_shape_and_exact_worker_packing(self):
        original = state("Please explain. " + "synthetic background " * 200 + " Keep this final request.")
        expected, packing = cloud.worker.pack_state(original, self.agent.tok, 874)
        status, _, result = await request(self.app, {"state": original})
        self.assertEqual(status, 200)
        self.assertEqual(set(result), {"modelVersion", "modelSha256", "device", "latencyMs", "raw", "region"})
        self.assertEqual(result["modelVersion"], "pugport-laya-v4")
        self.assertEqual(result["modelSha256"], "a" * 64)
        self.assertEqual(result["device"], "cpu")
        self.assertGreaterEqual(result["latencyMs"], 0)
        self.assertEqual(result["region"], "other")
        self.assertEqual(result["raw"], {"answers": {"task_type": {"choice": "coding"}},
                                          "usage": {"model_tokens": 12, **packing}})
        self.assertEqual(self.agent.calls, [(expected, self.runtime.questions)])

    async def test_keepwarm_waits_for_idle_and_never_logs_or_uses_rate_budget(self):
        self.now = 159.0
        self.app._wake.set()
        await asyncio.sleep(0.01)
        self.assertEqual(self.agent.calls, [])
        self.now = 160.0
        self.app._wake.set()
        await self.wait_until(lambda: len(self.agent.calls) == 1 and self.app._active is None)
        expected, _ = cloud.worker.pack_state(state("Hello"), self.agent.tok, 874)
        self.assertEqual(self.agent.calls[0], (expected, self.runtime.questions))
        self.assertEqual(self.logs, [])
        self.assertEqual(len(self.app._clients), 0)
        self.now = 219.0
        self.app._wake.set()
        await asyncio.sleep(0.01)
        self.assertEqual(len(self.agent.calls), 1)
        self.now = 220.0
        self.app._wake.set()
        await self.wait_until(lambda: len(self.agent.calls) == 2 and self.app._active is None)
        self.assertEqual(self.logs, [])
        self.assertEqual(len(self.app._clients), 0)

    async def test_keepwarm_shares_the_request_slot_and_restarts_idle_after_requests(self):
        self.agent.release.clear()
        self.now = 160.0
        self.app._wake.set()
        await self.wait_until(self.agent.entered.is_set)
        # This request is still fresh at the exact 2.5-second dequeue boundary.
        self.now = 197.5
        pending = asyncio.create_task(request(self.app))
        try:
            await self.wait_until(lambda: self.app.queue_length == 1)
            self.assertEqual(self.agent.active, 1)
            self.assertEqual(self.logs, [])
            self.now = 200.0
        finally:
            self.agent.release.set()
            self.assertEqual((await pending)[0], 200)
        self.assertEqual(len(self.agent.calls), 2)
        self.assertEqual(self.agent.peak_active, 1)
        self.assertEqual(len(self.logs), 1)
        self.assertEqual(sum(len(history) for history in self.app._clients.values()), 1)
        self.now = 259.0
        self.app._wake.set()
        await asyncio.sleep(0.01)
        self.assertEqual(len(self.agent.calls), 2)
        self.now = 260.0
        self.app._wake.set()
        await self.wait_until(lambda: len(self.agent.calls) == 3 and self.app._active is None)
        self.assertEqual(len(self.logs), 1)

    async def test_failed_keepwarm_is_silent_and_does_not_spin_or_break_requests(self):
        self.agent.failure = "PRIVATE_KEEPWARM_SYNTHETIC_MARKER"
        self.now = 160.0
        self.app._wake.set()
        await self.wait_until(lambda: len(self.agent.calls) == 1 and self.app._active is None)
        self.now = 219.0
        self.app._wake.set()
        await asyncio.sleep(0.01)
        self.assertEqual(len(self.agent.calls), 1)
        self.assertEqual(self.logs, [])
        self.agent.failure = None
        self.assertEqual((await request(self.app))[0], 200)
        self.assertEqual(len(self.agent.calls), 2)
        self.assertEqual([record["status"] for record in self.logs], [200])

    async def test_schema_rejects_unknown_missing_and_wrong_types(self):
        bad_states = [None, [], {}, {**state(), "extra": "x"},
                      {**state(), "message": 42}, {**state(), "message": "x" * 32769},
                      {**state(), "attachments": [{"kind": "image", "name": "x", "path": "x"}]},
                      {**state(), "attachments": [{"kind": "image"}]},
                      {**state(), "attachments": [{"kind": "x", "name": "x"}] * 33},
                      {**state(), "candidate_executors": [False]},
                      {**state(), "candidate_executors": ["x"] * 33}]
        bodies = [{"state": value} for value in bad_states] + [[], {}, {"state": state(), "extra": 1}]
        for body in bodies:
            with self.subTest(body_type=type(body).__name__):
                status, _, _ = await request(self.app, body)
                self.assertEqual(status, 400)
        self.assertEqual(self.agent.calls, [])

    async def test_strict_json(self):
        valid = json.dumps({"state": state()}).encode()
        bad = [b'{"state":NaN}', b'{"state":Infinity}', b'{"state":-Infinity}',
               b'{"state":{},"state":{}}', valid[:-1] + b',"state":null}',
               valid + b'{}', b'\xff', b'{', b'{"state":{"message":"\\ud800"}}']
        duplicate_nested = valid.replace(b'"message": "Hello"', b'"message": "a", "message": "b"')
        for body in [*bad, duplicate_nested]:
            with self.subTest(body=body[:30]):
                status, _, result = await request(self.app, body)
                self.assertEqual(status, 400)
                self.assertNotIn("traceback", json.dumps(result).lower())
        self.assertEqual(self.agent.calls, [])

    async def test_body_cap_checks_bytes_and_streamed_body(self):
        valid = json.dumps({"state": state()}).encode()
        padded = valid + b" " * (65536 - len(valid))
        self.assertEqual((await request(self.app, padded))[0], 200)
        for kwargs in ({"body": padded + b" "},
                       {"chunks": [padded[:30000], padded[30000:], b" "]},
                       {"body": valid, "headers": [(b"content-length", b"65537")]},
                       {"body": {"state": state("\u56fe" * 24000)}}):
            with self.subTest(kind=list(kwargs)):
                self.assertEqual((await request(self.app, **kwargs))[0], 413)
        self.assertEqual(len(self.agent.calls), 1)

    async def test_region_mapping(self):
        countries = "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO CH GB".split()
        for country in countries + ["de", "US", "CA", "XX", "T1", "", "DE\r\nFORGED"]:
            self.now += 2
            expected = "eu" if country.upper() in countries else "other"
            with self.subTest(country=country):
                status, _, result = await request(self.app, headers=[(b"cf-ipcountry", country.encode())])
                self.assertEqual(status, 200)
                self.assertEqual(result["region"], expected)

    async def test_rate_limit_is_per_client_rolling_minute(self):
        first = [(b"cf-connecting-ip", b"192.0.2.1")]
        second = [(b"cf-connecting-ip", b"192.0.2.2")]
        for _ in range(30):
            self.assertEqual((await request(self.app, headers=first))[0], 200)
        status, headers, result = await request(self.app, headers=first)
        self.assertEqual(status, 429)
        self.assertEqual(result, {"error": "rate_limited"})
        self.assertEqual(len(self.agent.calls), 30)
        self.assertGreater(int(headers[b"retry-after"]), 0)
        self.assertEqual((await request(self.app, headers=second))[0], 200)
        self.now += 59.999
        self.assertEqual((await request(self.app, headers=first))[0], 429)
        self.now += 0.002
        self.assertEqual((await request(self.app, headers=first))[0], 200)

    async def test_health_reports_queue_and_does_not_use_judge_quota(self):
        for _ in range(31):
            status, _, result = await request(self.app, method="GET", path="/healthz", body=b"")
            self.assertEqual(status, 200)
            self.assertEqual(result, {"modelVersion": "pugport-laya-v4", "device": "cpu", "queueLength": 0})
        self.assertEqual((await request(self.app))[0], 200)

    async def test_rate_limiter_capacity_is_bounded_without_resetting_live_limits(self):
        app = cloud.create_app(self.runtime, clock=lambda: self.now, log_sink=self.logs.append,
                               rate_limit=1, max_clients=1)
        await app.startup()
        first = [(b"cf-connecting-ip", b"192.0.2.1")]
        second = [(b"cf-connecting-ip", b"192.0.2.2")]
        try:
            self.assertEqual((await request(app, headers=first))[0], 200)
            self.assertEqual((await request(app, headers=second))[0], 503)
            self.assertEqual((await request(app, headers=first))[0], 429)
            self.now += 60.1
            self.assertEqual((await request(app, headers=second))[0], 200)
        finally:
            await app.shutdown()

    async def test_queue_full_returns_503_and_predict_is_serial(self):
        self.agent.release.clear()
        first = asyncio.create_task(request(self.app))
        await self.wait_until(self.agent.entered.is_set)
        waiting = [asyncio.create_task(request(self.app)) for _ in range(8)]
        try:
            await self.wait_until(lambda: self.app.queue_length == 8)
            status, _, health = await request(self.app, method="GET", path="/healthz", body=b"")
            self.assertEqual(status, 200)
            self.assertEqual(health["queueLength"], 8)
            status, headers, _ = await request(self.app)
            self.assertEqual(status, 503)
            self.assertGreater(int(headers[b"retry-after"]), 0)
        finally:
            self.agent.release.set()
            responses = await asyncio.gather(first, *waiting)
        self.assertTrue(all(response[0] == 200 for response in responses))
        self.assertEqual(len(self.agent.calls), 9)
        self.assertEqual(self.agent.peak_active, 1)
        self.assertEqual(self.app.queue_length, 0)

    async def test_burst_reserves_one_active_slot_before_worker_gets_a_turn(self):
        self.agent.release.clear()
        tasks = [asyncio.create_task(request(self.app)) for _ in range(9)]
        try:
            await asyncio.sleep(0)
            status, _, health = await request(self.app, method="GET", path="/healthz", body=b"")
            self.assertEqual(status, 200)
            self.assertEqual(health["queueLength"], 8)
            self.assertEqual((await request(self.app))[0], 503)
        finally:
            self.agent.release.set()
            responses = await asyncio.gather(*tasks)
        self.assertTrue(all(response[0] == 200 for response in responses))
        self.assertEqual(self.agent.peak_active, 1)

    async def test_expired_waiters_are_dropped_before_inference_and_fresh_jobs_continue(self):
        self.agent.release.clear()
        first = asyncio.create_task(request(self.app))
        await self.wait_until(self.agent.entered.is_set)
        expired = asyncio.create_task(request(self.app, {"state": state("expired synthetic request")}))
        fresh = None
        try:
            await self.wait_until(lambda: self.app.queue_length == 1)
            expired_job = self.app._pending[0]
            self.now += 2.501
            fresh = asyncio.create_task(request(self.app, {"state": state("fresh synthetic request")}))
            await self.wait_until(lambda: self.app.queue_length == 2)
        finally:
            self.agent.release.set()
            responses = await asyncio.gather(first, expired, *([fresh] if fresh else []))
        self.assertEqual(responses[0][0], 200)
        self.assertEqual(responses[1][0], 503)
        self.assertEqual(responses[1][2], {"error": "queue_expired"})
        self.assertGreater(int(responses[1][1][b"retry-after"]), 0)
        self.assertEqual(responses[2][0], 200)
        expected = [cloud.worker.pack_state(state(message), self.agent.tok, 874)[0]
                    for message in ("Hello", "fresh synthetic request")]
        self.assertEqual([call[0] for call in self.agent.calls], expected)
        self.assertEqual(expired_job.state, {})
        self.assertFalse(expired_job.started)
        self.assertEqual(self.agent.peak_active, 1)
        self.assertEqual(self.app.queue_length, 0)

    async def test_cancelling_active_request_does_not_release_predict_lock(self):
        self.agent.release.clear()
        first = asyncio.create_task(request(self.app))
        await self.wait_until(self.agent.entered.is_set)
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        second = asyncio.create_task(request(self.app))
        try:
            await self.wait_until(lambda: self.app.queue_length == 1)
            self.assertEqual(self.agent.active, 1)
        finally:
            self.agent.release.set()
            self.assertEqual((await second)[0], 200)
        self.assertEqual(self.agent.peak_active, 1)

    async def test_cancelled_waiter_frees_capacity_without_inference(self):
        self.agent.release.clear()
        first = asyncio.create_task(request(self.app))
        await self.wait_until(self.agent.entered.is_set)
        waiting = asyncio.create_task(request(self.app, {"state": state("cancelled synthetic request")}))
        try:
            await self.wait_until(lambda: self.app.queue_length == 1)
            waiting.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await waiting
            await self.wait_until(lambda: self.app.queue_length == 0)
        finally:
            self.agent.release.set()
            await first
        self.assertEqual(len(self.agent.calls), 1)

    async def test_http_disconnect_removes_waiter_without_sending_or_predicting(self):
        self.agent.release.clear()
        first = asyncio.create_task(request(self.app))
        await self.wait_until(self.agent.entered.is_set)
        incoming = asyncio.Queue()
        await incoming.put({"type": "http.request", "body": json.dumps({"state": state()}).encode()})
        sent = []

        async def send(message):
            sent.append(message)

        task = asyncio.create_task(self.app(
            {"type": "http", "method": "POST", "path": "/v1/judge", "headers": []}, incoming.get, send))
        try:
            await self.wait_until(lambda: self.app.queue_length == 1)
            await incoming.put({"type": "http.disconnect"})
            await task
            self.assertEqual(sent, [])
            self.assertEqual(self.app.queue_length, 0)
            self.assertEqual(self.logs[-1]["status"], 499)
        finally:
            self.agent.release.set()
            await first
        self.assertEqual(len(self.agent.calls), 1)

    async def test_no_content_in_logs_including_errors_and_headers(self):
        marker = "PRIVATE_SYNTHETIC_MARKER_c7b81f9b"
        captured = io.StringIO()
        handler = logging.StreamHandler(captured)
        logging.getLogger().addHandler(handler)
        try:
            with redirect_stdout(captured), redirect_stderr(captured):
                self.assertEqual((await request(self.app, {"state": state(marker)}))[0], 200)
                self.assertEqual((await request(self.app, {"state": state(), "extra": marker}))[0], 400)
                self.agent.failure = marker
                status, _, result = await request(self.app, {"state": state(marker)},
                                                  headers=[(b"cf-ipcountry", marker.encode())])
                self.assertEqual(status, 500)
                self.assertNotIn(marker, json.dumps(result))
        finally:
            logging.getLogger().removeHandler(handler)
        self.assertGreater(len(self.logs), 0)
        self.assertNotIn(marker, captured.getvalue() + repr(self.logs))
        self.assertNotIn("Traceback", captured.getvalue() + repr(self.logs))
        for record in self.logs:
            self.assertEqual(set(record), {"timestamp", "status", "latencyMs", "packedTokenCount", "country"})
            self.assertRegex(record["country"], r"^[A-Z]{2}$")
            self.assertIsInstance(record["packedTokenCount"], int)

    async def test_lifespan_loads_runtime_once(self):
        loads = []

        def factory():
            loads.append(True)
            return self.runtime

        app = cloud.create_app(runtime_factory=factory, log_sink=self.logs.append)
        events = asyncio.Queue()
        await events.put({"type": "lifespan.startup"})
        sent = []

        async def send(message):
            sent.append(message)

        task = asyncio.create_task(app({"type": "lifespan"}, events.get, send))
        await self.wait_until(lambda: bool(sent))
        self.assertEqual(sent, [{"type": "lifespan.startup.complete"}])
        for _ in range(2):
            self.assertEqual((await request(app))[0], 200)
        await events.put({"type": "lifespan.shutdown"})
        await task
        self.assertEqual(len(loads), 1)
        self.assertEqual(sent[-1], {"type": "lifespan.shutdown.complete"})

    async def test_startup_failure_does_not_echo_exception(self):
        marker = "PRIVATE_STARTUP_MARKER_6d4cc"

        def fail():
            raise RuntimeError(marker)

        app = cloud.create_app(runtime_factory=fail, log_sink=self.logs.append)
        messages = []

        async def receive():
            return {"type": "lifespan.startup"}

        async def send(message):
            messages.append(message)

        await app({"type": "lifespan"}, receive, send)
        self.assertEqual(messages, [{"type": "lifespan.startup.failed", "message": "startup_failed"}])
        self.assertNotIn(marker, repr(self.logs) + repr(messages))


class StartupTest(unittest.TestCase):
    def test_native_model_output_is_redacted_but_concurrent_audit_logs_survive(self):
        marker = "PRIVATE_NATIVE_MARKER_d1c5a"
        script = '''
import asyncio, os, sys
sys.path.insert(0, "tests")
from laya_cloud_test import FakeAgent, cloud, request

class NativeAgent(FakeAgent):
    def predict(self, packed, questions):
        marker = b"PRIVATE_NATIVE_MARKER_d1c5a"
        os.write(1, marker + b"\\n")
        os.write(2, marker + b"\\n")
        sys.__stdout__.write(marker.decode())
        sys.__stderr__.write(marker.decode())
        self.entered.set()
        if not self.release.wait(5):
            raise RuntimeError("synthetic_test_timeout")
        raise RuntimeError(marker.decode())

async def run():
    agent = NativeAgent()
    agent.release.clear()
    app = cloud.create_app(cloud.Runtime(agent, {}, 874, "b" * 64))
    await app.startup()
    pending = asyncio.create_task(request(app))
    try:
        async with asyncio.timeout(3):
            while not agent.entered.is_set():
                await asyncio.sleep(0.005)
        assert (await request(app, method="GET", path="/healthz", body=b""))[0] == 200
    finally:
        agent.release.set()
        assert (await pending)[0] == 500
        await app.shutdown()

asyncio.run(run())
'''
        completed = subprocess.run([sys.executable, "-B", "-c", script],
                                   cwd=Path(__file__).resolve().parents[1], capture_output=True,
                                   text=True, timeout=15, check=False)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertNotIn(marker, completed.stdout + completed.stderr)
        self.assertEqual(completed.stderr, "")
        records = [json.loads(line) for line in completed.stdout.splitlines()]
        self.assertEqual([record["status"] for record in records], [200, 500])
        for record in records:
            self.assertEqual(set(record), {"timestamp", "status", "latencyMs", "packedTokenCount", "country"})

    def test_production_entrypoint_silences_delayed_server_output(self):
        script = '''
import os, runpy, sys
from types import SimpleNamespace

def run(app, **kwargs):
    marker = "PRIVATE_ENTRYPOINT_MARKER_f6d22"
    sys.__stdout__.write(marker)
    sys.__stderr__.write(marker)
    os.write(1, marker.encode())
    os.write(2, marker.encode())
    app.log_sink({"timestamp": "synthetic", "status": 200, "latencyMs": 0,
                  "packedTokenCount": 0, "country": "XX"})

sys.modules["uvicorn"] = SimpleNamespace(run=run)
runpy.run_path("services/laya-cloud/app.py", run_name="__main__")
'''
        completed = subprocess.run([sys.executable, "-B", "-c", script],
                                   cwd=Path(__file__).resolve().parents[1], capture_output=True,
                                   text=True, timeout=15, check=False)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertNotIn("PRIVATE_ENTRYPOINT_MARKER_f6d22", completed.stdout + completed.stderr)
        self.assertEqual(completed.stderr, "")
        self.assertEqual(json.loads(completed.stdout), {"timestamp": "synthetic", "status": 200,
                                                      "latencyMs": 0, "packedTokenCount": 0, "country": "XX"})

    def test_load_uses_checkpoint_questions_budget_hash_and_mps_fp32(self):
        class Device:
            type = "mps"

            def __str__(self):
                return self.type

        with tempfile.TemporaryDirectory(prefix="laya-fake-checkpoint-") as directory:
            checkpoint = Path(directory)
            payload = b"synthetic weights, never loaded"
            (checkpoint / "model.safetensors").write_bytes(payload)
            questions = {name: {"type": "choice", "criteria": dict.fromkeys(choices, "synthetic"),
                                "room": 874 + index}
                         for index, (name, choices) in enumerate(cloud.worker.CHOICES.items())}
            (checkpoint / "questions.json").write_text(json.dumps(questions), encoding="utf-8")
            agent = SimpleNamespace(device=Device(), model=SimpleNamespace(float=Mock()),
                                    tok=CharacterTokenizer(), cfg={"max_len": 1024, "head_max_len": 192},
                                    _to_internal=lambda question: question, amp_enabled=True, dtype="half")
            torch = SimpleNamespace(set_num_threads=Mock(), float32=object(), inference_mode=nullcontext,
                                    mps=SimpleNamespace(synchronize=Mock()))
            laya = SimpleNamespace(load=Mock(return_value=agent))
            room = Mock(side_effect=lambda tok, question, max_len, head_len: question["room"])
            with patch.dict(os.environ, {"LAYA_CHECKPOINT": directory}, clear=True), \
                    patch.dict(sys.modules, {"torch": torch, "laya": laya, "laya.common": SimpleNamespace(state_room=room)}):
                runtime = cloud.load_runtime()
            expected_hash = hashlib.sha256(payload).hexdigest()
            laya.load.assert_called_once_with(str(checkpoint.resolve()), device="mps", backend="eager", fast=False,
                                              compile=False, expected_sha256={"model.safetensors": expected_hash})
            agent.model.float.assert_called_once_with()
            self.assertFalse(agent.amp_enabled)
            self.assertIs(agent.dtype, torch.float32)
            self.assertEqual(runtime.model_sha256, expected_hash)
            self.assertEqual(runtime.questions, questions)
            self.assertEqual(runtime.state_budget, 874)
            self.assertEqual(runtime.device, "mps")
            self.assertEqual(room.call_count, len(questions))
            for args in room.call_args_list:
                self.assertEqual(args.args[2:], (1024, 192))

    def test_launcher_keeps_loopback_one_worker_and_content_logs_disabled(self):
        uvicorn = SimpleNamespace(run=Mock())
        previous = logging.root.manager.disable
        try:
            with patch.dict(os.environ, {"LAYA_PORT": "9876"}, clear=True), patch.dict(sys.modules, {"uvicorn": uvicorn}):
                self.assertEqual(cloud.main(), 0)
            kwargs = uvicorn.run.call_args.kwargs
            self.assertEqual(kwargs["host"], "127.0.0.1")
            self.assertEqual(kwargs["port"], 9876)
            self.assertEqual(kwargs["workers"], 1)
            self.assertFalse(kwargs["access_log"])
            self.assertFalse(kwargs["proxy_headers"])
            self.assertIsNone(kwargs["log_config"])
        finally:
            logging.disable(previous)


if __name__ == "__main__":
    unittest.main()
