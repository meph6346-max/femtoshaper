#!/usr/bin/env python3
"""Fail fast on encoding issues that tend to corrupt firmware-hosted UI files."""

from __future__ import annotations

import sys
from pathlib import Path


TEXT_SUFFIXES = {
    ".c",
    ".cpp",
    ".css",
    ".h",
    ".hpp",
    ".html",
    ".ino",
    ".ini",
    ".js",
    ".json",
    ".py",
    ".txt",
    ".yml",
    ".yaml",
}

SKIP_PARTS = {
    ".git",
    ".pio",
    ".vscode",
    "__pycache__",
    ".claude",
}

BAD_PATTERNS = (
    "�",
    "??/div>",
    "??/span>",
    "??/button>",
    "??/pre>",
    "??/summary>",
    "??/details>",
)

ROOT_DIRS = {"data", "scripts", "src"}
ROOT_FILES = {
    ".editorconfig",
    ".gitattributes",
    "platformio.ini",
    "partitions.csv",
}


def iter_text_files(root: Path):
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if any(part in SKIP_PARTS for part in path.parts):
            continue
        rel = path.relative_to(root)
        top = rel.parts[0]
        if top not in ROOT_DIRS and rel.name not in ROOT_FILES:
            continue
        if rel.as_posix() == "scripts/check_encoding_safety.py":
            continue
        if path.suffix.lower() in TEXT_SUFFIXES:
            yield path


def safe_print(text: str) -> None:
    sys.stdout.buffer.write(text.encode("utf-8", errors="backslashreplace"))
    sys.stdout.buffer.write(b"\n")


def check_file(path: Path) -> list[str]:
    errors: list[str] = []
    raw = path.read_bytes()

    if raw.startswith(b"\xef\xbb\xbf"):
        errors.append("UTF-8 BOM detected")

    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        errors.append(f"invalid UTF-8: {exc}")
        return errors

    if "\r\n" in text:
        errors.append("CRLF line endings detected")

    for lineno, line in enumerate(text.splitlines(), 1):
        for pattern in BAD_PATTERNS:
            if pattern in line:
                errors.append(f"line {lineno}: suspicious mojibake pattern: {pattern}")

    return errors


def main() -> int:
    root = Path.cwd()
    failed = False

    for path in iter_text_files(root):
        issues = check_file(path)
        if not issues:
            continue
        failed = True
        rel = path.relative_to(root)
        safe_print(str(rel))
        for issue in issues:
            safe_print(f"  - {issue}")

    if failed:
        safe_print("\nEncoding safety check failed.")
        return 1

    safe_print("Encoding safety check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
