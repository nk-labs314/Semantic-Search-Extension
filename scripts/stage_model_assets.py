from __future__ import annotations

from pathlib import Path

from transformers import AutoConfig, AutoTokenizer


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "backend" / "assets" / "codebert-base"


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    AutoTokenizer.from_pretrained("microsoft/codebert-base", local_files_only=True).save_pretrained(
        OUTPUT_DIR
    )
    AutoConfig.from_pretrained("microsoft/codebert-base", local_files_only=True).save_pretrained(
        OUTPUT_DIR
    )
    print(OUTPUT_DIR)


if __name__ == "__main__":
    main()
