import os
import json
import hashlib
from typing import List, Optional, Dict, Any, Tuple
from datetime import datetime

import dspy
from pydantic import BaseModel, Field

# -----------------------------
# DSPy LLM Setup (lazy so tests can run without litellm/openai deps)
# OpenAI-compatible: OpenAI, OpenRouter, Together, etc.
# -----------------------------

_lm = None
_program = None


_use_openai_fallback = False


def _get_lm():
    global _lm, _use_openai_fallback
    if _lm is not None:
        return _lm
    try:
        from dspy.clients.lm import LM as ConcreteLM
        _model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
        _model_str = f"openai/{_model}" if "/" not in _model else _model
        _lm_kwargs: Dict[str, Any] = {}
        if os.getenv("OPENAI_API_KEY"):
            _lm_kwargs["api_key"] = os.getenv("OPENAI_API_KEY")
        if os.getenv("OPENAI_BASE_URL"):
            _lm_kwargs["api_base"] = os.getenv("OPENAI_BASE_URL")
        _lm = ConcreteLM(model=_model_str, model_type="chat", **_lm_kwargs)
        dspy.settings.configure(lm=_lm)
        return _lm
    except (ImportError, TypeError):
        _use_openai_fallback = True
        return None


def _get_program():
    global _program, _use_openai_fallback
    if _program is not None:
        return _program
    if _use_openai_fallback:
        return None
    try:
        _get_lm()
        if _lm is not None:
            _program = dspy.Predict(ExtractFacts)
    except Exception:
        _use_openai_fallback = True
    return _program


def _call_openai_fallback(prompt_context: str, prompt_previous: str) -> str:
    """Use OpenAI client directly when DSPy LM is not available (e.g. in Docker)."""
    from openai import OpenAI
    client = OpenAI(
        api_key=os.getenv("OPENAI_API_KEY"),
        base_url=os.getenv("OPENAI_BASE_URL") or None,
    )
    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    user_content = f"""Context (recent events as JSON):
{prompt_context}

Previous facts (JSON):
{prompt_previous}

Extract structured facts. Reply with a single JSON object only (no markdown, no explanation) with these keys: entities (list of strings), claims (list), risks (list), assumptions (list), contradictions (list), goals (list), confidence (float 0-1)."""
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": user_content}],
        response_format={"type": "json_object"},
    )
    return (resp.choices[0].message.content or "{}").strip()

# -----------------------------
# Typed Models
# -----------------------------


class Facts(BaseModel):
    version: int = 2
    updated_at: str = ""
    entities: List[str] = Field(default_factory=list)
    claims: List[str] = Field(default_factory=list)
    risks: List[str] = Field(default_factory=list)
    assumptions: List[str] = Field(default_factory=list)
    contradictions: List[str] = Field(default_factory=list)
    goals: List[str] = Field(default_factory=list)
    confidence: float = 1.0
    hash: Optional[str] = None


class Drift(BaseModel):
    level: str
    types: List[str]
    notes: List[str]
    facts_hash: str
    references: List[Dict[str, Any]] = Field(default_factory=list, description="Sources and references (doc, excerpt, type)")


# -----------------------------
# DSPy Signature
# -----------------------------


class ExtractFacts(dspy.Signature):
    """Extract structured facts from context and previous facts. Output valid JSON only."""

    context = dspy.InputField(desc="Recent context events as JSON array")
    previous_facts = dspy.InputField(desc="Previous structured facts as JSON object")
    facts_json = dspy.OutputField(
        desc="Structured JSON object with keys: entities (list of strings), claims, risks, assumptions, contradictions, goals, confidence (float 0-1). No other text."
    )


# -----------------------------
# Helpers
# -----------------------------


def stable_hash(obj: Any) -> str:
    b = json.dumps(obj, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(b).hexdigest()


def _doc_titles_from_context(context: List[Dict[str, Any]]) -> List[str]:
    """Extract unique document titles/filenames from context events (e.g. context_doc)."""
    seen: set = set()
    out: List[str] = []
    for ev in context:
        if not isinstance(ev, dict):
            continue
        payload = ev.get("payload") or ev.get("data", {}).get("payload") or ev.get("data") or {}
        if isinstance(payload, dict):
            title = payload.get("title") or payload.get("filename") or payload.get("source")
            if title and isinstance(title, str) and title not in seen:
                seen.add(title)
                out.append(title)
        # Also support top-level title/filename on event
        for key in ("title", "filename"):
            v = ev.get(key)
            if v and isinstance(v, str) and v not in seen:
                seen.add(v)
                out.append(v)
    return out


def compute_drift(
    new: Facts,
    old: Optional[Dict[str, Any]],
    context: Optional[List[Dict[str, Any]]] = None,
) -> Drift:
    if not old:
        refs: List[Dict[str, Any]] = []
        if context:
            for doc in _doc_titles_from_context(context):
                refs.append({"type": "context_doc", "doc": doc})
        return Drift(
            level="none",
            types=[],
            notes=["initial snapshot"],
            facts_hash=new.hash or "",
            references=refs,
        )

    drift_types: List[str] = []
    references: List[Dict[str, Any]] = []

    if context:
        for doc in _doc_titles_from_context(context):
            references.append({"type": "context_doc", "doc": doc})

    if set(new.claims) != set(old.get("claims") or []):
        drift_types.append("factual")

    if set(new.goals) != set(old.get("goals") or []):
        drift_types.append("goal")

    if new.contradictions:
        drift_types.append("contradiction")
        for c in new.contradictions:
            if isinstance(c, str) and c.strip():
                references.append({"type": "contradiction", "excerpt": c.strip()})

    if new.confidence < (old.get("confidence") or 1.0):
        drift_types.append("entropy")

    level = "none"
    if drift_types:
        level = "low"
    if "contradiction" in drift_types:
        level = "high"

    return Drift(
        level=level,
        types=drift_types,
        notes=["automatic structured drift detection"],
        facts_hash=new.hash or "",
        references=references,
    )


# -----------------------------
# Main Entry
# -----------------------------


def extract_facts_and_drift(
    context: List[Dict[str, Any]],
    previous_facts: Optional[Dict[str, Any]],
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    prompt_context = json.dumps(context, indent=2)
    prompt_previous = json.dumps(previous_facts, indent=2) if previous_facts else "{}"

    program = _get_program()
    facts_json_str = None
    if program is not None:
        try:
            response = program(context=prompt_context, previous_facts=prompt_previous)
            facts_json_str = response.facts_json
        except Exception:
            facts_json_str = None
    if facts_json_str is None:
        facts_json_str = _call_openai_fallback(prompt_context, prompt_previous)

    # Force JSON parse (strip optional markdown code fence)
    raw = facts_json_str.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[-1] if "\n" in raw else raw[3:]
        raw = raw.rsplit("```", 1)[0].strip()
    facts_dict = json.loads(raw)

    facts = Facts(**facts_dict)
    facts.updated_at = datetime.utcnow().isoformat() + "Z"
    facts.hash = stable_hash(facts.model_dump())

    drift = compute_drift(facts, previous_facts, context)

    return facts.model_dump(), drift.model_dump()
