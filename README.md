# Semantic Search Ext

Semantic code search for VS Code with a Marketplace-friendly runtime bootstrap flow.

## What changed

This project no longer relies on your local repo checkout or your system Python to work.

- The VS Code extension is the lightweight package you publish to the Marketplace.
- The Python backend runtime is built as a platform-specific archive and downloaded on first run.
- The backend model config and tokenizer are vendored locally under `backend/assets/codebert-base`.

That is the only sane way to make this installable from the Marketplace without shipping your whole dev environment inside the VSIX.

## Repository layout

- `src/`: extension source
- `out/`: compiled extension output
- `backend/`: backend source, local dev runtime, and model assets
- `scripts/`: packaging helpers for runtime bundles

## Local development

1. Create or refresh the backend virtual environment:
   - Windows: `python -m venv backend/.venv`
2. Install backend dependencies:
   - Windows: `backend/.venv/Scripts/pip install -r requirements.txt`
3. Stage tokenizer/config assets if needed:
   - Windows: `backend/.venv/Scripts/python.exe scripts/stage_model_assets.py`
4. Install extension dependencies:
   - `npm install`
5. Compile:
   - `npm run compile`
6. Run with `F5` in VS Code.

In dev mode, the extension can use `backend/.venv` directly.

## Publish flow

### 1. Build the runtime bundle on each target platform

Run this on each platform you want to support:

- Windows x64:
  - `npm run runtime:bundle`

This generates an archive like:

- `dist/runtime/semantic-search-runtime-win32-x64.zip`

For macOS and Linux, run `scripts/build_runtime_bundle.py` on those platforms so the archive contains the correct platform runtime.

Important:

- Do not build production runtime bundles from a GPU-heavy dev venv if you can avoid it.
- The archive built from your current local Windows venv is roughly 3.06 GB because it includes large CUDA/PyTorch binaries.
- For release builds, create a clean CPU-only runtime venv and pass it to the bundler:
  - `backend/.venv/Scripts/python.exe scripts/build_runtime_bundle.py --venv path\\to\\cpu-only-venv`
- On Windows, there is a helper script for that flow:
  - `powershell -ExecutionPolicy Bypass -File scripts/build_release_runtime.ps1`

### 2. Upload runtime bundles to a GitHub Release

Create a GitHub release tag that matches the extension version:

- `v0.0.1`

Upload the platform archives to that release, for example:

- `semantic-search-runtime-win32-x64.zip`
- `semantic-search-runtime-darwin-arm64.tar.gz`
- `semantic-search-runtime-linux-x64.tar.gz`

The extension derives the runtime download URL from `package.json.repository` by default:

- `https://github.com/<owner>/<repo>/releases/download/v<extension-version>`

You can override this with the `semanticSearch.runtimeBaseUrl` setting.

### 3. Package and publish the extension

Official VS Code docs for packaging/publishing:

- [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)

Commands:

- `npm run package:vsix`
- `npx @vscode/vsce publish`

You will need:

- a VS Code Marketplace publisher
- an Azure DevOps Personal Access Token for `vsce publish`

## First-run user experience

After a user installs the extension from the Marketplace:

1. The extension activates.
2. If the runtime is missing, it downloads the correct platform archive into VS Code global storage.
3. It starts the backend locally.
4. It indexes the open workspace.
5. `Ctrl+Shift+K` runs semantic search.

## Reality check

“Works on any machine” still means you must produce and upload one runtime bundle per platform you claim to support.

Right now this repo is ready for that release model, but it does not magically create macOS/Linux runtimes from Windows. You still need platform builds for those targets.
