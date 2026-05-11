from __future__ import annotations

import argparse
import json
import platform
import shutil
import tarfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
DEFAULT_OUTPUT_DIR = ROOT / "dist" / "runtime"
LOCAL_TMP_DIR = ROOT / ".tmp"


def detect_platform_key() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()

    if system == "windows":
        platform_name = "win32"
    elif system == "darwin":
        platform_name = "darwin"
    elif system == "linux":
        platform_name = "linux"
    else:
        raise RuntimeError(f"Unsupported host platform: {system}")

    if machine in {"amd64", "x86_64", "x64"}:
        arch = "x64"
    elif machine in {"arm64", "aarch64"}:
        arch = "arm64"
    else:
        raise RuntimeError(f"Unsupported host architecture: {machine}")

    return f"{platform_name}-{arch}"


def read_extension_version() -> str:
    package_json = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    return str(package_json["version"])


def copy_backend_tree(staging_root: Path, venv_source: Path) -> None:
    backend_target = staging_root / "backend"
    backend_target.mkdir(parents=True, exist_ok=True)

    for relative in [
        "__init__.py",
        "api",
        "indexing",
        "assets",
    ]:
        source = BACKEND_ROOT / relative
        destination = backend_target / relative
        if source.is_dir():
            shutil.copytree(source, destination, dirs_exist_ok=True)
        else:
            shutil.copy2(source, destination)

    data_workspace = backend_target / "data" / "embeddings" / "workspace"
    data_workspace.mkdir(parents=True, exist_ok=True)

    shutil.copytree(
        venv_source,
        backend_target / ".venv",
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
    )

    prune_runtime_tree(backend_target / ".venv")


def prune_runtime_tree(venv_root: Path) -> None:
    removable_dirs = [
        venv_root / "Lib" / "site-packages" / "pip",
        venv_root / "Lib" / "site-packages" / "pip-26.1.1.dist-info",
        venv_root / "Lib" / "site-packages" / "setuptools",
        venv_root / "Lib" / "site-packages" / "setuptools-70.2.0.dist-info",
        venv_root / "Lib" / "site-packages" / "wheel",
        venv_root / "Lib" / "site-packages" / "wheel-0.45.1.dist-info",
        venv_root / "share",
    ]
    for target in removable_dirs:
        shutil.rmtree(target, ignore_errors=True)

    removable_files = [
        venv_root / "Scripts" / "pip.exe",
        venv_root / "Scripts" / "pip3.exe",
        venv_root / "Scripts" / "pip3.14.exe",
        venv_root / "Scripts" / "hf.exe",
        venv_root / "Scripts" / "huggingface-cli.exe",
        venv_root / "Scripts" / "f2py.exe",
        venv_root / "Scripts" / "numpy-config.exe",
        venv_root / "Scripts" / "markdown-it.exe",
        venv_root / "Scripts" / "pygmentize.exe",
        venv_root / "Scripts" / "tiny-agents.exe",
        venv_root / "Scripts" / "transformers.exe",
        venv_root / "Scripts" / "typer.exe",
        venv_root / "Scripts" / "tqdm.exe",
        venv_root / "Scripts" / "fastapi.exe",
    ]
    for target in removable_files:
        target.unlink(missing_ok=True)

    for pattern in ("*.pyc", "*.pyo", "*.lib", "*.exp", "*.pdb"):
        for file_path in venv_root.rglob(pattern):
            file_path.unlink(missing_ok=True)


def write_manifest(staging_root: Path, version: str, platform_key: str) -> None:
    python_relative_path = (
        "backend/.venv/Scripts/python.exe"
        if platform_key.startswith("win32-")
        else "backend/.venv/bin/python"
    )
    manifest = {
        "version": version,
        "platform": platform_key,
        "pythonRelativePath": python_relative_path,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    (staging_root / "runtime-manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )


def build_archive(staging_root: Path, output_file: Path, platform_key: str) -> None:
    output_file.parent.mkdir(parents=True, exist_ok=True)
    if output_file.suffix == ".zip":
        with zipfile.ZipFile(output_file, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for file_path in staging_root.rglob("*"):
                archive.write(file_path, file_path.relative_to(staging_root))
        return

    with tarfile.open(output_file, "w:gz") as archive:
        archive.add(staging_root, arcname=".")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--platform", default=detect_platform_key())
    parser.add_argument("--version", default=read_extension_version())
    parser.add_argument("--venv", default=str(BACKEND_ROOT / ".venv"))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    args = parser.parse_args()

    platform_key = args.platform
    venv_source = Path(args.venv).resolve()
    output_dir = Path(args.output_dir).resolve()

    if not venv_source.exists():
        raise FileNotFoundError(f"Missing runtime virtualenv: {venv_source}")

    archive_extension = ".zip" if platform_key.startswith("win32-") else ".tar.gz"
    output_file = output_dir / f"semantic-search-runtime-{platform_key}{archive_extension}"

    LOCAL_TMP_DIR.mkdir(parents=True, exist_ok=True)
    staging_root = LOCAL_TMP_DIR / f"runtime-build-{platform_key}"
    shutil.rmtree(staging_root, ignore_errors=True)
    staging_root.mkdir(parents=True, exist_ok=True)

    try:
        copy_backend_tree(staging_root, venv_source)
        write_manifest(staging_root, args.version, platform_key)
        build_archive(staging_root, output_file, platform_key)
    finally:
        shutil.rmtree(staging_root, ignore_errors=True)

    print(output_file)


if __name__ == "__main__":
    main()
