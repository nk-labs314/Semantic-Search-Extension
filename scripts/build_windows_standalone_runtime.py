from __future__ import annotations

import argparse
import json
import platform
import re
import shutil
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
CACHE_DIR = ROOT / ".cache" / "python"
DEFAULT_OUTPUT_DIR = ROOT / "dist" / "runtime"
TMP_DIR = ROOT / ".tmp"


def read_extension_version() -> str:
    package_json = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    return str(package_json["version"])


def read_python_version(venv_root: Path) -> str:
    cfg_path = venv_root / "pyvenv.cfg"
    if not cfg_path.exists():
        raise FileNotFoundError(f"Missing pyvenv.cfg: {cfg_path}")

    match = re.search(r"^version\s*=\s*(.+)$", cfg_path.read_text(encoding="utf-8"), re.M)
    if not match:
        raise RuntimeError(f"Could not read Python version from {cfg_path}")
    return match.group(1).strip()


def detect_platform_key() -> str:
    if platform.system().lower() != "windows":
        raise RuntimeError("This builder only creates Windows standalone runtimes")

    machine = platform.machine().lower()
    if machine in {"amd64", "x86_64", "x64"}:
        return "win32-x64"
    if machine in {"arm64", "aarch64"}:
        return "win32-arm64"
    raise RuntimeError(f"Unsupported Windows architecture: {machine}")


def python_embed_url(version: str, platform_key: str) -> str:
    suffix = "arm64" if platform_key.endswith("arm64") else "amd64"
    return f"https://www.python.org/ftp/python/{version}/python-{version}-embed-{suffix}.zip"


def download_embed_python(version: str, platform_key: str) -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    archive_path = CACHE_DIR / f"python-{version}-embed-{platform_key}.zip"
    if archive_path.exists():
        return archive_path

    url = python_embed_url(version, platform_key)
    print(f"Downloading {url}")
    urllib.request.urlretrieve(url, archive_path)
    return archive_path


def copy_backend_tree(staging_root: Path) -> None:
    backend_target = staging_root / "backend"
    backend_target.mkdir(parents=True, exist_ok=True)

    for relative in ["__init__.py", "api", "indexing", "assets"]:
        source = BACKEND_ROOT / relative
        destination = backend_target / relative
        if source.is_dir():
            shutil.copytree(source, destination, dirs_exist_ok=True)
        else:
            shutil.copy2(source, destination)

    (backend_target / "data" / "embeddings" / "workspace").mkdir(parents=True, exist_ok=True)


def copy_site_packages(venv_root: Path, python_root: Path) -> None:
    source = venv_root / "Lib" / "site-packages"
    destination = python_root / "Lib" / "site-packages"
    if not source.exists():
        raise FileNotFoundError(f"Missing site-packages: {source}")

    shutil.copytree(
        source,
        destination,
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo"),
    )
    prune_site_packages(destination)


def prune_site_packages(site_packages: Path) -> None:
    for target in [
        "pip",
        "pip-26.1.1.dist-info",
        "setuptools",
        "setuptools-70.2.0.dist-info",
        "wheel",
        "wheel-0.45.1.dist-info",
    ]:
        shutil.rmtree(site_packages / target, ignore_errors=True)

    for pattern in ("*.pyc", "*.pyo", "*.lib", "*.exp", "*.pdb"):
        for file_path in site_packages.rglob(pattern):
            file_path.unlink(missing_ok=True)


def configure_python_path_file(python_root: Path) -> None:
    pth_files = list(python_root.glob("python*._pth"))
    if not pth_files:
        raise FileNotFoundError(f"Could not find python*._pth under {python_root}")

    pth_path = pth_files[0]
    lines = []
    for line in pth_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped == "#import site":
            continue
        if stripped:
            lines.append(line)

    for required in [".", "Lib/site-packages", "import site"]:
        if required not in lines:
            lines.append(required)

    pth_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_manifest(staging_root: Path, version: str, platform_key: str, python_version: str) -> None:
    manifest = {
        "version": version,
        "platform": platform_key,
        "pythonRelativePath": "python/python.exe",
        "runtimeKind": "windows-embeddable-python",
        "pythonVersion": python_version,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    (staging_root / "runtime-manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )


def build_archive(staging_root: Path, output_file: Path) -> None:
    output_file.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output_file, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for file_path in staging_root.rglob("*"):
            archive.write(file_path, file_path.relative_to(staging_root))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--venv", default=str(BACKEND_ROOT / ".venv-release"))
    parser.add_argument("--version", default=read_extension_version())
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    args = parser.parse_args()

    platform_key = detect_platform_key()
    venv_root = Path(args.venv).resolve()
    output_dir = Path(args.output_dir).resolve()
    python_version = read_python_version(venv_root)
    embed_archive = download_embed_python(python_version, platform_key)
    output_file = output_dir / f"semantic-search-runtime-{platform_key}.zip"

    staging_root = TMP_DIR / f"standalone-runtime-{platform_key}"
    shutil.rmtree(staging_root, ignore_errors=True)
    staging_root.mkdir(parents=True, exist_ok=True)

    try:
        python_root = staging_root / "python"
        python_root.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(embed_archive) as archive:
            archive.extractall(python_root)

        configure_python_path_file(python_root)
        copy_site_packages(venv_root, python_root)
        copy_backend_tree(staging_root)
        write_manifest(staging_root, args.version, platform_key, python_version)
        build_archive(staging_root, output_file)
    finally:
        shutil.rmtree(staging_root, ignore_errors=True)

    print(output_file)


if __name__ == "__main__":
    main()
