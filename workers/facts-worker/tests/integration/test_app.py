import os
import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient

from app import app


@pytest.fixture
def client():
    return TestClient(app)


class TestExtractEndpoint:
    @patch("rlm_facts._get_program")
    def test_extract_empty_context_mocked(self, mock_get_program: MagicMock, client: TestClient):
        mock_program = MagicMock()
        mock_program.return_value.facts_json = '''{"entities": [], "claims": [], "risks": [], "assumptions": [], "contradictions": [], "goals": [], "confidence": 1.0}'''
        mock_get_program.return_value = mock_program
        resp = client.post(
            "/extract",
            json={"context": [], "previous_facts": None},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "facts" in data
        assert "drift" in data
        assert data["facts"]["version"] == 2
        assert data["facts"]["entities"] == []
        assert data["drift"]["level"] == "none"
        assert "types" in data["drift"]

    @patch("rlm_facts._get_program")
    def test_extract_with_context_mocked(self, mock_get_program: MagicMock, client: TestClient):
        mock_program = MagicMock()
        mock_program.return_value.facts_json = '''{"entities": ["RustFS"], "claims": ["We use RustFS"], "risks": [], "assumptions": [], "contradictions": [], "goals": ["storage"], "confidence": 0.85}'''
        mock_get_program.return_value = mock_program
        resp = client.post(
            "/extract",
            json={
                "context": [{"text": "We use RustFS for storage."}, {"text": "Drift detected."}],
                "previous_facts": None,
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["facts"]["version"] == 2
        assert "RustFS" in data["facts"]["entities"]
        assert "hash" in data["facts"]
        assert data["drift"]["facts_hash"] == data["facts"]["hash"]
        assert "types" in data["drift"]

    @patch("rlm_facts._get_program")
    def test_extract_with_previous_facts_returns_drift(self, mock_get_program: MagicMock, client: TestClient):
        mock_program = MagicMock()
        mock_program.return_value.facts_json = '''{"entities": [], "claims": ["First"], "risks": [], "assumptions": [], "contradictions": [], "goals": [], "confidence": 0.9}'''
        mock_get_program.return_value = mock_program
        resp1 = client.post(
            "/extract",
            json={"context": [{"text": "First event."}], "previous_facts": None},
        )
        assert resp1.status_code == 200
        prev = resp1.json()["facts"]

        mock_program.return_value.facts_json = '''{"entities": [], "claims": ["First", "Second"], "risks": [], "assumptions": [], "contradictions": [], "goals": ["evolve"], "confidence": 0.8}'''
        mock_get_program.return_value = mock_program
        resp2 = client.post(
            "/extract",
            json={
                "context": [{"text": "First event."}, {"text": "Second event."}],
                "previous_facts": prev,
            },
        )
        assert resp2.status_code == 200
        data = resp2.json()
        assert data["drift"]["level"] in ("none", "low", "high")
        assert "types" in data["drift"]
