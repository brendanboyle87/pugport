"""Offline, aggregate-only Laya ONNX accuracy and serial CPU latency evaluation."""
import argparse
from contextlib import contextmanager, nullcontext, redirect_stderr, redirect_stdout
import gc
import hashlib
import importlib.metadata
import importlib.util
import json
import math
import os
from pathlib import Path
import random
import re
import subprocess
import sys
import time

sys.dont_write_bytecode = True
CACHE = Path.home() / ".cache/pp-laya/onnx/pugport-laya-v4"
DATA = Path(os.environ.get("LAYA_DATASET_DIR", Path.home() / "laya-routing-dataset/data"))
RECORDS = Path(os.environ.get("PUGPORT_ROUTING_RECORDS", Path.home() / "PugPort/data/routing-training"))
DATASETS = ("blind_test_v4", "calibration_v4", "real_records")
BACKENDS = ("torch", "fp32", "int8")
REPO = Path(__file__).resolve().parents[1]


def worker_module():
    spec = importlib.util.spec_from_file_location("laya_worker_eval", Path(__file__).with_name("laya-worker.py"))
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    return worker


WORKER = worker_module()


def validate_paths(args):
    def overlaps(left, right):
        return left.is_relative_to(right) or right.is_relative_to(left)

    root = args.onnx_root.resolve()
    staged = [(root / name).resolve() for name in ("reference", "fp32", "int8")]
    protected = [path.resolve() for path in
                 (REPO, DATA.parent / "checkpoints/pugport-laya-v4", RECORDS.parents[1],
                  DATA, RECORDS, args.data_dir, args.records_dir)]
    if (any(overlaps(path, forbidden) for path in [root, *staged] for forbidden in protected)
            or any(path == root or not path.is_relative_to(root) for path in staged)
            or any(overlaps(left, right) for index, left in enumerate(staged) for right in staged[index + 1:])):
        raise ValueError("unsafe_artifact_paths")
    checkpoint = args.checkpoint.resolve()
    if not checkpoint.is_relative_to(staged[0]) or not checkpoint.is_relative_to(root):
        raise ValueError("staged_reference_required")
    for directory in [checkpoint, *staged[1:]]:
        for relative in ("tokenizer", "tokenizer/tokenizer_config.json"):
            if not (directory / relative).resolve().is_relative_to(directory):
                raise ValueError("unsafe_tokenizer_path")
    outputs = [args.output] + [args.output.with_name(args.output.stem + "." + backend + "_threads_" + str(threads) + ".json")
                              for backend in ("fp32", "int8") for threads in (2, 4)]
    for path in outputs:
        for target in (path.resolve(), path.with_suffix(path.suffix + ".tmp").resolve()):
            if target == root or any(overlaps(target, forbidden) for forbidden in [*protected, *staged]):
                raise ValueError("unsafe_report_path")


