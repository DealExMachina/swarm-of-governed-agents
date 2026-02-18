import pytest
from unittest.mock import patch, MagicMock
from rlm_facts import (
    stable_hash,
    compute_drift,
    extract_facts_and_drift,
    Facts,
    Drift,
)


class TestStableHash:
    def test_deterministic(self):
        obj = {"a": 1, "b": 2}
        assert stable_hash(obj) == stable_hash(obj)

    def test_different_objects_different_hashes(self):
        assert stable_hash({"a": 1}) != stable_hash({"a": 2})
        assert stable_hash({"a": 1}) != stable_hash({"b": 1})


class TestComputeDrift:
    def test_no_previous_facts(self):
        facts = Facts(updated_at="2025-01-01T00:00:00Z", hash="abc123")
        drift = compute_drift(facts, None)
        assert drift.level == "none"
        assert "initial snapshot" in drift.notes
        assert drift.facts_hash == "abc123"

    def test_identical_claims_and_goals_no_drift(self):
        facts = Facts(
            updated_at="2025-01-01T00:00:00Z",
            claims=["c1"],
            goals=["g1"],
            confidence=0.9,
            hash="h1",
        )
        old = {"claims": ["c1"], "goals": ["g1"], "confidence": 0.9}
        drift = compute_drift(facts, old)
        assert drift.level == "none"
        assert len(drift.types) == 0

    def test_claims_change_factual_drift(self):
        facts = Facts(
            updated_at="2025-01-01T00:00:00Z",
            claims=["c1", "c2"],
            goals=[],
            hash="h1",
        )
        old = {"claims": ["c1"], "goals": []}
        drift = compute_drift(facts, old)
        assert "factual" in drift.types
        assert drift.level == "low"

    def test_contradictions_high_drift(self):
        facts = Facts(
            updated_at="2025-01-01T00:00:00Z",
            claims=[],
            contradictions=["x contradicts y"],
            goals=[],
            hash="h1",
        )
        old = {"claims": [], "goals": [], "contradictions": []}
        drift = compute_drift(facts, old)
        assert "contradiction" in drift.types
        assert drift.level == "high"

    def test_confidence_drop_entropy_drift(self):
        facts = Facts(
            updated_at="2025-01-01T00:00:00Z",
            claims=["c1"],
            goals=[],
            confidence=0.5,
            hash="h1",
        )
        old = {"claims": ["c1"], "goals": [], "confidence": 0.9}
        drift = compute_drift(facts, old)
        assert "entropy" in drift.types


class TestExtractFactsAndDrift:
    @patch("rlm_facts._get_program")
    def test_returns_facts_and_drift_mocked(self, mock_get_program: MagicMock):
        mock_program = MagicMock()
        mock_program.return_value.facts_json = '''{"entities": [], "claims": ["hello"], "risks": [], "assumptions": [], "contradictions": [], "goals": [], "confidence": 0.9}'''
        mock_get_program.return_value = mock_program
        context = [{"text": "hello"}]
        facts, drift = extract_facts_and_drift(context, None)
        assert facts["version"] == 2
        assert "hash" in facts
        assert "entities" in facts
        assert "claims" in facts
        assert drift["level"] in ("none", "low", "high")
        assert drift["facts_hash"] == facts["hash"]
        assert "types" in drift
