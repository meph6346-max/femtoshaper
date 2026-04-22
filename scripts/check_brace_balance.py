#!/usr/bin/env python3
"""Count braces/parens in C/C++/JS, ignoring strings and comments."""
import sys

def count_braces_safe(s):
    out = []
    i = 0
    in_str = False
    str_ch = ''
    esc = False
    in_line_cmt = False
    in_block_cmt = False
    while i < len(s):
        c = s[i]
        if esc:
            esc = False
            i += 1
            continue
        if in_line_cmt:
            if c == '\n':
                in_line_cmt = False
            i += 1
            continue
        if in_block_cmt:
            if c == '*' and i + 1 < len(s) and s[i+1] == '/':
                in_block_cmt = False
                i += 2
                continue
            i += 1
            continue
        if in_str:
            if c == '\\':
                esc = True
            elif c == str_ch:
                in_str = False
            i += 1
            continue
        if c == '"' or c == "'":
            in_str = True
            str_ch = c
            i += 1
            continue
        if c == '/' and i + 1 < len(s):
            if s[i+1] == '/':
                in_line_cmt = True
                i += 2
                continue
            if s[i+1] == '*':
                in_block_cmt = True
                i += 2
                continue
        out.append(c)
        i += 1
    code = ''.join(out)
    return code.count('{'), code.count('}'), code.count('('), code.count(')')


def main():
    for fn in sys.argv[1:]:
        try:
            with open(fn, 'r', encoding='utf-8', errors='replace') as f:
                content = f.read()
        except OSError:
            print(f"cannot read: {fn}")
            continue
        ob, cb, op, cp = count_braces_safe(content)
        bd = ob - cb
        pd = op - cp
        status = "OK" if bd == 0 and pd == 0 else "MISMATCH"
        print(f"{fn}: braces {ob}/{cb} [{bd:+d}], parens {op}/{cp} [{pd:+d}]  {status}")


if __name__ == '__main__':
    main()