def write_report(path, report):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def file_hash(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify_artifacts(args):
    if file_hash(args.checkpoint / "model.safetensors") != WORKER.MODEL_SHA256:
        raise ValueError("reference_digest")
    verified = {"reference_model_sha256": WORKER.MODEL_SHA256, "variants": {}}
    for backend in ("fp32", "int8"):
        directory = args.onnx_root / backend
        manifest_path = directory / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        files = manifest.get("files")
        actual = {path.relative_to(directory).as_posix(): path for path in directory.rglob("*")
                  if path.is_file() and path.name != "manifest.json"}
        if (manifest.get("source_model_sha256") != WORKER.MODEL_SHA256 or manifest.get("variant") != backend
                or not isinstance(files, dict) or set(files) != set(actual)
                or not {"laya.onnx", "questions.json", "rl_agent_config.json"} <= set(files)):
            raise ValueError("manifest_schema")
        for name, path in actual.items():
            metadata = files[name]
            if (not path.resolve().is_relative_to(directory.resolve()) or not isinstance(metadata, dict)
                    or metadata.get("bytes") != path.stat().st_size or metadata.get("sha256") != file_hash(path)):
                raise ValueError("payload_digest")
        verified["variants"][backend] = {"manifest_sha256": file_hash(manifest_path),
                                         "payload_files": len(files),
                                         "payload_bytes": sum(item["bytes"] for item in files.values())}
    return verified


@contextmanager
def quiet_dependencies():
    # Native runtime diagnostics can contain input text too, so silence both FDs.
    with open(os.devnull, "w", encoding="utf-8") as quiet:
        saved = [os.dup(fd) for fd in (1, 2)]
        try:
            for fd in (1, 2):
                os.dup2(quiet.fileno(), fd)
            with redirect_stdout(quiet), redirect_stderr(quiet):
                yield
        finally:
            for fd, original in zip((1, 2), saved):
                os.dup2(original, fd)
                os.close(original)


def check_questions(questions):
    if not isinstance(questions, dict) or set(questions) != set(WORKER.CHOICES):
        raise ValueError("question_schema")
    for name, choices in WORKER.CHOICES.items():
        question = questions[name]
        if (not isinstance(question, dict) or question.get("type") != "choice"
                or not isinstance(question.get("instructions"), str)
                or not isinstance(question.get("criteria"), dict)
                or set(question["criteria"]) != set(choices)):
            raise ValueError("question_schema")


def check_labels(labels):
    if not isinstance(labels, dict) or set(labels) != set(WORKER.CHOICES):
        raise ValueError("label_schema")
    if any(not isinstance(labels[name], str) or labels[name] not in choices
           for name, choices in WORKER.CHOICES.items()):
        raise ValueError("label_schema")


def record_paths(directory):
    paths = []
    for child in sorted(directory.iterdir()):
        if child.is_dir() and re.fullmatch(r"\d{4}-\d{2}-\d{2}", child.name):
            time.strptime(child.name, "%Y-%m-%d")
            paths.extend(sorted(path for path in child.glob("*.json") if path.is_file()))
    if not paths:
        raise ValueError("empty_records")
    return paths


def samples(name, args, paths, questions):
    if name == "real_records":
        rows = (json.loads(path.read_text(encoding="utf-8-sig")) for path in paths)
    else:
        def public_rows():
            with (args.data_dir / (name + ".jsonl")).open(encoding="utf-8-sig") as stream:
                for line in stream:
                    if line.strip():
                        yield json.loads(line)
        rows = public_rows()
    count = 0
    for row in rows:
        if not isinstance(row, dict) or not WORKER.valid_state(row.get("state")):
            raise ValueError("state_schema")
        labels = None
        if name != "real_records":
            if row.get("questions") != questions:
                raise ValueError("question_mismatch")
            labels = row.get("expected")
            check_labels(labels)
        # Fingerprints and reference answers remain in memory and are never exported.
        fingerprint = hashlib.sha256(json.dumps([row["state"], labels], sort_keys=True,
                                                ensure_ascii=False).encode("utf-8")).digest()
        count += 1
        yield row["state"], labels, fingerprint
    if not count:
        raise ValueError("empty_dataset")


@contextmanager
def capped_sessions(ort, threads):
    original = ort.InferenceSession

    def create(path, sess_options=None, providers=None, **kwargs):
        options = sess_options if sess_options is not None else ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.log_severity_level = 3
        options.add_session_config_entry("session.intra_op.allow_spinning", "0")
        options.add_session_config_entry("session.inter_op.allow_spinning", "0")
        kwargs.pop("provider_options", None)
        return original(path, sess_options=options, providers=["CPUExecutionProvider"], **kwargs)

    ort.InferenceSession = create
    try:
        yield
    finally:
        ort.InferenceSession = original


def load_agent(backend, args, threads=2):
    for key in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
        os.environ[key] = str(threads)
    started = time.perf_counter()
    with quiet_dependencies():
        if backend == "torch":
            import torch
            import laya
            torch.set_num_threads(2)
            torch.set_num_interop_threads(1)
            if args.torch_device == "cuda" and not torch.cuda.is_available():
                raise RuntimeError("cuda_unavailable")
            agent = laya.load(str(args.checkpoint), device=args.torch_device,
                              backend="eager", fast=False, compile=False)
            if agent.device.type != args.torch_device:
                raise RuntimeError("reference_device")
            if args.torch_device == "cpu":
                agent.model.float().cpu().eval()
                agent.amp_enabled = False
                agent.dtype = torch.float32
                if any(p.is_floating_point() and p.dtype != torch.float32 for p in agent.model.parameters()):
                    raise RuntimeError("reference_dtype")
            provenance = {"device": str(agent.device), "parameter_dtype": str(next(agent.model.parameters()).dtype),
                          "amp_enabled": bool(agent.amp_enabled), "compute_dtype": str(agent.dtype_for(len(WORKER.CHOICES))),
                          "intra_op_threads": 2, "inter_op_threads": 1,
                          "reference_note": "CPU FP32 differs from the live CUDA AMP worker" if args.torch_device == "cpu"
                          else "CUDA reference uses the package AMP configuration"}
        else:
            import onnxruntime as ort
            from laya.onnx_agent import ONNXAgent
            model_dir = args.onnx_root / backend
            with capped_sessions(ort, threads):
                agent = ONNXAgent(str(model_dir), onnx_path=str(model_dir / "laya.onnx"))
            options = agent.session.get_session_options()
            if (agent.session.get_providers() != ["CPUExecutionProvider"]
                    or options.intra_op_num_threads != threads or options.inter_op_num_threads != 1
                    or options.execution_mode != ort.ExecutionMode.ORT_SEQUENTIAL):
                raise RuntimeError("session_limits")
            provenance = {"device": "cpu", "providers": agent.session.get_providers(),
                          "intra_op_threads": threads, "inter_op_threads": 1,
                          "execution": "sequential", "spinning": False}
        from laya.common import state_room
        questions = json.loads((args.checkpoint / "questions.json").read_text(encoding="utf-8"))
        check_questions(questions)
        reference_config = json.loads((args.checkpoint / "rl_agent_config.json").read_text(encoding="utf-8"))
        if agent.cfg != reference_config:
            raise ValueError("exported_config_mismatch")
        if backend != "torch":
            exported = json.loads((args.onnx_root / backend / "questions.json").read_text(encoding="utf-8"))
            if exported != questions:
                raise ValueError("exported_question_mismatch")
        budget = min(state_room(agent.tok, agent._to_internal(question),
                                agent.cfg.get("max_len", 512), agent.cfg.get("head_max_len", 192))
                     for question in questions.values())
        if budget <= 0:
            raise ValueError("state_budget")
    provenance["state_token_budget"] = budget
    provenance["load_seconds"] = time.perf_counter() - started
    return agent, questions, budget, provenance


class ThrottleTimeout(RuntimeError):
    pass


class HostMemoryPressure(RuntimeError):
    def __init__(self, available_bytes):
        super().__init__("host_available_memory_below_2_GiB")
        self.available_bytes = available_bytes


def throttle(args):
    import psutil
    started = time.perf_counter()
    while True:
        available = psutil.virtual_memory().available
        if available < 2 * 1024 ** 3:
            raise HostMemoryPressure(available)
        if psutil.cpu_percent(interval=0.1) <= args.cpu_limit:
            break
        if time.perf_counter() - started >= args.throttle_timeout:
            raise ThrottleTimeout()
        time.sleep(0.25)
    return time.perf_counter() - started


def predict(agent, backend, state, questions, budget, expected_device=None):
    with quiet_dependencies():
        if backend == "torch":
            import torch
            context = torch.inference_mode()
        else:
            context = nullcontext()
        with context:
            started = time.perf_counter()
            packed, packing = WORKER.pack_state(state, agent.tok, budget)
            raw = agent.predict(packed, questions)
            if expected_device is not None and agent.device.type != expected_device:
                raise RuntimeError("reference_device")
            if backend == "torch" and agent.device.type == "cuda":
                torch.cuda.synchronize()
            elapsed = time.perf_counter() - started
        answers = raw.get("answers")
        if not isinstance(answers, dict) or set(answers) != set(questions):
            raise ValueError("answer_schema")
        choices = {name: answer.get("choice") for name, answer in answers.items()}
        check_labels(choices)
    return choices, elapsed, packing


def new_counts():
    return {name: {"total": 0, "correct": 0, "agreed": 0} for name in WORKER.CHOICES}


def add_counts(counts, predicted, labels=None, reference=None):
    check_labels(predicted)
    if labels is not None:
        check_labels(labels)
    if reference is not None:
        check_labels(reference)
    for name, item in counts.items():
        item["total"] += 1
        item["correct"] += int(labels is not None and predicted[name] == labels[name])
        item["agreed"] += int(reference is not None and predicted[name] == reference[name])


def summarized(counts, labeled, comparison):
    def metric(item):
        result = {"total": item["total"]}
        if not item["total"]:
            raise ValueError("empty_denominator")
        if labeled:
            result.update(correct=item["correct"], accuracy=item["correct"] / item["total"])
        if comparison:
            result.update(agreed=item["agreed"], agreement=item["agreed"] / item["total"])
        return result
    total = {key: sum(item[key] for item in counts.values()) for key in ("total", "correct", "agreed")}
    return {"records": next(iter(counts.values()))["total"], "gold_labels": labeled,
            "per_question": {name: metric(item) for name, item in counts.items()}, "micro": metric(total)}


def accuracy(args, report):
    references = {}
    paths = record_paths(args.records_dir)
    report["accuracy"] = {"status": "running", "reference_predictions": "recomputed; memory only",
                          "real_records_use": "agreement only; stored inference ignored", "backends": {}}
    write_report(args.output, report)
    for backend in BACKENDS:
        report["stage"] = "accuracy." + backend + ".load"
        write_report(args.output, report)
        throttle(args)
        agent, questions, budget, provenance = load_agent(backend, args)
        result = {"runtime": provenance, "datasets": {}}
        report["accuracy"]["backends"][backend] = result
        for name in DATASETS:
            report["stage"] = "accuracy." + backend + "." + name
            report["progress_requests"] = 0
            write_report(args.output, report)
            counts = new_counts()
            compacted = 0
            throttle_seconds = 0.0
            baseline = [] if backend == "torch" else references[name]
            for index, (state, labels, fingerprint) in enumerate(samples(name, args, paths, questions)):
                throttle_seconds += throttle(args)
                predicted, _, packing = predict(agent, backend, state, questions, budget,
                                                args.torch_device if backend == "torch" else None)
                reference = None
                if backend == "torch":
                    baseline.append((fingerprint, predicted))
                else:
                    if index >= len(baseline) or fingerprint != baseline[index][0]:
                        raise ValueError("dataset_changed")
                    reference = baseline[index][1]
                add_counts(counts, predicted, labels, reference)
                compacted += int(packing["input_compacted"])
                # Keep space between reference calls for the owner's live CUDA worker.
                time.sleep(0.5 if args.torch_device == "cuda" and backend == "torch" else 0.005)
                if (index + 1) % 10 == 0:
                    report["progress_requests"] = index + 1
                    write_report(args.output, report)
            if next(iter(counts.values()))["total"] != len(baseline):
                raise ValueError("dataset_changed")
            if backend == "torch":
                references[name] = baseline
            result["datasets"][name] = summarized(counts, name != "real_records", backend != "torch")
            if name != "real_records":
                result["datasets"][name].update(compacted_records=compacted, throttle_seconds=throttle_seconds)
            write_report(args.output, report)
        del agent
        gc.collect()
        if backend == "torch" and args.torch_device == "cuda":
            import torch
            torch.cuda.empty_cache()
    report["accuracy"]["status"] = "complete"
    report["recommendation"] = recommendation(report["accuracy"]["backends"])
    write_report(args.output, report)


def recommendation(backends):
    decisions = {}
    for backend in ("fp32", "int8"):
        checks = {}
        for name in DATASETS[:2]:
            reference = backends.get("torch", {}).get("datasets", {}).get(name)
            candidate = backends.get(backend, {}).get("datasets", {}).get(name)
            if not reference or not candidate:
                checks[name] = {"measured": False, "passes": False}
                continue
            if (reference["micro"]["total"] <= 0 or candidate["micro"]["total"] != reference["micro"]["total"]
                    or set(reference["per_question"]) != set(WORKER.CHOICES)
                    or set(candidate["per_question"]) != set(WORKER.CHOICES)
                    or any(candidate["per_question"][q]["total"] != reference["per_question"][q]["total"]
                           or reference["per_question"][q]["total"] <= 0 for q in WORKER.CHOICES)):
                raise ValueError("comparison_denominator")
            micro_loss = 100 * (reference["micro"]["accuracy"] - candidate["micro"]["accuracy"])
            losses = {q: 100 * (reference["per_question"][q]["accuracy"] - candidate["per_question"][q]["accuracy"])
                      for q in WORKER.CHOICES}
            worst_loss = max(losses.values())
            checks[name] = {"measured": True, "micro_loss_pp": micro_loss,
                            "max_question_loss_pp": worst_loss, "per_question_loss_pp": losses,
                            "passes": micro_loss <= 1.0 + 1e-9 and worst_loss <= 3.0 + 1e-9}
        decisions[backend] = {"passes": all(check["passes"] for check in checks.values()), "datasets": checks}
    measured = all(check["measured"] for decision in decisions.values() for check in decision["datasets"].values())
    return {"selected": ("int8" if decisions["int8"]["passes"] else "fp32") if measured else "unmeasured",
            "baseline": "fresh torch reference", "thresholds_pp": {"micro_loss": 1, "max_question_loss": 3},
            "variants": decisions, "note": "FP32 fallback is not a pass if its own thresholds fail"}


def synthetic_state(index):
    group = ("short", "medium", "long")[index % 3]
    budgets = {"short": (16, 0, 0), "medium": (90, 24, 40), "long": (800, 160, 240)}
    rng = random.Random(20261030 + index)
    words = "please inspect sample code document image table compare explain translate test write result".split()
    fields = [" ".join(rng.choice(words) for _ in range(size)) for size in budgets[group]]
    return group, {"message": fields[0], "recent_context": fields[1], "reference_text": fields[2],
                   "attachments": [] if group == "short" else [{"kind": "document", "name": "sample.txt", "mime_type": "text/plain"}],
                   "candidate_executors": [] if group == "short" else ["sample-a", "sample-b"]}


def percentile(values, percent):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(percent * len(ordered)) - 1)]


