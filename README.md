# Semantic Search Ext

Semantic Search Ext is a VS Code extension for semantic code search. It lets you search a workspace by intent instead of only by exact text matches.

## What Changed

This project no longer relies on your local repo checkout or your system Python to work.

The VS Code extension is the lightweight package published to the Marketplace. The Python backend runtime is built separately as a platform-specific archive and downloaded on first run. The backend model config and tokenizer are vendored locally under `backend/assets/codebert-base`.

That is the practical way to make this installable from the Marketplace without shipping the whole development environment inside the VSIX.

## Repository Layout

```text
src/                         Extension source
out/                         Compiled extension output
backend/                     Backend source, local dev runtime, and model assets
scripts/                     Packaging helpers for runtime bundles
dist/runtime/                Generated runtime archives, ignored by git
```

## Local Development

Create or refresh the backend virtual environment:

```powershell
python -m venv backend/.venv
```

Install backend dependencies:

```powershell
backend/.venv/Scripts/pip install -r requirements.txt
```

Stage tokenizer/config assets if needed:

```powershell
backend/.venv/Scripts/python.exe scripts/stage_model_assets.py
```

Install extension dependencies:

```powershell
npm install
```

Compile:

```powershell
npm run compile
```

Run with `F5` in VS Code. In dev mode, the extension can use `backend/.venv` directly.

## Publish Flow

### 1. Build the runtime bundle on each target platform

Run the runtime builder on each platform you want to support.

Windows x64:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build_release_runtime.ps1
```

This generates an archive like:

```text
dist/runtime/semantic-search-runtime-win32-x64.zip
```

For macOS and Linux, run the platform-specific runtime builder on those platforms so the archive contains the correct platform runtime.

Important:

- Do not build production runtime bundles from a GPU-heavy dev environment if you can avoid it.
- The archive built from a CUDA/PyTorch dev environment can be several gigabytes.
- For release builds, create a clean CPU-only dependency environment and package it with the Windows embeddable Python distribution.

Example:

```powershell
backend/.venv/Scripts/python.exe scripts/build_windows_standalone_runtime.py --venv path\to\cpu-only-venv
```

On Windows, the helper script wraps that flow:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build_release_runtime.ps1
```

### 2. Upload runtime bundles to a GitHub Release

Create a GitHub release tag that matches the extension version:

```text
v0.0.1
```

Upload the platform archives to that release, for example:

```text
semantic-search-runtime-win32-x64.zip
semantic-search-runtime-darwin-arm64.tar.gz
semantic-search-runtime-linux-x64.tar.gz
```

The extension derives the runtime download URL from `package.json.repository` by default:

```text
https://github.com/<owner>/<repo>/releases/download/v<extension-version>
```

You can override this with the `semanticSearch.runtimeBaseUrl` setting.

### 3. Package and publish the extension

Official VS Code docs for packaging and publishing:

[Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)

Package the VSIX:

```powershell
npm run package:vsix
```

Publish with `vsce`:

```powershell
npx @vscode/vsce publish
```

You will need:

- A VS Code Marketplace publisher.
- An Azure DevOps Personal Access Token for `vsce publish`.

## First-Run User Experience

After a user installs the extension from the Marketplace:

1. The extension activates.
2. If the runtime is missing, it downloads the correct platform archive into VS Code global storage.
3. It starts the backend locally.
4. It indexes the open workspace.
5. `Ctrl+Shift+K` runs semantic search.

## Reality Check

"Works on any machine" still means you must produce and upload one runtime bundle per platform you claim to support.

Right now this repo is ready for that release model, but it does not magically create macOS or Linux runtimes from Windows. You still need platform builds for those targets.

## License

See `LICENSE.txt`.
