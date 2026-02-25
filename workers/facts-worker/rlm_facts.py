import os
import json
import hashlib
from typing import List, Optional, Dict, Any, Tuple
from datetime import datetime

from pydantic import BaseModel, Field

# -----------------------------
# LLM client (OpenAI-compatible; works with OpenAI API and Ollama /v1)
# -----------------------------

EXTRACTION_TIMEOUT_SEC = max(30, int(os.getenv("EXTRACTION_TIMEOUT_SEC", "180")))
EXTRACTION_CONTEXT_MAX_CHARS = int(os.getenv("EXTRACTION_CONTEXT_MAX_CHARS", "24000"))


def _get_model_info() -> Tuple[str, str]:
    """Return (model_name, backend) where backend is 'ollama' or 'openai'."""
    ollama_base = os.getenv("OLLAMA_BASE_URL", "").strip()
    if ollama_base:
        return os.getenv("EXTRACTION_MODEL", "qwen3:8b"), "ollama"
    return os.getenv("OPENAI_MODEL", "gpt-4o-mini"), "openai"


def _call_llm(prompt_context: str, prompt_previous: str) -> str:
    """Call an OpenAI-compatible chat/completions endpoint. Uses Ollama when OLLAMA_BASE_URL is set."""
    from openai import OpenAI

    ollama_base = os.getenv("OLLAMA_BASE_URL", "").strip()
    if ollama_base:
        client = OpenAI(
            api_key="ollama",
            base_url=f"{ollama_base.rstrip('/')}/v1",
            timeout=float(EXTRACTION_TIMEOUT_SEC),
        )
        model = os.getenv("EXTRACTION_MODEL", "qwen3:8b")
    else:
        client = OpenAI(
            api_key=os.getenv("OPENAI_API_KEY"),
            base_url=os.getenv("OPENAI_BASE_URL") or None,
            timeout=float(EXTRACTION_TIMEOUT_SEC),
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
# Prompt size limits
# -----------------------------


def _truncate_context_for_prompt(context: List[Dict[str, Any]], max_chars: int) -> List[Dict[str, Any]]:
    """Keep last events that fit within max_chars (newest first)."""
    if max_chars <= 0:
        return context
    compact = json.dumps(context, separators=(",", ":"), ensure_ascii=False)
    if len(compact) <= max_chars:
        return context
    out: List[Dict[str, Any]] = []
    for i in range(len(context) - 1, -1, -1):
        out.insert(0, context[i])
        if len(json.dumps(out, separators=(",", ":"), ensure_ascii=False)) > max_chars:
            out.pop(0)
            break
    return out if out else context[:1]


# -----------------------------
# Helpers
# -----------------------------


def stable_hash(obj: Any) -> str:
    b = json.dumps(obj, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(b).hexdigest()


# -----------------------------
# GLiNER2 NER (optional -- requires requirements-full.txt)
# -----------------------------

_gliner_model = None


def _get_gliner():
    global _gliner_model
    if _gliner_model is not None:
        return _gliner_model
    if os.getenv("SKIP_GLINER", "1").lower() in ("1", "true", "yes"):
        return None
    gliner_id = os.getenv("GLINER_MODEL", "").strip()
    if not gliner_id:
        return None
    try:
        from gliner2 import GLiNER2
        _gliner_model = GLiNER2.from_pretrained(gliner_id)
        return _gliner_model
    except Exception:
        return None


def _extract_entities_gliner(context: List[Dict[str, Any]]) -> List[str]:
    """First-pass NER on context text. Returns empty list if GLiNER unavailable."""
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
# NLI contradiction detection (optional -- requires requirements-full.txt)
# -----------------------------

_nli_model = None


def _get_nli():
    global _nli_model
    if _nli_model is not None:
        return _nli_model
    if os.getenv("SKIP_NLI", "1").lower() in ("1", "true", "yes"):
        return None
    nli_id = os.getenv("NLI_MODEL", "").strip()
    if not nli_id:
        return None
    try:
        from sentence_transformers import CrossEncoder
        _nli_model = CrossEncoder(nli_id)
        return _nli_model
    except Exception:
        return None


def _detect_contradictions_nli(claims: List[str], max_pairs: int = 20) -> List[str]:
    """Run NLI on claim pairs. Returns empty list if NLI unavailable."""
    model = _get_nli()
    if model is None or len(claims) < 2:
        return []
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
        scores = model.predict([(a, b) for a, b in pairs])
        out: List[str] = []
        for idx, (a, b) in enumerate(pairs):
            s = scores[idx] if hasattr(scores, "__getitem__") else scores
            if hasattr(s, "tolist"):
                s = s.tolist()
            if isinstance(s, (list, tuple)) and len(s) >= 3:
                if s[0] > s[1] and s[0] > s[2] and s[0] > 0.5:
                    out.append(f"NLI: \"{a[:100]}...\" vs \"{b[:100]}...\"")
            elif isinstance(s, (list, tuple)) and len(s) >= 1 and float(s[0]) > 0.5:
                out.append(f"NLI: \"{a[:100]}...\" vs \"{b[:100]}...\"")
        return out
    except Exception:
        return []


# -----------------------------
# Drift computation
# -----------------------------


def _doc_titles_from_context(context: List[Dict[str, Any]]) -> List[str]:
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
# Normalize LLM output
# -----------------------------


def _to_string_list(val: Any) -> List[str]:
    if val is None:
        return []
    if isinstance(val, dict):
        flat: List[str] = []
        for v in val.values():
            if isinstance(v, list):
                if v and isinstance(v[0], (dict, list)):
                    flat.extend(_to_string_list(v))
                else:
                    flat.extend(str(x) for x in v)
            else:
                flat.append(str(v))
        return flat
    if isinstance(val, list):
        out: List[str] = []
        for item in val:
            if isinstance(item, str):
                out.append(item.strip() if item.strip() else item)
            elif isinstance(item, dict):
                s = (
                    item.get("claim") or item.get("risk") or item.get("assumption")
                    or item.get("contradiction") or item.get("goal") or item.get("text")
                    or item.get("entity") or (next((v for v in item.values() if isinstance(v, str)), None))
                )
                if s and isinstance(s, str):
                    out.append(s.strip() or s)
                else:
                    out.append(str(item))
            else:
                out.append(str(item))
        return out
    return [str(val)]


# -----------------------------
# Main Entry
# -----------------------------


def extract_facts_and_drift(
    context: List[Dict[str, Any]],
    previous_facts: Optional[Dict[str, Any]],
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    context_limited = _truncate_context_for_prompt(context, EXTRACTION_CONTEXT_MAX_CHARS)

    prompt_context = json.dumps(context_limited, separators=(",", ":"), ensure_ascii=False)
    prompt_previous = json.dumps(previous_facts, separators=(",", ":"), ensure_ascii=False) if previous_facts else "{}"

    # Optional first-pass NER (requires requirements-full.txt + GLINER_MODEL set)
    gliner_entities: List[str] = _extract_entities_gliner(context_limited)

    # LLM extraction (OpenAI API or Ollama)
    facts_json_str = _call_llm(prompt_context, prompt_previous)

    # Parse JSON (strip optional markdown code fence)
    raw = facts_json_str.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[-1] if "\n" in raw else raw[3:]
        raw = raw.rsplit("```", 1)[0].strip()
    facts_dict = json.loads(raw)

    for key in ("entities", "claims", "risks", "assumptions", "contradictions", "goals"):
        facts_dict[key] = _to_string_list(facts_dict.get(key))

    facts = Facts(**facts_dict)

    if gliner_entities:
        existing = set(facts.entities or [])
        for e in gliner_entities:
            if e and e not in existing:
                existing.add(e)
                facts.entities.append(e)

    # Optional NLI contradiction detection (requires requirements-full.txt + NLI_MODEL set)
    nli_contradictions = _detect_contradictions_nli(facts.claims or [])
    if nli_contradictions:
        facts.contradictions = list(facts.contradictions or []) + nli_contradictions

    facts.updated_at = datetime.utcnow().isoformat() + "Z"
    facts.hash = stable_hash(facts.model_dump())

    drift = compute_drift(facts, previous_facts, context)

    return facts.model_dump(), drift.model_dump()
