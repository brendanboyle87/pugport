"""Export the installed Laya decision model; keep all weights outside the repository."""

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import sys
import time

sys.dont_write_bytecode = True
for key, value in {
    "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
    "HF_HUB_DISABLE_TELEMETRY": "1", "TOKENIZERS_PARALLELISM": "false",
    "OMP_NUM_THREADS": "2", "MKL_NUM_THREADS": "2", "OPENBLAS_NUM_THREADS": "2",
    "LAYA_CPU_AMP": "0", "USE_TF": "0",
}.items():
    os.environ[key] = value

CHECKPOINT = Path(os.environ.get("LAYA_CHECKPOINT_DIR", Path.home() / "laya-routing-dataset/checkpoints/pugport-laya-v4"))
OUTPUT = Path.home() / ".cache/pp-laya/onnx/pugport-laya-v4"
MODEL_SHA256 = "4445f9401b321a94ebc3614d231847dc08beaa0c9ccc3fded8dc39f90e8bb4b9"
INPUTS = ["input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"]
OUTPUTS = ["logits", "act_logits"]
UPSTREAM = "https://github.com/NandhaKishorM/laya/blob/main/scripts/export_onnx.py"


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def inventory(directory):
    return {
        path.relative_to(directory).as_posix(): {"sha256": sha256(path), "bytes": path.stat().st_size}
        for path in sorted(directory.rglob("*"))
        if path.is_file() and path.name != "manifest.json"
    }


def check_destination(checkpoint, output, verify_existing=False):
    repo = Path(__file__).resolve().parent.parent
    if output == repo or repo in output.parents:
        raise ValueError("Model outputs must be outside the repository")
    if output == checkpoint or checkpoint in output.parents or output in checkpoint.parents:
        raise ValueError("Output and original checkpoint must be separate")
    if output.is_relative_to((Path.home() / "PugPort").resolve()):
        raise ValueError("Outputs must not touch the live PugPort directory")
    if not verify_existing and output.exists() and any(output.iterdir()):
        raise FileExistsError("Output is not empty; preserve it and choose a fresh directory")
    if verify_existing:
        for name in ("reference", "fp32", "int8"):
            directory = (output / name).resolve(strict=True)
            if not directory.is_relative_to(output) or directory == output:
                raise ValueError("Staged directory resolves outside its output tree")
            for relative in ("tokenizer", "tokenizer/tokenizer_config.json", "manifest.json"):
                if not (directory / relative).resolve().is_relative_to(directory):
                    raise ValueError("Staged writable metadata resolves outside its directory")


def copy_metadata(source, destination):
    destination.mkdir(parents=True, exist_ok=True)
    for name in ("rl_agent_config.json", "questions.json"):
        shutil.copy2(source / name, destination / name)
    for name in ("tokenizer", "encoder"):
        shutil.copytree(source / name, destination / name)


def session_options(threads=2):
    import onnxruntime as ort
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    options.add_session_config_entry("session.inter_op.allow_spinning", "0")
    return options


def example_inputs(batch=2, length=32, markers=2):
    import torch
    ids = (torch.arange(batch * length).reshape(batch, length) % 100) + 1
    attention = torch.ones_like(ids)
    positions = torch.arange(1, markers + 1).repeat(batch, 1)
    mask = torch.ones(batch, markers, dtype=torch.bool)
    for row in range(1, batch):
        attention[row, max(markers + 1, length - row):] = 0
        mask[row, -1] = False
    return ids, attention, positions, mask, torch.arange(batch) % 3


def verify_graph(model, graph_path, quantized=False):
    """Exercise dynamic rows, sequence lengths, marker widths and the package collator."""
    import numpy as np
    import onnxruntime as ort
    import torch
    from laya.onnx_agent import _collate_items_numpy

    session = ort.InferenceSession(str(graph_path), sess_options=session_options(),
                                   providers=["CPUExecutionProvider"])
    if [item.name for item in session.get_inputs()] != INPUTS:
        raise ValueError("ONNX input contract differs from ONNXAgent")
    checks = []
    for batch, length, markers in ((1, 32, 2), (2, 64, 3), (3, 128, 4), (10, 256, 10)):
        values = example_inputs(batch, length, markers)
        items = []
        for ids, att, pos, mask, qt in zip(*values):
            items.append({"ids": ids[att.bool()].tolist(), "markers": pos[mask].tolist(), "qtype": int(qt)})
        feed = _collate_items_numpy([items], 0)
        with torch.inference_mode():
            expected = model(*(torch.from_numpy(feed[name]) for name in INPUTS))
        actual = session.run(OUTPUTS, feed)
        differences = {}
        for name, want, got in zip(OUTPUTS, expected, actual):
            want = want.numpy()
            if want.shape != got.shape or not np.isfinite(got).all():
                raise ValueError(f"Invalid {name} output at shape {(batch, length, markers)}")
            def probabilities(value):
                exponent = np.exp(value - value.max(axis=-1, keepdims=True))
                return exponent / exponent.sum(axis=-1, keepdims=True)
            difference = float(np.abs(probabilities(want) - probabilities(got)).max())
            differences[name] = difference
            # INT8 drift is measured here; labeled-set accuracy decides its acceptance.
            if not quantized and difference > 0.001:
                raise ValueError(f"{name} probability drift {difference} at {(batch, length, markers)}")
        checks.append({"shape": [batch, length, markers], "max_probability_difference": differences,
                       "upstream_smoke_tolerance_met": max(differences.values()) <= (0.1 if quantized else 0.001)})
    return checks


