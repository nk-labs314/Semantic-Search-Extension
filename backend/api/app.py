from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import faiss
import torch
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from transformers import AutoModel, AutoTokenizer

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

APP_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = Path(__file__).resolve().parents[1]
MODEL_PATH = BACKEND_ROOT / "assets" / "best_model.pt"
INDEX_PATH = BACKEND_ROOT / "data" / "embeddings" / "workspace" / "index.faiss"
METADATA_PATH = BACKEND_ROOT / "data" / "embeddings" / "workspace" / "metadata.json"
MODEL_NAME = "microsoft/codebert-base"
SEARCH_LIMIT = 5
TOP_1_THRESHOLD = 0.85
TOP_3_THRESHOLD = 0.35

app = FastAPI(title="Semantic Search Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_model_cache: dict[str, Any] = {}
WORKSPACE_INDEX = None
WORKSPACE_META: list[dict[str, Any]] | None = None


class QueryRequest(BaseModel):
    query: str
    top_k: int = SEARCH_LIMIT


class IndexRequest(BaseModel):
    root_path: str


class FileIndexRequest(BaseModel):
    file_path: str
    root_path: str


def mean_pooling(outputs: Any, attention_mask: torch.Tensor) -> torch.Tensor:
    mask = attention_mask.unsqueeze(-1)
    return (outputs.last_hidden_state * mask).sum(1) / mask.sum(1)


def get_model_bundle() -> tuple[Any, Any, str]:
    if "model" in _model_cache:
        return (
            _model_cache["tokenizer"],
            _model_cache["model"],
            _model_cache["device"],
        )

    if not MODEL_PATH.exists():
        raise FileNotFoundError(f"Missing model weights: {MODEL_PATH}")

    device = "cuda" if torch.cuda.is_available() else "cpu"
    tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
    model = AutoModel.from_pretrained(MODEL_NAME, use_safetensors=True)
    model.load_state_dict(torch.load(MODEL_PATH, map_location=device))
    model.to(device)
    model.eval()

    _model_cache["tokenizer"] = tokenizer
    _model_cache["model"] = model
    _model_cache["device"] = device
    return tokenizer, model, device


def load_workspace_index() -> tuple[Any | None, list[dict[str, Any]] | None]:
    if not INDEX_PATH.exists() or not METADATA_PATH.exists():
        logger.info("Workspace index not found yet")
        return None, None

    try:
        index = faiss.read_index(str(INDEX_PATH))
        with METADATA_PATH.open("r", encoding="utf-8") as handle:
            metadata = json.load(handle)
        logger.info("Workspace index loaded: %d vectors", index.ntotal)
        return index, metadata
    except Exception as exc:
        logger.exception("Failed to load workspace index", exc_info=exc)
        return None, None


def reload_workspace_index() -> None:
    global WORKSPACE_INDEX, WORKSPACE_META
    WORKSPACE_INDEX, WORKSPACE_META = load_workspace_index()


def embed_query(query: str) -> Any:
    tokenizer, model, device = get_model_bundle()
    inputs = tokenizer(
        [query],
        padding=True,
        truncation=True,
        max_length=512,
        return_tensors="pt",
    )
    inputs = {key: value.to(device) for key, value in inputs.items()}

    with torch.no_grad():
        outputs = model(**inputs)

    embedding = mean_pooling(outputs, inputs["attention_mask"])
    embedding = embedding.cpu().numpy().astype("float32")
    faiss.normalize_L2(embedding)
    return embedding


def build_search_results(indices: Any, scores: Any) -> list[dict[str, Any]]:
    if WORKSPACE_META is None:
        return []

    results: list[dict[str, Any]] = []
    for idx, score in zip(indices[0], scores[0]):
        if idx == -1:
            continue
        item = WORKSPACE_META[idx]
        results.append(
            {
                "score": float(score),
                "function_name": item["function_name"],
                "file_path": item["file_path"],
                "code": item["code"],
                "start_line": item["start_line"],
                "end_line": item["end_line"],
            }
        )
    return results


reload_workspace_index()


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "workspace_indexed": WORKSPACE_INDEX is not None and WORKSPACE_META is not None,
        "app_root": str(APP_ROOT),
    }


@app.post("/search")
def search(req: QueryRequest) -> dict[str, Any]:
    if WORKSPACE_INDEX is None or WORKSPACE_META is None:
        return {"results": [], "message": "Workspace not indexed"}

    query = req.query.strip()
    if not query:
        return {"results": [], "error": "Empty query"}

    try:
        query_embedding = embed_query(query)
        scores, indices = WORKSPACE_INDEX.search(query_embedding, min(req.top_k, SEARCH_LIMIT))
    except Exception as exc:
        logger.exception("Search failed", exc_info=exc)
        return {"results": [], "error": str(exc)}

    results = build_search_results(indices, scores)
    if not results:
        return {"results": []}

    top_score = results[0]["score"]
    if top_score > TOP_1_THRESHOLD:
        return {"results": results[:1]}
    if top_score > TOP_3_THRESHOLD:
        return {"results": results[:3]}
    return {"results": []}


@app.post("/index/workspace")
def index_workspace(req: IndexRequest) -> dict[str, Any]:
    root_path = req.root_path.strip()
    if not root_path:
        return {"status": "error", "detail": "root_path is required"}
    if not Path(root_path).is_dir():
        return {"status": "error", "detail": f"Invalid directory: {root_path}"}

    from backend.indexing.workspace_indexer import index_workspace as run_full_index

    try:
        result = run_full_index(root_path)
    except Exception as exc:
        logger.exception("Full index failed", exc_info=exc)
        return {"status": "error", "detail": str(exc)}

    reload_workspace_index()
    return {"status": "success", "detail": result}


@app.post("/index/file")
def index_file(req: FileIndexRequest) -> dict[str, Any]:
    file_path = req.file_path.strip()
    root_path = req.root_path.strip()
    if not file_path or not root_path:
        return {"status": "error", "detail": "file_path and root_path are required"}

    from backend.indexing.workspace_indexer import index_single_file

    try:
        result = index_single_file(file_path, root_path)
    except Exception as exc:
        logger.exception("Incremental index failed", exc_info=exc)
        return {"status": "error", "detail": str(exc)}

    reload_workspace_index()
    return {"status": "success", "detail": result}


@app.delete("/index/file")
def delete_file_index(req: FileIndexRequest) -> dict[str, Any]:
    file_path = req.file_path.strip()
    root_path = req.root_path.strip()
    if not file_path or not root_path:
        return {"status": "error", "detail": "file_path and root_path are required"}

    from backend.indexing.workspace_indexer import delete_file_entries

    try:
        result = delete_file_entries(file_path, root_path)
    except Exception as exc:
        logger.exception("Delete index failed", exc_info=exc)
        return {"status": "error", "detail": str(exc)}

    reload_workspace_index()
    return {"status": "success", "detail": result}
