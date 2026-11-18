"""Offline CUDA-only Laya worker. NDJSON on stdio; no network listener or task execution."""
import argparse
from contextlib import redirect_stdout, redirect_stderr
import json
import os
from pathlib import Path
import sys

MODEL_VERSION = "pugport-laya-v4"
MODEL_SHA256 = "4445f9401b321a94ebc3614d231847dc08beaa0c9ccc3fded8dc39f90e8bb4b9"
MAX_INPUT = 64 * 1024
MAX_OUTPUT = 256 * 1024
CHOICES = {
    "task_type": ["conversation", "coding", "research", "writing", "translation", "data_analysis", "media", "automation", "mixed", "unclear"],
    "difficulty": ["simple", "standard", "complex", "unclear"],
    "web_search": ["yes", "no", "unclear"],
    "input_modality": ["text", "image", "audio", "video", "mixed", "unclear"],
    "document_read": ["yes", "no", "unclear"],
    "media_output": ["none", "image_create", "image_edit", "speech", "music", "video_generate", "video_render", "mixed", "unclear"],
    "project_access": ["none", "read", "write", "unclear"],
    "run_commands": ["yes", "no", "unclear"],
    "browser_use": ["yes", "no", "unclear"],
    "executor_intent": ["none", "assign", "exclude", "reassign", "mention_only", "unclear"],
}

for key, value in {
    "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "USE_TF": "0",
    "HF_HUB_DISABLE_TELEMETRY": "1", "TOKENIZERS_PARALLELISM": "false",
    "OMP_NUM_THREADS": "2", "MKL_NUM_THREADS": "2",
}.items():
    os.environ[key] = value


def emit(message):
    line = json.dumps(message, ensure_ascii=False, allow_nan=False).encode("utf-8") + b"\n"
    if len(line) > MAX_OUTPUT:
        raise ValueError("output_too_large")
    sys.stdout.buffer.write(line)
    sys.stdout.buffer.flush()


def valid_text(value, maximum):
    return isinstance(value, str) and len(value) <= maximum


def valid_state(state):
    if not isinstance(state, dict) or set(state) != {"message", "recent_context", "reference_text", "attachments", "candidate_executors"}:
        return False
    if any(not valid_text(state.get(key), 32768) for key in ["message", "recent_context", "reference_text"]):
        return False
    attachments = state["attachments"]
    executors = state["candidate_executors"]
    return (
        isinstance(attachments, list) and len(attachments) <= 32
        and all(isinstance(item, dict) and set(item) <= {"kind", "name", "mime_type"}
                and valid_text(item.get("kind"), 64) and valid_text(item.get("name"), 512)
                and ("mime_type" not in item or valid_text(item["mime_type"], 256)) for item in attachments)
        and isinstance(executors, list) and len(executors) <= 32
        and all(valid_text(item, 128) for item in executors)
    )