def self_test():
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "payload").write_bytes(b"abc")
        assert inventory(root)["payload"]["sha256"] == hashlib.sha256(b"abc").hexdigest()
        (root / "manifest.json").write_text("{}", encoding="utf-8")
        assert set(inventory(root)) == {"payload"}
        try:
            check_destination(root / "source", root)
        except ValueError:
            pass
        else:
            raise AssertionError("Nested checkpoint accepted")
    print("export self-test: passed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, default=CHECKPOINT)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--verify-existing", action="store_true",
                        help="Recheck existing graphs and write manifests without exporting or quantizing again")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    checkpoint, output = args.checkpoint.resolve(strict=True), args.output.resolve()
    check_destination(checkpoint, output, args.verify_existing)
    if sha256(checkpoint / "model.safetensors") != MODEL_SHA256:
        raise ValueError("Checkpoint SHA256 does not match production v4")
    original_files = inventory(checkpoint)
    reference = output / "reference"
    # Laya can fix tokenizer metadata during load; it must only touch this private copy.
    if not args.verify_existing:
        output.mkdir(parents=True)
        copy_metadata(checkpoint, reference)
        shutil.copy2(checkpoint / "model.safetensors", reference / "model.safetensors")
    elif sha256(reference / "model.safetensors") != MODEL_SHA256:
        raise ValueError("Existing reference checkpoint SHA256 differs from v4")

    import psutil
    import torch
    import laya
    import onnx
    from onnxruntime.quantization import QuantType, quantize_dynamic
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    if os.name == "nt":
        psutil.Process().nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
    if psutil.cpu_percent(interval=1) >= 65:
        raise RuntimeError("System CPU is already at least 65%; retry when idle")
    started = time.perf_counter()
    agent = laya.load(str(reference), device="cpu", compile=False,
                      expected_sha256={"model.safetensors": MODEL_SHA256})
    model = agent.model.float().eval()
    if agent.cfg.get("option_layout", "sequential") != "sequential":
        raise ValueError("ONNXAgent requires sequential option layout")
    if not args.verify_existing:
        for variant in ("fp32", "int8"):
            copy_metadata(reference, output / variant)
    fp32 = output / "fp32/laya.onnx"
    axes = {name: {0: "batch_size"} for name in INPUTS + OUTPUTS}
    for name in ("input_ids", "attention_mask"):
        axes[name][1] = "seq_len"
    for name in ("marker_pos", "marker_mask", "logits"):
        axes[name][1] = "num_markers"
    if not args.verify_existing:
        print("Exporting Laya DecisionModel on CPU with two threads", flush=True)
        # Same graph/API as upstream scripts/export_onnx.py; no replacement encoder or head.
        torch.onnx.export(model, example_inputs(), str(fp32), export_params=True,
                          opset_version=18, input_names=INPUTS, output_names=OUTPUTS,
                          dynamic_axes=axes, dynamo=True)
    onnx.checker.check_model(str(fp32))
    checks = {"fp32": verify_graph(model, fp32)}
    int8 = output / "int8/laya.onnx"
    if not args.verify_existing:
        print("FP32 dynamic-shape checks passed; quantizing MatMul weights", flush=True)
        graph = onnx.load(str(fp32))
        del graph.graph.value_info[:]
        quantize_dynamic(graph, str(int8), op_types_to_quantize=["MatMul"],
                         weight_type=QuantType.QInt8, per_channel=False)
        del graph
    onnx.checker.check_model(str(int8))
    checks["int8"] = verify_graph(model, int8, quantized=True)
    if inventory(checkpoint) != original_files:
        raise RuntimeError("Original checkpoint changed during export")
    versions = {name: importlib.metadata.version(name) for name in
                ("laya", "torch", "transformers", "onnx", "onnxruntime", "onnxscript")}
    for variant in ("fp32", "int8"):
        directory = output / variant
        graph = onnx.load(str(directory / "laya.onnx"), load_external_data=False)
        operators = dict(sorted(Counter(f"{n.domain or 'ai.onnx'}::{n.op_type}" for n in graph.graph.node).items()))
        manifest = {
            "created_utc": datetime.now(timezone.utc).isoformat(),
            "source_model_sha256": MODEL_SHA256, "versions": versions,
            "export_contract_source": UPSTREAM, "variant": variant,
            "quantization": {"operator": "MatMul", "weight_type": "QInt8", "per_channel": False} if variant == "int8" else None,
            "providers_verified": ["CPUExecutionProvider"], "intra_op_threads": 2,
            "dynamic_shape_checks": checks[variant], "operators": operators,
            "files": inventory(directory),
            "manifest_note": "Every payload file is hashed; manifest.json excludes itself to avoid self-reference.",
        }
        (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": "graphs_runnable_accuracy_unmeasured",
                      "int8_upstream_smoke_tolerance_met": all(c["upstream_smoke_tolerance_met"] for c in checks["int8"]),
                      "seconds": round(time.perf_counter() - started, 3), "versions": versions}))


if __name__ == "__main__":
    main()
