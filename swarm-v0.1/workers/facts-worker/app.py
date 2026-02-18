from fastapi import FastAPI
from pydantic import BaseModel
from typing import Any, Dict, List, Optional
from rlm_facts import extract_facts_and_drift

app = FastAPI(title="facts-worker")


class ExtractReq(BaseModel):
    context: List[Dict[str, Any]]
    previous_facts: Optional[Dict[str, Any]] = None


@app.post("/extract")
def extract(req: ExtractReq):
    facts, drift = extract_facts_and_drift(req.context, req.previous_facts)
    return {"facts": facts, "drift": drift}