def latency_metrics(values):
    return {"requests": len(values), "p50_ms": 1000 * percentile(values, 0.5),
            "p95_ms": 1000 * percentile(values, 0.95), "mean_ms": 1000 * sum(values) / len(values),
            "max_ms": 1000 * max(values)}


def peak_rss():
    import psutil
    memory = psutil.Process().memory_info()
    if hasattr(memory, "peak_wset"):
        return memory.peak_wset
    import resource
    return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024))


def latency_child(args, report):
    # Reserve CPU headroom for the requested worker threads before each timed call.
    args.cpu_limit = min(args.cpu_limit, max(5.0, 65 - 100 * args.child_threads / (os.cpu_count() or 1)))
    report["cpu_limit_percent"] = args.cpu_limit
    report["stage"] = "latency." + args.child_backend + ".load"
    write_report(args.output, report)
    throttle(args)
    agent, questions, budget, provenance = load_agent(args.child_backend, args, args.child_threads)
    report["stage"] = "latency." + args.child_backend + ".warmup"
    for index in range(args.warmup):
        throttle(args)
        predict(agent, args.child_backend, synthetic_state(index)[1], questions, budget)
    timings = {name: [] for name in ("short", "medium", "long")}
    tokens = {name: [] for name in timings}
    compacted = 0
    throttle_seconds = 0.0
    report["stage"] = "latency." + args.child_backend + ".measure"
    for index in range(args.requests):
        group, state = synthetic_state(index)
        throttle_seconds += throttle(args)
        _, elapsed, packing = predict(agent, args.child_backend, state, questions, budget)
        timings[group].append(elapsed)
        tokens[group].append(packing["original_state_tokens"])
        compacted += int(packing["input_compacted"])
        time.sleep(0.005)
        if (index + 1) % 10 == 0:
            report["progress_requests"] = index + 1
            write_report(args.output, report)
    all_timings = [elapsed for values in timings.values() for elapsed in values]
    write_report(args.output, {"status": "complete", "runtime": provenance, "warmup_excluded": args.warmup,
                              "measurement": "serial pack_state + agent.predict; all ten production questions",
                              "workload": "deterministic synthetic fixed short/medium/long field budgets; no private text",
                              "overall": latency_metrics(all_timings),
                              "by_length": {name: {**latency_metrics(values),
                                                   "original_state_tokens_min": min(tokens[name]),
                                                   "original_state_tokens_max": max(tokens[name])}
                                            for name, values in timings.items()},
                              "compacted_requests": compacted, "peak_rss_bytes": peak_rss(),
                              "cpu_idle_threshold_percent": args.cpu_limit,
                              "throttle_seconds_excluded": throttle_seconds})


