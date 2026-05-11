# Semantic Search Ext

Semantic Search Ext is a VS Code extension for finding relevant code by meaning instead of exact keywords.

The extension runs a local Python backend, indexes the open workspace, and lets you search with natural language from inside VS Code. It is built around a CodeBERT-style embedding pipeline with FAISS for fast local retrieval.

## What It Does

- Searches code by intent, not only by matching text.
- Starts a local backend automatically when the extension activates.
- Downloads a platform runtime on first use instead of asking users to run `uvicorn` manually.
- Indexes the active workspace and returns matching functions with file and line context.
- Keeps search local to the user's machine.

## Why This Exists

Regular text search is useful when you already know the exact symbol, file, or phrase you are looking for. It is weaker when you remember what a piece of code does but not what it is called.

This project explores that gap. The goal is to make code search feel closer to asking:

> Where is the function that validates user input before saving?

instead of guessing terms like `validate`, `sanitize`, `save`, or `schema`.

## Current Status

This is an early Windows-focused release.

The extension is publishable through the VS Code Marketplace and uses a separate GitHub Release asset for the backend runtime. That keeps the VSIX small while still allowing the backend to run without manual setup.

Current limitations:

- Windows x64 is the primary supported runtime target.
- Search quality depends on the bundled model weights and the indexed code structure.
- Large workspaces may take time to index on first run.
- The current backend is local-first and not designed as a remote multi-user service.

## Architecture

The project has two main parts:

- `src/`: VS Code extension code. It handles activation, commands, runtime installation, backend startup, and search UI.
- `backend/`: FastAPI backend. It loads the model, builds workspace embeddings, stores a FAISS index, and serves search results.

At runtime:

1. The extension activates in VS Code.
2. It checks whether the backend runtime is already installed.
3. If missing, it downloads the runtime archive from the matching GitHub Release.
4. It starts the backend locally.
5. It indexes the current workspace.
6. `Ctrl+Shift+K` opens semantic search.

## Repository Layout

```text
src/                         VS Code extension source
out/                         Compiled extension output
backend/                     Backend API, indexing code, and model assets
backend/assets/codebert-base Local tokenizer/config assets
scripts/                     Runtime packaging helpers
dist/runtime/                Generated runtime archives, ignored by git
```

## Local Development

From the project root:

```powershell
npm install
npm run compile
```

Create a backend virtual environment:

```powershell
python -m venv backend/.venv
backend/.venv/Scripts/pip install -r requirements.txt
```

If model assets need to be staged:

```powershell
backend/.venv/Scripts/python.exe scripts/stage_model_assets.py
```

Then open the extension project in VS Code and press `F5` to launch an Extension Development Host.

## Runtime Packaging

Marketplace users should not need to clone the repo, create a virtual environment, or start the backend themselves. For that reason, the extension package and backend runtime are shipped separately:

- The VSIX contains the extension code and lightweight backend source.
- The runtime ZIP contains the standalone Python runtime and backend dependencies.
- The extension downloads the runtime ZIP on first use.

Build the Windows runtime bundle with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build_release_runtime.ps1
```

This creates:

```text
dist/runtime/semantic-search-runtime-win32-x64.zip
```

Upload that ZIP to the GitHub Release matching the extension version, for example:

```text
v0.0.1
```

The expected release asset name is:

```text
semantic-search-runtime-win32-x64.zip
```

## Publishing

Package the extension:

```powershell
npm run package:vsix
```

The generated `.vsix` can be uploaded through the Visual Studio Marketplace publisher dashboard or published with `vsce`.

Before publishing, check that:

- `backend/.venv-release/` is excluded by `.vscodeignore`.
- `*.vsix` is ignored and not committed.
- `dist/runtime/` is ignored and not committed.
- The matching GitHub Release contains the runtime ZIP.
- `package.json` has the correct `publisher`, `repository`, `version`, and extension metadata.


```

## Roadmap

- Improve first-run indexing feedback.
- Add better handling for large repositories.
- Package macOS and Linux runtime bundles.
- Improve Marketplace listing assets and screenshots.
- Add more precise search result ranking and filtering.

## License

See `LICENSE.txt`.
