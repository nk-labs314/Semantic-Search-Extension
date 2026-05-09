from __future__ import annotations

import ast
import hashlib
import json
import os
import shutil
from pathlib import Path
from typing import Any

import faiss
import numpy as np
import torch
from transformers import AutoModel, AutoTokenizer

BACKEND_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = BACKEND_ROOT / "data" / "embeddings" / "workspace"
INDEX_PATH = OUTPUT_DIR / "index.faiss"
METADATA_PATH = OUTPUT_DIR / "metadata.json"
MODEL_PATH = BACKEND_ROOT / "assets" / "best_model.pt"
MODEL_NAME = "microsoft/codebert-base"
BATCH_SIZE = 16
CODEBERT_DIM = 768
SKIP_DIRS = {
    ".venv",
    ".git",
    "__pycache__",
    "node_modules",
    "data",
    ".agent",
    "logs",
    "dist",
    "out",
}

_model_cache: dict[str, Any] = {}


def scan_python_files(root_path: str) -> list[str]:
    py_files: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root_path):
        dirnames[:] = [dirname for dirname in dirnames if dirname not in SKIP_DIRS]
        for filename in filenames:
            if filename.endswith(".py"):
                py_files.append(os.path.join(dirpath, filename))
    return py_files


def extract_functions_from_file(file_path: str, root_path: str) -> list[dict[str, Any]]:
    try:
        with open(file_path, "r", encoding="utf-8", errors="ignore") as handle:
            source = handle.read()
    except OSError:
        return []

    try:
        tree = ast.parse(source)
    except SyntaxError:
        return []

    lines = source.splitlines()
    rel_path = os.path.relpath(os.path.abspath(file_path), os.path.abspath(root_path))
    rel_path = rel_path.replace(os.sep, "/")

    functions: list[dict[str, Any]] = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue

        end_line = getattr(node, "end_lineno", None)
        if end_line is None:
            continue

        start_line = node.lineno
        func_code = "\n".join(lines[start_line - 1 : end_line])
        func_name = node.name or "unknown"
        func_id = hashlib.sha256(
            f"{rel_path}:{func_name}:{func_code}".encode("utf-8")
        ).hexdigest()

        functions.append(
            {
                "id": func_id,
                "file_path": rel_path,
                "function_name": func_name,
                "code": func_code,
                "start_line": start_line,
                "end_line": end_line,
            }
        )

    return functions


def extract_all_functions(root_path: str) -> list[dict[str, Any]]:
    all_functions: list[dict[str, Any]] = []
    for file_path in scan_python_files(root_path):
        all_functions.extend(extract_functions_from_file(file_path, root_path))
    return all_functions


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


def mean_pooling(outputs: Any, attention_mask: torch.Tensor) -> torch.Tensor:
    mask = attention_mask.unsqueeze(-1)
    return (outputs.last_hidden_state * mask).sum(1) / mask.sum(1)


def embed_functions(functions: list[dict[str, Any]]) -> np.ndarray:
    tokenizer, model, device = get_model_bundle()
    all_embeddings = []

    for offset in range(0, len(functions), BATCH_SIZE):
        batch = functions[offset : offset + BATCH_SIZE]
        code_batch = [item["code"] for item in batch]
        inputs = tokenizer(
            code_batch,
            padding=True,
            truncation=True,
            max_length=512,
            return_tensors="pt",
        )
        inputs = {key: value.to(device) for key, value in inputs.items()}

        with torch.no_grad():
            outputs = model(**inputs)

        embeddings = mean_pooling(outputs, inputs["attention_mask"])
        embeddings = torch.nn.functional.normalize(embeddings, dim=1)
        all_embeddings.append(embeddings.cpu())

    merged = torch.cat(all_embeddings, dim=0).numpy().astype("float32")
    faiss.normalize_L2(merged)
    return merged


def build_faiss_index(embeddings: np.ndarray) -> faiss.Index:
    index = faiss.IndexIDMap(faiss.IndexFlatIP(embeddings.shape[1]))
    ids = np.arange(len(embeddings)).astype("int64")
    index.add_with_ids(embeddings, ids)
    return index


def save_index(index: faiss.Index, metadata: list[dict[str, Any]]) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    faiss.write_index(index, str(INDEX_PATH))
    with METADATA_PATH.open("w", encoding="utf-8") as handle:
        json.dump(metadata, handle)


def save_empty_index() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    empty_index = faiss.IndexIDMap(faiss.IndexFlatIP(CODEBERT_DIM))
    faiss.write_index(empty_index, str(INDEX_PATH))
    with METADATA_PATH.open("w", encoding="utf-8") as handle:
        json.dump([], handle)


def rebuild_index_from_metadata(metadata: list[dict[str, Any]]) -> None:
    if not metadata:
        save_empty_index()
        return

    embeddings = embed_functions(metadata)
    if len(embeddings) != len(metadata):
        raise RuntimeError("Embedding count mismatch while rebuilding index")
    if np.isnan(embeddings).any():
        raise RuntimeError("NaN detected in embeddings")

    index = build_faiss_index(embeddings)
    save_index(index, metadata)


def load_metadata() -> list[dict[str, Any]]:
    if not METADATA_PATH.exists():
        return []
    with METADATA_PATH.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def index_workspace(root_path: str) -> dict[str, Any]:
    if OUTPUT_DIR.exists():
        shutil.rmtree(OUTPUT_DIR)

    functions = extract_all_functions(root_path)
    if not functions:
        save_empty_index()
        return {"status": "empty", "functions_indexed": 0}

    rebuild_index_from_metadata(functions)
    return {
        "status": "ok",
        "functions_indexed": len(functions),
        "index_path": str(INDEX_PATH),
        "metadata_path": str(METADATA_PATH),
    }


def index_single_file(file_path: str, root_path: str) -> dict[str, Any]:
    rel_path = os.path.relpath(os.path.abspath(file_path), os.path.abspath(root_path))
    rel_path = rel_path.replace(os.sep, "/")

    metadata = [item for item in load_metadata() if item["file_path"] != rel_path]
    new_functions = extract_functions_from_file(file_path, root_path)
    metadata.extend(new_functions)

    rebuild_index_from_metadata(metadata)
    return {
        "status": "ok",
        "functions_updated": len(new_functions),
        "total_functions": len(metadata),
    }


def delete_file_entries(file_path: str, root_path: str) -> dict[str, Any]:
    rel_path = os.path.relpath(os.path.abspath(file_path), os.path.abspath(root_path))
    rel_path = rel_path.replace(os.sep, "/")

    metadata = load_metadata()
    original_count = len(metadata)
    filtered = [item for item in metadata if item["file_path"] != rel_path]
    removed = original_count - len(filtered)

    rebuild_index_from_metadata(filtered)
    return {
        "status": "ok",
        "removed": removed,
        "total_functions": len(filtered),
    }