def latency(args, report):
    report["latency"] = {"status": "running", "processes": {}}
    write_report(args.output, report)
    for backend in ("fp32", "int8"):
        for threads in (2, 4):
            key = backend + "_threads_" + str(threads)
            report["stage"] = "latency." + key
            child_output = args.output.with_name(args.output.stem + "." + key + ".json")
            command = [sys.executable, "-B", str(Path(__file__).resolve()), "--child-backend", backend,
                       "--child-threads", str(threads), "--checkpoint", str(args.checkpoint),
                       "--onnx-root", str(args.onnx_root), "--output", str(child_output),
                       "--requests", str(args.requests), "--warmup", str(args.warmup),
                       "--cpu-limit", str(args.cpu_limit), "--throttle-timeout", str(args.throttle_timeout)]
            write_report(child_output, {"status": "running"})
            with open(os.devnull, "w") as quiet:
                completed = subprocess.run(command, stdout=quiet, stderr=quiet, check=False)
            child_result = json.loads(child_output.read_text(encoding="utf-8"))
            report["latency"]["processes"][key] = child_result
            write_report(args.output, report)
            if completed.returncode or child_result.get("status") != "complete":
                raise RuntimeError("latency_child_failed")
    report["latency"]["status"] = "complete"
    write_report(args.output, report)


