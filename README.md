# Semantic Search Ext

Bundled VS Code extension plus local Python backend for semantic code search.

## Layout

- `src/`: VS Code extension source
- `backend/`: bundled FastAPI backend, model assets, and local workspace index data
- `out/`: compiled extension output

## Dev

1. Create a backend virtual environment:
   - Windows: `python -m venv backend/.venv`
   - macOS/Linux: `python3 -m venv backend/.venv`
2. Install backend deps into that environment:
   - Windows: `backend/.venv/Scripts/pip install -r requirements.txt`
   - macOS/Linux: `backend/.venv/bin/pip install -r requirements.txt`
3. Install extension deps:
   - `npm install`
4. Compile:
   - `npm run compile`

The extension starts the backend automatically and indexes the active workspace on first run.
If `backend/.venv` exists, the extension uses it before falling back to `python` on `PATH`.
