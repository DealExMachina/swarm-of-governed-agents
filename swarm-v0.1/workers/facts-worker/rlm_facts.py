import os
import json
import hashlib
from typing import List, Optional, Dict, Any, Tuple
from datetime import datetime

import dspy
from pydantic import BaseModel, Field

# -----------------------------
# DSPy LLM Setup (lazy so tests can run without litellm/openai deps)
# Ollama when OLLAMA_BASE_URL is set; else OpenAI-compatible.
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
        ollama_base = os.getenv("OLLAMA_BASE_URL", "").strip()
        if ollama_base:
            _model = os.getenv("EXTRACTION_MODEL", "qwen3:8b")
            _model_str = f"openai/{_model}" if "/" not in _model else _model
            _lm = ConcreteLM(model=_model_str, model_type="chat", api_base=ollama_base, api_key="ollama")
        else:
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
    """Use OpenAI client directly when DSPy LM is not available (e.g. in Docker). Uses Ollama when OLLAMA_BASE_URL is set."""
    from openai import OpenAI
    ollama_base = os.getenv("OLLAMA_BASE_URL", "").strip()
    if ollama_base:
        client = OpenAI(api_key="ollama", base_url=ollama_base)
        model = os.getenv("EXTRACTION_MODEL", "qwen3:8b")
    else:
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


# -----------------------------
# GLiNER2 NER (optional first-pass)
# -----------------------------

_gliner_model = None


def _get_gliner():
    global _gliner_model
    if _gliner_model is not None:
        return _gliner_model
    try:
        from gliner2 import GLiNER2
        model_id = os.getenv("GLINER_MODEL", "fastino/gliner2-base-v1")
        _gliner_model = GLiNER2.from_pretrained(model_id)
        return _gliner_model
    except Exception:
        return None


def _extract_entities_gliner(context: List[Dict[str, Any]]) -> List[str]:
    """First-pass NER on context text. Returns list of entity strings. Empty if GLiNER unavailable."""
    model = _get_gliner()
    if model is None:
        return []
    text_parts: List[str] = []
    for ev in context:
        if not isinstance(ev, dict):
            continue
        payload = ev.get("payload") or ev.get("data", {}).get("payload") or ev.get("data") or {}
        if isinstance(payload, dict):
            for key in ("content", "text", "excerpt", "body"):
                v = payload.get(key)
                if v and isinstance(v, str):
                    text_parts.append(v[:8000])
                    break
        if isinstance(ev.get("payload"), str):
            text_parts.append(str(ev["payload"])[:8000])
    if not text_parts:
        return []
    text = "\n\n".join(text_parts)[:32000]
    try:
        labels = ["person", "organization", "location", "date", "amount", "document", "concept"]
        raw = model.extract_entities(text, labels) if hasattr(model, "extract_entities") else getattr(model, "predict_entities", lambda t, l: {})(text, labels)
        seen: set = set()
        out: List[str] = []
        if isinstance(raw, dict) and "entities" in raw:
            for _label, vals in raw["entities"].items():
                for v in vals if isinstance(vals, list) else []:
                    s = str(v).strip() if not isinstance(v, dict) else str(v.get("text", v)).strip()
                    if s and s not in seen:
                        seen.add(s)
                        out.append(s)
        return out
    except Exception:
        return []


# -----------------------------
# NLI contradiction detection (optional)
# -----------------------------

_nli_model = None


def _get_nli():
    global _nli_model
    if _nli_model is not None:
        return _nli_model
    try:
        from sentence_transformers import CrossEncoder
        model_id = os.getenv("NLI_MODEL", "cross-encoder/nli-deberta-v3-small")
        _nli_model = CrossEncoder(model_id)
        return _nli_model
    except Exception:
        return None


def _detect_contradictions_nli(claims: List[str], max_pairs: int = 50) -> List[str]:
    """Run NLI on claim pairs; return list of contradiction descriptions (e.g. 'Claim A vs Claim B')."""
    model = _get_nli()
    if model is None or len(claims) < 2:
        return []
    # Limit pairs to avoid O(n^2) blow-up
    pairs: List[Tuple[str, str]] = []
    for i in range(min(len(claims), 20)):
        for j in range(i + 1, min(len(claims), 20)):
            if len(pairs) >= max_pairs:
                break
            a, b = claims[i], claims[j]
            if isinstance(a, str) and isinstance(b, str) and a.strip() and b.strip():
                pairs.append((a, b))
        if len(pairs) >= max_pairs:
            break
    if not pairs:
        return []
    try:
        from sentence_transformers import CrossEncoder
        # CrossEncoder returns scores for [contradiction, entailment, neutral] in that order for some models
        # nli-deberta-v3-small: logits for contradiction, entailment, neutral
        scores = model.predict([(a, b) for a, b in pairs])
        out: List[str] = []
        for idx, (a, b) in enumerate(pairs):
            s = scores[idx] if hasattr(scores, "__getitem__") else scores
            if hasattr(s, "tolist"):
                s = s.tolist()
            if isinstance(s, (list, tuple)) and len(s) >= 3:
                # Index 0 = contradiction, 1 = entailment, 2 = neutral
                if s[0] > s[1] and s[0] > s[2] and s[0] > 0.5:
                    out.append(f"NLI: \"{a[:100]}...\" vs \"{b[:100]}...\"")
            elif isinstance(s, (list, tuple)) and len(s) >= 1 and float(s[0]) > 0.5:
                out.append(f"NLI: \"{a[:100]}...\" vs \"{b[:100]}...\"")
        return out
    except Exception:
        return []


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
    # Optional first-pass NER (entities merged into facts after LLM)
    gliner_entities: List[str] = _extract_entities_gliner(context)

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
    # Merge GLiNER entities (dedupe)
    if gliner_entities:
        existing = set(facts.entities or [])
        for e in gliner_entities:
            if e and e not in existing:
                existing.add(e)
                facts.entities.append(e)

    # NLI contradiction detection on claim pairs
    claims = facts.claims or []
    nli_contradictions = _detect_contradictions_nli(claims)
    if nli_contradictions:
        facts.contradictions = list(facts.contradictions or []) + nli_contradictions

    facts.updated_at = datetime.utcnow().isoformat() + "Z"
    facts.hash = stable_hash(facts.model_dump())

    drift = compute_drift(facts, previous_facts, context)

    return facts.model_dump(), drift.model_dump()