def self_test():
    import io
    import tempfile
    from types import SimpleNamespace
    from unittest.mock import patch
    with patch.dict(sys.modules, {"psutil": SimpleNamespace(
            virtual_memory=lambda: SimpleNamespace(available=1024 ** 3))}):
        try:
            throttle(SimpleNamespace(cpu_limit=65, throttle_timeout=60))
            raise AssertionError("low memory accepted")
        except HostMemoryPressure as error:
            assert error.available_bytes == 1024 ** 3
    labels = {name: choices[0] for name, choices in WORKER.CHOICES.items()}
    check_labels(labels)
    for invalid in ({}, {**labels, "difficulty": "invalid"}):
        try:
            check_labels(invalid)
            raise AssertionError("invalid labels accepted")
        except ValueError:
            pass
    for index in range(210):
        assert WORKER.valid_state(synthetic_state(index)[1])
        assert synthetic_state(index) == synthetic_state(index)
    assert percentile([1, 2, 3, 4], 0.5) == 2
    assert latency_metrics([0.1, 0.2, 0.3])["max_ms"] == 300
    counts = new_counts()
    add_counts(counts, labels, labels, labels)
    metric = summarized(counts, True, True)
    assert metric["micro"] == {"total": 10, "correct": 10, "accuracy": 1.0, "agreed": 10, "agreement": 1.0}
    questions = {name: {"type": "choice", "instructions": "Synthetic question", "criteria": dict.fromkeys(choices)}
                 for name, choices in WORKER.CHOICES.items()}
    check_questions(questions)
    with tempfile.TemporaryDirectory(prefix="laya-eval-self-test-") as temporary:
        directory = Path(temporary)
        dated = directory / "2026-10-30"
        dated.mkdir()
        state = synthetic_state(0)[1]
        private = dated / "synthetic.json"
        private.write_text(json.dumps({"state": state, "inference": "ignored"}), encoding="utf-8")
        (directory / "ignored.json").write_text("not a record", encoding="utf-8")
        assert record_paths(directory) == [private]
        sample_args = SimpleNamespace(data_dir=directory)
        first = list(samples("real_records", sample_args, [private], questions))[0]
        assert first[:2] == (state, None)
        private.write_text(json.dumps({"state": state, "inference": "still ignored"}), encoding="utf-8")
        assert list(samples("real_records", sample_args, [private], questions))[0] == first
        assert file_hash(private) == hashlib.sha256(private.read_bytes()).hexdigest()
        public = directory / "blind_test_v4.jsonl"
        public.write_text(json.dumps({"state": state, "questions": questions, "expected": labels}) + "\n", encoding="utf-8")
        assert list(samples("blind_test_v4", sample_args, [], questions))[0][:2] == (state, labels)
        public.write_text(json.dumps({"state": state, "questions": questions, "expected": {}}), encoding="utf-8")
        try:
            list(samples("blind_test_v4", sample_args, [], questions))
            raise AssertionError("missing labels accepted")
        except ValueError:
            pass
        checkpoint = directory / "reference"
        checkpoint.mkdir()
        (checkpoint / "model.safetensors").write_bytes(b"synthetic weights")
        original_digest = WORKER.MODEL_SHA256
        WORKER.MODEL_SHA256 = file_hash(checkpoint / "model.safetensors")
        try:
            for backend in ("fp32", "int8"):
                exported = directory / backend
                exported.mkdir()
                for name in ("laya.onnx", "questions.json", "rl_agent_config.json"):
                    (exported / name).write_text("synthetic", encoding="utf-8")
                files = {path.name: {"sha256": file_hash(path), "bytes": path.stat().st_size}
                         for path in exported.iterdir()}
                write_report(exported / "manifest.json", {"variant": backend,
                             "source_model_sha256": WORKER.MODEL_SHA256, "files": files})
            artifact_args = SimpleNamespace(checkpoint=checkpoint, onnx_root=directory)
            assert verify_artifacts(artifact_args)["variants"]["int8"]["payload_files"] == 3
            (directory / "int8/laya.onnx").write_text("tampered", encoding="utf-8")
            try:
                verify_artifacts(artifact_args)
                raise AssertionError("tampered graph accepted")
            except ValueError:
                pass
        finally:
            WORKER.MODEL_SHA256 = original_digest
        safe_root = directory / "safe-exports"
        safe_args = SimpleNamespace(onnx_root=safe_root, checkpoint=safe_root / "reference",
                                    data_dir=directory / "public", records_dir=directory / "private",
                                    output=safe_root / "evaluation.json", self_test=False, mode="all",
                                    requests=0, warmup=6, cpu_limit=65, throttle_timeout=60)
        validate_paths(safe_args)

        def rejected_without_writes(candidate):
            candidate.output.parent.mkdir(parents=True, exist_ok=True)
            temporary = candidate.output.with_suffix(candidate.output.suffix + ".tmp")
            candidate.output.write_bytes(b"preserve output")
            temporary.write_bytes(b"preserve temporary")
            with patch.dict(globals(), {"arguments": lambda: candidate}), redirect_stdout(io.StringIO()):
                assert main() == 1
            assert candidate.output.read_bytes() == b"preserve output"
            assert temporary.read_bytes() == b"preserve temporary"

        for output in (safe_root / "fp32/laya.onnx", safe_root / "reference/model.safetensors",
                       safe_args.data_dir / "blind_test_v4.jsonl", safe_args.records_dir / "record.json"):
            rejected_without_writes(SimpleNamespace(**{**vars(safe_args), "output": output}))
        rejected_without_writes(SimpleNamespace(**{**vars(safe_args),
                                "checkpoint": DATA.parent / "checkpoints/pugport-laya-v4"}))
        rejected_without_writes(SimpleNamespace(**{**vars(safe_args), "onnx_root": safe_args.data_dir}))
        # Model canonical symlink targets without requiring Windows symlink privileges.
        resolve = Path.resolve
        protected_target = safe_args.data_dir / "blind_test_v4.jsonl"
        for alias in (safe_args.output.with_suffix(".json.tmp"),
                      safe_args.output.with_name("evaluation.int8_threads_4.json"),
                      safe_root / "reference"):
            def canonical(path, *args, **kwargs):
                return resolve(protected_target if path == alias else path, *args, **kwargs)
            with patch.object(Path, "resolve", canonical):
                rejected_without_writes(safe_args)

    class CharacterTokenizer:
        mask_token = "[MASK]"

        def __call__(self, text, **kwargs):
            return {"input_ids": [ord(character) for character in text]}

        def decode(self, ids, **kwargs):
            return "".join(chr(token) for token in ids)

    long_state = synthetic_state(2)[1]
    before = json.dumps(long_state)
    packed, packing = WORKER.pack_state(long_state, CharacterTokenizer(), 512)
    assert packing["input_compacted"] and packing["packed_state_tokens"] <= 512
    assert WORKER.valid_state(packed) and json.dumps(long_state) == before

    def scores(losses):
        per = {q: {"total": 1000, "accuracy": 0.9 - losses.get(q, 0) / 100} for q in WORKER.CHOICES}
        return {"micro": {"total": 10000, "accuracy": sum(item["accuracy"] for item in per.values()) / 10}, "per_question": per}

    def decision(losses, second=None):
        return recommendation({"torch": {"datasets": {name: scores({}) for name in DATASETS[:2]}},
                               **{backend: {"datasets": {DATASETS[0]: scores(losses), DATASETS[1]: scores(second or {})}}
                                  for backend in ("fp32", "int8")}})

    assert decision({q: 1 for q in WORKER.CHOICES})["selected"] == "int8"
    assert decision({q: 1.01 for q in WORKER.CHOICES})["selected"] == "fp32"
    assert decision({"task_type": 3})["selected"] == "int8"
    assert decision({"task_type": 3.01})["selected"] == "fp32"
    assert decision({}, {"task_type": 4})["selected"] == "fp32"
    assert decision({q: -4 for q in WORKER.CHOICES})["selected"] == "int8"
    assert recommendation({})["selected"] == "unmeasured"
    invalid = scores({})
    invalid["micro"]["total"] = 0
    try:
        recommendation({"torch": {"datasets": {DATASETS[0]: invalid}},
                        "fp32": {"datasets": {DATASETS[0]: scores({})}}})
        raise AssertionError("zero denominator accepted")
    except ValueError:
        pass
    calls = []

    class Options:
        def __init__(self):
            self.entries = {}

        def add_session_config_entry(self, key, value):
            self.entries[key] = value

    original = lambda *args, **kwargs: calls.append(kwargs)
    fake = SimpleNamespace(InferenceSession=original, SessionOptions=Options,
                           ExecutionMode=SimpleNamespace(ORT_SEQUENTIAL="sequential"))
    try:
        with capped_sessions(fake, 4):
            fake.InferenceSession("synthetic.onnx", providers=["CUDAExecutionProvider"])
            raise ValueError("synthetic")
    except ValueError:
        pass
    assert fake.InferenceSession is original
    options = calls[0]["sess_options"]
    assert calls[0]["providers"] == ["CPUExecutionProvider"]
    assert (options.intra_op_num_threads, options.inter_op_num_threads, options.execution_mode) == (4, 1, "sequential")
    assert set(options.entries.values()) == {"0"}
    print(json.dumps({"self_test": "passed", "dependencies": "stdlib only", "synthetic_states": 210}))


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--mode", choices=("accuracy", "latency", "all"), default="all")
    parser.add_argument("--checkpoint", type=Path, default=CACHE / "reference")
    parser.add_argument("--onnx-root", type=Path, default=CACHE)
    parser.add_argument("--data-dir", type=Path, default=DATA)
    parser.add_argument("--records-dir", type=Path, default=RECORDS)
    parser.add_argument("--output", type=Path, default=CACHE / "evaluation.json")
    parser.add_argument("--torch-device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--requests", type=int, default=210)
    parser.add_argument("--warmup", type=int, default=6)
    parser.add_argument("--cpu-limit", type=float, default=65)
    parser.add_argument("--throttle-timeout", type=float, default=60)
    parser.add_argument("--child-backend", choices=("fp32", "int8"), help=argparse.SUPPRESS)
    parser.add_argument("--child-threads", type=int, choices=(2, 4), default=2, help=argparse.SUPPRESS)
    return parser.parse_args()


