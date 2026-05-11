param(
    [string]$RuntimeVenv = "backend\.venv-release",
    [string]$PythonCommand = "python"
)

$ErrorActionPreference = "Stop"

Write-Host "Creating release runtime venv at $RuntimeVenv"
& $PythonCommand -m venv $RuntimeVenv

$pythonExe = Join-Path $RuntimeVenv "Scripts\python.exe"
$pipExe = Join-Path $RuntimeVenv "Scripts\pip.exe"

Write-Host "Installing base dependencies"
& $pipExe install --upgrade pip
& $pipExe install fastapi uvicorn transformers numpy faiss-cpu pydantic

Write-Host "Installing CPU-only PyTorch"
& $pipExe install --index-url https://download.pytorch.org/whl/cpu torch

Write-Host "Staging tokenizer and config assets"
& $pythonExe scripts\stage_model_assets.py

Write-Host "Building runtime bundle"
& $pythonExe scripts\build_runtime_bundle.py --venv $RuntimeVenv

