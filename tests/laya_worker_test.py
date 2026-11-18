"""Token budgeting checks without loading model weights or requiring CUDA."""
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "laya_worker", Path(__file__).resolve().parents[1] / "scripts" / "laya-worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class CharacterTokenizer:
    mask_token = "[MASK]"

    def __call__(self, text, *, add_special_tokens, truncation):
        assert add_special_tokens is False
        assert truncation is False
        return {"input_ids": list(map(ord, text))}

    def decode(self, ids, *, clean_up_tokenization_spaces):
        assert clean_up_tokenization_spaces is False
        return "".join(map(chr, ids))


def state(message="Hello"):
    return {"message": message, "recent_context": "", "reference_text": "",
            "attachments": [], "candidate_executors": []}


class PackingTest(unittest.TestCase):
    def test_short_input_is_unchanged(self):
        original = state("只需要解释概念，不要修改代码。")
        packed, usage = worker.pack_state(original, CharacterTokenizer(), 874)
        self.assertEqual(original, packed)
        self.assertFalse(usage["input_compacted"])
        self.assertEqual(usage["original_state_tokens"], usage["packed_state_tokens"])

    def test_long_background_keeps_final_question_and_small_metadata(self):
        question = "Can we train a model for this, and which training and serving hardware is needed?"
        original = state("Only investigate, do not change files. " + "Business process background. " * 150 + question)
        original["recent_context"] = "We are comparing a model with deterministic rules."
        original["attachments"] = [{"kind": "image", "name": "diagram.png"}]
        original["candidate_executors"] = ["Muse", "Claude"]
        packed, usage = worker.pack_state(original, CharacterTokenizer(), 874)
        self.assertTrue(packed["message"].startswith("Only investigate, do not change files."))
        self.assertTrue(packed["message"].endswith(question))
        self.assertEqual(original["attachments"], packed["attachments"])
        self.assertEqual(original["candidate_executors"], packed["candidate_executors"])
        self.assertGreater(usage["original_state_tokens"], 874)
        self.assertLessEqual(usage["packed_state_tokens"], 874)
        self.assertTrue(usage["input_compacted"])
        self.assertIn("message", usage["compacted_fields"])
        self.assertNotIn("omitted", original["message"])

    def test_large_context_references_and_metadata_are_bounded_and_reported(self):
        original = state("Explain the attached files.")
        original["recent_context"] = "old context " * 1000 + "Newest relevant context."
        original["reference_text"] = "Reference " * 1000
        original["attachments"] = [{"kind": "image", "name": "a" * 512} for _ in range(32)]
        original["candidate_executors"] = ["A" * 128 for _ in range(32)]
        before = json.dumps(original)
        packed, usage = worker.pack_state(original, CharacterTokenizer(), 874)
        self.assertEqual(set(original), set(packed))
        self.assertEqual(packed["message"], original["message"])
        self.assertLessEqual(usage["packed_state_tokens"], 874)
        self.assertTrue(packed["recent_context"].endswith("Newest relevant context."))
        self.assertIn("attachments", usage["compacted_fields"])
        self.assertIn("candidate_executors", usage["compacted_fields"])
        self.assertEqual(before, json.dumps(original))

    def test_impossible_budget_does_not_silently_drop_schema(self):
        with self.assertRaisesRegex(ValueError, "state_budget_too_small"):
            worker.pack_state(state("Hi"), CharacterTokenizer(), 1)

    def test_metadata_pressure_keeps_a_short_request_tail(self):
        question = "Only compare the costs; do not buy anything."
        original = state(question)
        original["attachments"] = [{"kind": "image", "name": "图" * 512} for _ in range(32)]
        original["candidate_executors"] = ["代理" * 64 for _ in range(32)]
        packed, usage = worker.pack_state(original, CharacterTokenizer(), 874)
        self.assertEqual(packed["message"], question)
        self.assertTrue(usage["input_compacted"])
        self.assertLessEqual(usage["packed_state_tokens"], 874)
        self.assertTrue(worker.valid_state(packed))

    def test_empty_request_with_only_metadata_remains_a_valid_state(self):
        original = state("")
        original["attachments"] = [{"kind": "image", "name": "图" * 512} for _ in range(32)]
        packed, usage = worker.pack_state(original, CharacterTokenizer(), 874)
        self.assertEqual(packed["message"], "")
        self.assertTrue(worker.valid_state(packed))
        self.assertTrue(usage["input_compacted"])
        self.assertLessEqual(usage["packed_state_tokens"], 874)


if __name__ == "__main__":
    unittest.main()