def main():
    args = arguments()
    if args.self_test:
        self_test()
        return 0
    report = {"schema_version": 1, "status": "running", "mode": args.mode,
              "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "platform": sys.platform, "cpu_limit_percent": args.cpu_limit, "stage": "validation",
              "recommendation": {"selected": "unmeasured"}}
    report_path_valid = False
    try:
        validate_paths(args)
        report_path_valid = True
        if (args.requests < 200 or args.warmup < 1 or not 0 < args.cpu_limit <= 65
                or not math.isfinite(args.throttle_timeout) or args.throttle_timeout <= 0):
            raise ValueError("limits")
        import psutil
        report["versions"] = {name: importlib.metadata.version(name) for name in
                              ("laya", "torch", "transformers", "onnxruntime", "numpy", "psutil")}
        if os.name == "nt":
            psutil.Process().nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
        if args.child_backend:
            latency_child(args, report)
            return 0
        write_report(args.output, report)
        report["stage"] = "artifact_verification"
        report["artifacts"] = verify_artifacts(args)
        write_report(args.output, report)
        if args.mode in ("accuracy", "all"):
            accuracy(args, report)
        if args.mode in ("latency", "all"):
            latency(args, report)
        report["status"] = "complete"
        report["stage"] = "complete"
        write_report(args.output, report)
        print(json.dumps({"status": "complete", "mode": args.mode, "recommendation": report["recommendation"]["selected"]}))
        return 0
    except (Exception, KeyboardInterrupt) as error:
        report["status"] = "failed"
        report["error_type"] = type(error).__name__
        if isinstance(error, HostMemoryPressure):
            report["error_code"] = "host_available_memory_below_2_GiB"
            report["available_memory_bytes"] = error.available_bytes
        if report_path_valid:
            try:
                write_report(args.output, report)
            except Exception:
                pass
        print(json.dumps({"status": "failed", "stage": report["stage"], "error_type": type(error).__name__}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
