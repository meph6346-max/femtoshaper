#!/usr/bin/env python3
"""
Strip non-ASCII characters ONLY from // and /* */ comments in C/C++/JS source files.

Rules:
- String literals ("..." and '...') are left untouched.
- Preprocessor directives (#...) preserved.
- Non-ASCII bytes inside comments are replaced with '?' (ASCII)
- After stripping, collapse runs of whitespace / '?' so the comment is readable.

Usage:
    python strip_korean_comments.py <file1> [file2 ...]
"""

from __future__ import annotations
import sys
import re
from pathlib import Path


def is_ascii(s: str) -> bool:
    return all(ord(c) < 128 for c in s)


def clean_comment_text(text: str) -> str:
    """Replace non-ASCII chars with space; collapse runs."""
    cleaned = ''.join(c if ord(c) < 128 else ' ' for c in text)
    # Collapse runs of whitespace
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    return cleaned


def process_line_comment(line: str) -> str:
    """Process a // comment: strip non-ASCII from the comment part only."""
    # Split on first // that's NOT inside a string
    # Simple state machine for C/C++/JS
    in_str = False
    str_ch = ''
    escape = False
    i = 0
    while i < len(line):
        c = line[i]
        if escape:
            escape = False
        elif c == '\\' and in_str:
            escape = True
        elif in_str:
            if c == str_ch:
                in_str = False
        else:
            if c == '"' or c == "'":
                in_str = True
                str_ch = c
            elif c == '/' and i + 1 < len(line) and line[i+1] == '/':
                # Found // comment start outside string
                code = line[:i]
                comment = line[i+2:]  # after //
                if is_ascii(comment):
                    return line
                cleaned = clean_comment_text(comment)
                return f"{code}// {cleaned}\n" if cleaned else f"{code}//\n"
        i += 1
    return line


def process_block_comments(content: str) -> str:
    """Process /* ... */ blocks: strip non-ASCII from text inside."""
    # Simpler approach: regex replacement of /* ... */ blocks
    # but respecting string context is complex. We process on a line-by-line
    # block-tracking basis.
    lines = content.split('\n')
    out = []
    in_block = False
    for line in lines:
        if in_block:
            end = line.find('*/')
            if end >= 0:
                before = line[:end]
                after = line[end+2:]
                if not is_ascii(before):
                    before = clean_comment_text(before)
                out.append(f"{before} */{after}")
                in_block = False
            else:
                if not is_ascii(line):
                    out.append(clean_comment_text(line))
                else:
                    out.append(line)
        else:
            # look for /* while respecting strings
            i = 0
            in_str = False
            str_ch = ''
            escape = False
            start_block = -1
            while i < len(line) - 1:
                c = line[i]
                if escape:
                    escape = False
                elif c == '\\' and in_str:
                    escape = True
                elif in_str:
                    if c == str_ch:
                        in_str = False
                else:
                    if c == '"' or c == "'":
                        in_str = True
                        str_ch = c
                    elif c == '/' and line[i+1] == '*':
                        start_block = i
                        break
                i += 1
            if start_block >= 0:
                # Check if block ends on same line
                end_idx = line.find('*/', start_block+2)
                if end_idx >= 0:
                    before = line[:start_block]
                    inner = line[start_block+2:end_idx]
                    after = line[end_idx+2:]
                    if not is_ascii(inner):
                        inner = clean_comment_text(inner)
                    out.append(f"{before}/* {inner} */{after}")
                else:
                    # Block continues
                    before = line[:start_block]
                    inner = line[start_block+2:]
                    if not is_ascii(inner):
                        inner = clean_comment_text(inner)
                    out.append(f"{before}/* {inner}")
                    in_block = True
            else:
                out.append(line)
    return '\n'.join(out)


def process_file(path: Path) -> int:
    """Process single file. Returns number of comment lines changed."""
    with path.open('rb') as f:
        raw = f.read()
    try:
        content = raw.decode('utf-8')
    except UnicodeDecodeError:
        # File may have mixed encoding; try latin-1 as fallback
        content = raw.decode('latin-1')

    # First pass: // line comments
    lines = content.split('\n')
    changed = 0
    for i, line in enumerate(lines):
        new_line = process_line_comment(line + '\n').rstrip('\n')
        if new_line != line:
            changed += 1
            lines[i] = new_line
    content = '\n'.join(lines)

    # Second pass: /* */ block comments
    new_content = process_block_comments(content)
    if new_content != content:
        # Hard to count block-comment changes; just note they happened
        changed += 1 if new_content != content else 0

    if new_content != (raw.decode('utf-8', errors='replace')) or changed:
        with path.open('wb') as f:
            f.write(new_content.encode('utf-8'))
    return changed


def main(argv):
    if len(argv) < 2:
        print("Usage: strip_korean_comments.py <file> [file ...]")
        return 1
    total = 0
    for arg in argv[1:]:
        p = Path(arg)
        if not p.is_file():
            print(f"skip (not a file): {p}")
            continue
        ch = process_file(p)
        print(f"{p}: {ch} lines changed")
        total += ch
    print(f"Total lines changed: {total}")
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
