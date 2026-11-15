# Semantic Search Ext

Semantic Search Ext is a VS Code extension for local semantic search over Python functions. It runs a FastAPI backend on `127.0.0.1:8000`, indexes the open workspace with CodeBERT-style embeddings and FAISS, and opens the selected result in VS Code.

It is not a general-purpose code search engine. The current indexer scans `.py` files and extracts Python functions and async functions.

## Architecture

```text
VS Code command or startup
        |
        v
TypeScript extension (src/extension.ts)
        |
        | HTTP on 127.0.0.1:8000
        v
FastAPI backend (backend/api/app.py)
        |
        +-- AST function extraction
        +-- CodeBERT-style embeddings
        +-- FAISS vector index
        |
        v
Workspace index: backend/data/embeddings/workspace/
```

On a Marketplace install, the extension downloads a versioned Windows runtime archive from the matching GitHub release. The archive supplies Python, the backend, the model assets, and its dependencies. The extension then starts the backend locally and indexes the first workspace folder.

## Repository layout

```text
src/extension.ts                     VS Code activation, commands, runtime download, backend process
backend/api/app.py                   FastAPI endpoints and model-backed search
backend/indexing/workspace_indexer.py Python AST extraction, embeddings, FAISS index persistence
backend/assets/codebert-base/        Tokenizer and model configuration tracked in Git
backend/assets/best_model.pt         Model weights; required but intentionally ignored by Git
backend/tests/                       Retrieval-metric unit tests and optional journal_mvp benchmark
scripts/stage_model_assets.py        Stages local CodeBERT tokenizer/config assets
scripts/build_release_runtime.ps1    Creates a CPU-only Windows release environment and runtime archive
scripts/build_windows_standalone_runtime.py Builds the Windows embeddable-Python runtime archive
requirements.txt                     Backend dependencies
package.json                         Extension manifest, commands, settings, and package scripts
.vscodeignore                        Controls files included in a VSIX
```

Generated workspace indexes live under `backend/data/embeddings/workspace/`. Release archives are written to `dist/runtime/`. Neither belongs in Git.

## Requirements

### Development

- Windows x64
- Python 3 with `venv`
- Node.js and npm
- VS Code 1.80 or later
- Local model weights at `backend/assets/best_model.pt`

The tokenizer and model configuration are under `backend/assets/codebert-base/`. `scripts/stage_model_assets.py` uses `local_files_only=True`, so it expects CodeBERT assets to already be available locally; it does not download them from Hugging Face.

### Published extension

The released runtime currently supports Windows x64 only. macOS, Linux, Windows on ARM, and non-Python source files are not supported by the published runtime.

## Run locally

Create the backend environment and install dependencies:

```powershell
python -m venv backend/.venv
backend/.venv/Scripts/pip install -r requirements.txt
```

Install extension dependencies and compile TypeScript:

```powershell
npm install
npm run compile
```

Open this repository in VS Code and press `F5` to launch an Extension Development Host. When the required model assets and `backend/.venv` are present, the extension uses that local environment instead of downloading a managed runtime.

To run the backend on its own:

```powershell
backend/.venv/Scripts/python.exe -m uvicorn backend.api.app:app --host 127.0.0.1 --port 8000
```

`GET http://127.0.0.1:8000/health` reports whether an index is loaded.

## Extension behavior

On startup, if `semanticSearch.autoIndexOnStartup` is enabled, the extension:

1. Starts or connects to the local backend.
2. Builds a full index for the first open workspace folder.
3. Watches files and updates the index after Python files are created, changed, or deleted.

Run **Semantic Code Search** from the Command Palette or use `Ctrl+Shift+K`. The command indexes the workspace if necessary, accepts a natural-language query, shows up to five candidates, and opens the selected function.

The backend returns one result for a score above `0.85`, up to three results for a score above `0.35`, and no results below that threshold.

## Backend API

The extension calls these local endpoints:

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Reports backend and index state. |
| `POST` | `/index/workspace` | Rebuilds the index for `root_path`. |
| `POST` | `/index/file` | Reindexes one file. |
| `DELETE` | `/index/file` | Removes one file from the index. |
| `POST` | `/search` | Searches indexed functions using `query` and optional `top_k`. |

The backend only binds to loopback. Source code is indexed and searched locally; the release runtime download is the only normal network operation.

## Tests

Run the fast unit tests for retrieval metrics:

```powershell
backend/.venv/Scripts/python.exe -m unittest backend.tests.test_retrieval_metrics -v
```

The optional benchmark measures Recall@1, Recall@3, Recall@5, and warm retrieval latency against a sibling `journal/journal_mvp` project:

```powershell
backend/.venv/Scripts/python.exe -m backend.tests.benchmark_journal_mvp
```

It is intentionally not portable: it fails when that sibling project is unavailable.

## Build a Windows runtime

Create a clean CPU-only virtual environment and bundle it with Python's embeddable Windows distribution:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build_release_runtime.ps1
```

The output is:

```text
dist/runtime/semantic-search-runtime-win32-x64.zip
```

Upload that archive to a GitHub release tagged `v<extension-version>`. The extension derives its default runtime URL from `package.json` and looks for this exact asset name.

## Package and publish

Create a VSIX:

```powershell
npm run package:vsix
```

Before publishing, inspect the VSIX file list and make sure development-only files, especially `backend/tests/`, are excluded by `.vscodeignore`.

Publish through VSCE or the Visual Studio Marketplace publisher portal. The extension version must be new; Marketplace does not permit replacing an existing version.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `semanticSearch.runtimeBaseUrl` | empty | Overrides the GitHub release base URL for runtime archives. |
| `semanticSearch.runtimeVersion` | extension version | Overrides the release tag used to fetch the runtime. |
| `semanticSearch.autoInstallRuntime` | `true` | Downloads the runtime when it is missing. |
| `semanticSearch.autoIndexOnStartup` | `true` | Starts and indexes the active workspace on activation. |

## License

See [LICENSE.txt](LICENSE.txt).