def pack_state(state, tokenizer, budget):
    """Keep both ends of the request and budget all fields before Laya's prefix clamp."""
    def encode(text):
        return tokenizer(text.replace(tokenizer.mask_token, " "),
                         add_special_tokens=False, truncation=False)["input_ids"]

    def size(value):
        return len(encode(json.dumps(value, ensure_ascii=False)))

    original_size = size(state)
    packed = dict(state)
    text_ids = {key: encode(state[key])
                for key in ("message", "recent_context", "reference_text")}
    limits = {key: len(ids) for key, ids in text_ids.items()}
    changed = set()
    packed_size = original_size
    while packed_size > budget:
        # The current instruction gets most room; context and metadata still get a share.
        weights = {"message": 6, "recent_context": 1, "reference_text": 2,
                   "attachments": 2, "candidate_executors": 1}
        candidates = [key for key, value in packed.items() if value]
        if not candidates:
            raise ValueError("state_budget_too_small")
        key = max(candidates, key=lambda name: size(packed[name]) / weights[name])
        if key in text_ids:
            limit = limits[key] = max(0, limits[key] // 2)
            ids = text_ids[key]
            if limit < 16:
                packed[key] = ""
            elif key == "recent_context":
                packed[key] = tokenizer.decode(ids[-limit:], clean_up_tokenization_spaces=False)
            else:
                head = limit // 3
                packed[key] = (tokenizer.decode(ids[:head], clean_up_tokenization_spaces=False)
                               + "\n[... omitted ...]\n"
                               + tokenizer.decode(ids[-(limit - head):], clean_up_tokenization_spaces=False))
        else:
            packed[key] = packed[key][:len(packed[key]) // 2]
        changed.add(key)
        packed_size = size(packed)
    return packed, {
        "input_compacted": bool(changed),
        "original_state_tokens": original_size,
        "packed_state_tokens": packed_size,
        "state_token_budget": budget,
        "compacted_fields": sorted(changed),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", required=True)
    args = parser.parse_args()
    checkpoint = Path(args.checkpoint).resolve(strict=True)
    question_file = checkpoint / "questions.json"
    if question_file.stat().st_size > MAX_INPUT:
        raise ValueError("questions_too_large")
    questions = json.loads(question_file.read_text(encoding="utf-8"))
    if not isinstance(questions, dict) or set(questions) != set(CHOICES):
        raise ValueError("invalid_questions")
    for key, choices in CHOICES.items():
        question = questions[key]
        if not isinstance(question, dict) or question.get("type") != "choice" or not isinstance(question.get("criteria"), dict) or set(question["criteria"]) != set(choices):
            raise ValueError("invalid_questions")

    # Dependency output is fully redacted; only the bounded protocol reaches the parent.
    with open(os.devnull, "w", encoding="utf-8") as quiet, redirect_stdout(quiet), redirect_stderr(quiet):
        import torch
        torch.set_num_threads(2)
        torch.set_num_interop_threads(1)
        if not torch.cuda.is_available():
            supported = False
        else:
            supported = True
            proof = torch.tensor([1.0, 2.0, 3.0], device="cuda")
            if proof.device.type != "cuda" or proof.sum().item() != 6.0:
                raise RuntimeError("cuda_verification_failed")
            torch.cuda.synchronize()
            import laya
            # Allocate directly in VRAM, avoiding an intermediate FP32 CPU model.
            with torch.device("cuda"):
                agent = laya.load(str(checkpoint), device="cuda", compile=False,
                                  expected_sha256={"model.safetensors": MODEL_SHA256})
            if agent.device.type != "cuda":
                raise RuntimeError("cuda_verification_failed")
            from laya.common import state_room
            state_budget = min(state_room(agent.tok, agent._to_internal(question),
                                          agent.cfg.get("max_len", 512),
                                          agent.cfg.get("head_max_len", 192))
                               for question in questions.values())
            # Prime CUDA kernels before the parent's short per-request deadline applies.
            with torch.inference_mode():
                agent.predict({"message": "Hello.", "recent_context": "", "reference_text": "",
                               "attachments": [], "candidate_executors": []}, questions)
            torch.cuda.synchronize()
    if not supported:
        emit({"type": "unsupported", "reason": "cuda_unavailable"})
        return
    emit({"type": "ready", "modelVersion": MODEL_VERSION, "modelSha256": MODEL_SHA256, "device": str(agent.device)})

    while True:
        line = sys.stdin.buffer.readline(MAX_INPUT + 1)
        if not line:
            return
        if len(line) > MAX_INPUT or not line.endswith(b"\n"):
            raise ValueError("input_too_large")
        request = json.loads(line)
        if not isinstance(request, dict) or set(request) != {"type", "id", "state"} or request["type"] != "predict" or not valid_text(request["id"], 64) or not request["id"] or not valid_state(request["state"]):
            raise ValueError("invalid_request")
        with open(os.devnull, "w", encoding="utf-8") as quiet, redirect_stdout(quiet), redirect_stderr(quiet):
            with torch.inference_mode():
                state, packing = pack_state(request["state"], agent.tok, state_budget)
                raw = agent.predict(state, questions)
                raw.setdefault("usage", {}).update(packing)
                torch.cuda.synchronize()
        emit({"type": "result", "id": request["id"], "raw": raw})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Exception text can include input data or paths. Never put it in the protocol/log.
        emit({"type": "error", "reason": "worker_failed"})
        sys.exit(1)
