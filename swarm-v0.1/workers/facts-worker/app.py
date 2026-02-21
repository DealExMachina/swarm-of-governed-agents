import logging
import traceback
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Any, Dict, List, Optional
from rlm_facts import extract_facts_and_drift

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="facts-worker")


class ExtractReq(BaseModel):
    context: List[Dict[str, Any]]
    previous_facts: Optional[Dict[str, Any]] = None


@app.post("/extract")
def extract(req: ExtractReq):
    try:
        facts, drift = extract_facts_and_drift(req.context, req.previous_facts)
        return {"facts": facts, "drift": drift}
    except Exception as e:
        msg = str(e)
        tb = traceback.format_exc()
        logger.error("extract failed: %s\n%s", msg, tb)
        return JSONResponse(
            status_code=500,
            content={"error": msg, "detail": tb},
        )
