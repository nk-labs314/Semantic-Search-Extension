# Backend

This is the local backend used by Semantic Search Ext. It indexes Python functions in the open workspace, creates embeddings with the bundled model, and returns matching functions to the VS Code extension over `127.0.0.1:8000`.

## What it does

- Finds functions and async functions in `.py` files.
- Builds a FAISS index from their code embeddings.
- Supports a full workspace index and incremental updates for changed or deleted files.
- Returns up to five search candidates, then applies score thresholds before sending results back to VS Code.

The index is stored under `backend/data/embeddings/workspace/`. It is generated data, not source code.

## Required local assets

The backend needs these files before it can start:

- `backend/assets/best_model.pt`
- `backend/assets/codebert-base/`

The extension's Windows runtime bundle includes them. They are intentionally not committed to the repository because of their size.

## Run locally

From the repository root, create a virtual environment and install the dependencies:

```powershell
python -m venv backend/.venv
backend/.venv/Scripts/pip install -r requirements.txt
```

Then start the API:

```powershell
backend/.venv/Scripts/python.exe -m uvicorn backend.api.app:app --host 127.0.0.1 --port 8000
```

`GET /health` reports whether an index is loaded. The extension uses `POST /index/workspace`, `POST /index/file`, `DELETE /index/file`, and `POST /search`.

## Tests and benchmark

Run the unit tests:

```powershell
backend/.venv/Scripts/python.exe -m unittest backend.tests.test_retrieval_metrics -v
```

The optional benchmark evaluates retrieval against the sibling `journal/journal_mvp` project. It will fail if that project is not present at the expected path:

```powershell
backend/.venv/Scripts/python.exe -m backend.tests.benchmark_journal_mvp
```

