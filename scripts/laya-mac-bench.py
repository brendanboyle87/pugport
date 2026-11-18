"""Benchmark one Laya backend on this machine: accuracy on the labelled sets, then serial latency and RSS.

Usage: python laya-mac-bench.py <onnx|mps|mps32|cpu> <root>
<root> holds models/{reference,fp32}, data/*.jsonl and laya-worker.py (for pack_state).
Synthetic latency text only; no network, no chat data.
"""
import importlib.util
import json
import resource
import statistics
import sys
import time
from pathlib import Path

backend, root = sys.argv[1], Path(sys.argv[2])
spec = importlib.util.spec_from_file_location("worker", root / "laya-worker.py")
WORKER = importlib.util.module_from_spec(spec)
spec.loader.exec_module(WORKER)


def rss_mb():
    # macOS reports ru_maxrss in bytes.
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024 / 1024


started = time.perf_counter()
import torch
torch.set_num_threads(4)
import laya
from laya.common import state_room

if backend == "onnx":
    import onnxruntime as ort
    from laya.onnx_agent import ONNXAgent
    agent = ONNXAgent(str(root / "models/fp32"), onnx_path=str(root / "models/fp32/laya.onnx"))
else:
    agent = laya.load(str(root / "models/reference"), device=backend.removesuffix("32"), backend="eager", fast=False, compile=False)
    if backend == "mps32":
        # Full precision on the Apple GPU: no autocast, FP32 weights.
        agent.model.float()
        agent.amp_enabled = False
        agent.dtype = torch.float32
load_s = time.perf_counter() - started
questions = json.loads((root / "models/reference/questions.json").read_text())
budget = min(state_room(agent.tok, agent._to_internal(q), agent.cfg.get("max_len", 512),
                        agent.cfg.get("head_max_len", 192)) for q in questions.values())


def run(state, qs):
    packed, _ = WORKER.pack_state(state, agent.tok, budget)
    with torch.inference_mode():
        raw = agent.predict(packed, qs)
    if backend.startswith("mps"):
        torch.mps.synchronize()
    return {name: answer.get("choice") for name, answer in raw["answers"].items()}


accuracy = {}
for name in ("blind_test_v4", "calibration_v4"):
    right = total = 0
    for line in (root / f"data/{name}.jsonl").read_text(encoding="utf-8").splitlines():
        row = json.loads(line)
        got = run(row["state"], row["questions"])
        for key, want in row["expected"].items():
            total += 1
            right += got.get(key) == want
    accuracy[name] = f"{right}/{total} ({100 * right / total:.2f}%)"

base = "Please refactor the payment module, add tests, and explain the trade-offs. "
lengths = {"short": "Translate hello to French.", "medium": base * 8, "long": base * 120}
for _ in range(5):
    run({"message": lengths["medium"], "recent_context": "", "reference_text": "",
         "attachments": [], "candidate_executors": []}, questions)
latency = {}
for label, text in lengths.items():
    times = []
    for i in range(40):
        state = {"message": f"{i} {text}", "recent_context": base * 4 if label != "short" else "",
                 "reference_text": "", "attachments": [], "candidate_executors": ["codex", "claude"]}
        t = time.perf_counter()
        run(state, questions)
        times.append((time.perf_counter() - t) * 1000)
    times.sort()
    latency[label] = {"p50_ms": round(statistics.median(times)), "p95_ms": round(times[int(len(times) * 0.95) - 1]),
                      "max_ms": round(times[-1])}
print(json.dumps({"backend": backend, "load_s": round(load_s, 1), "peak_rss_mb": round(rss_mb()),
                  "accuracy": accuracy, "latency": latency}, indent=1))
