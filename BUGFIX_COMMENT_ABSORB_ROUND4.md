# Comment-Absorbed-Code Bug Sweep — Round 4 (2026-04-22)

> **Audience:** Codex and other Claude instances picking up this repository.
> Round 3 (PR #2, merged) left the paren/brace checker reporting "OK", but
> that was a **false positive**. This round shows why, and fixes the real
> underlying class of bug: **unterminated string literals** that silently
> absorbed large blocks of real source code.

## Headline

Round 3's checker output was:
```
src/main.cpp: braces 250/250 [+0], parens 1402/1402 [+0]  OK
```
Round 4's **real** checker output, after fixing five unclosed `"`:
```
src/main.cpp: braces 265/265 [+0], parens 1456/1456 [+0]  OK
```
The gap (15 new `{`+`}`, 54 new `(`+`)`) is code that was always there but
was hidden inside runaway string literals. The brace counts balanced by
coincidence because each runaway happened to close at another stray quote
elsewhere in the file.

**Running total:** 128 (before) + 5 = **133** absorbed-code bugs fixed.

## Bugs fixed

All in `src/main.cpp`. Every one is an unterminated `"` that made the
downstream parser run for a long time inside string-mode.

### [BF-R4-001] Line 43 — embedded newline in `Serial.printf` format string

**Before (2 physical lines of source, one string literal):**
```cpp
    Serial.printf("[JSON] Response too large: %u > %u
", (unsigned)need, (unsigned)sizeof(_jbuf));
```
The `\n` in the intended format string was replaced with a raw newline
byte. A standard-conformant C++ compiler rejects an unescaped newline
inside a string literal. The brace checker accepted it because the `"`
at the start of line 44 eventually closed the string.

**Fix:** Put it on one line with a proper `\n` escape:
```cpp
    Serial.printf("[JSON] Response too large: %u > %u\n", (unsigned)need, (unsigned)sizeof(_jbuf));
```

### [BF-R4-002] Line 410 (was 411) — lost `\` escape on closing JSON `"`

**Before:**
```cpp
server.send(200, "application/json", "{\"ok\":true,\"msg\":\"<garbled>?"}");
```
The source was missing a `\` before the `"` after `?`. The outer C++
string therefore closed at that `"`, then `}` sat outside any string as
gibberish, and the next `"` re-opened an unterminated string running to
the next stray quote.

**Fix:** Replace the whole garbled message with an ASCII log string:
```cpp
server.send(200, "application/json", "{\"ok\":true,\"msg\":\"rate sampling started\"}");
```

### [BF-R4-003] Line 457 — `Serial.println("[NVS] <garbled>);` runs away 200+ lines

**Before:**
```cpp
Serial.println("[NVS] <korean-garbled>);
```
No closing `"` before `)`. The string state persisted all the way to the
next `"` on **line 658** (inside a `"{\"ok\":false,\"error\":...}"` JSON
blob). That consumed the *entire* `loadConfig` body, the **entirety** of
`saveConfig`, `handleGetConfig`, and the opening of `handlePostConfig` —
roughly 200 lines the brace checker never saw.

**Fix:**
```cpp
Serial.println("[NVS] first-boot: no saved config, writing defaults");
```

### [BF-R4-004] Line 1844 (was 1846) — `[HEAP]` critical-low log runaway

**Before:**
```cpp
Serial.println("[HEAP] ?<korean-garbled>???);
```
Missing closing `"`. Runaway ate the surrounding reboot branch plus ~10
lines of following WiFi-failover code until the next `"` appeared.

**Fix:**
```cpp
Serial.println("[HEAP] critical low - rebooting");
```

### [BF-R4-005] Line 1890 (was 1891) — `[WiFi] Stage 3` runaway ate to EOF

**Before:**
```cpp
Serial.println("[WiFi] Stage 3 ???<garbled>???);
```
Missing closing `"`. There was **no further `"` in the file**, so the
runaway swallowed lines 1891 through the end-of-file (~47 lines of the
deep-sleep / reset-button / activity-watchdog paths). The brace/paren
imbalance it introduced was cancelled out by the runaway on line 457.

**Fix:**
```cpp
Serial.println("[WiFi] Stage 3 failed - rebooting");
```

---

## Why round 3's OK was a lie

The `scripts/check_brace_balance.py` checker tracks `" / '` string state
and correctly skips counted chars inside them. But it has no sanity check
for *"did this string close on the same line?"*. When BF-R4-003 opens a
string on line 457 and BF-R4-005 opens another on line 1891, each runs
until it hits the next stray quote — and those stray quotes happened to
appear inside unterminated messages, balancing the counts by luck.

So the checker reported balanced even with **hundreds** of lines hidden.

## Detection script (reusable)

A Python scan that flags any line which ENDS with the parser still inside
a string literal. Save as `scripts/check_unclosed_strings.py` for future
sweeps (not added in this PR to keep the diff surgical; reproduce inline
if you need it):

```python
import sys, os

def scan(fn):
    with open(fn, 'rb') as f:
        data = f.read().decode('utf-8', errors='replace')
    in_line = in_block = in_str = in_tmpl = False
    str_ch = ''
    esc = False
    line = 1
    str_start = 0
    bad = []
    for i, c in enumerate(data):
        if c == '\n':
            if in_str and not in_tmpl:
                bad.append((str_start, line))
            line += 1
            in_line = False
            continue
        if esc: esc = False; continue
        if in_line: continue
        if in_block:
            if c == '*' and i+1 < len(data) and data[i+1] == '/':
                in_block = False
            continue
        if in_str:
            if c == '\\': esc = True
            elif c == str_ch: in_str = False
            continue
        if in_tmpl:
            if c == '\\': esc = True
            elif c == '`': in_tmpl = False
            continue
        if c == '`':
            in_tmpl = True; continue
        if c in '"\'':
            in_str = True; str_ch = c; str_start = line; continue
        if c == '/' and i+1 < len(data):
            if data[i+1] == '/': in_line = True; continue
            if data[i+1] == '*': in_block = True; continue
    for start, end in bad[:10]:
        print(f"{fn}: string opened line {start}, still open at EOL {end}")

for fn in sys.argv[1:]:
    scan(fn)
```

**Known false positives:** the JS-aware version still flags regex literals
(`/"/g`, `/[&<>"']/g` in `data/measure.js:50–54` and
`data/settings.js:953–956`). `node --check` is the authoritative test for
those files; both pass cleanly.

## How to run a clean sweep next time

1. `python3 scripts/check_brace_balance.py src/main.cpp src/dsp.h` —
   catches gross imbalances.
2. `python3 /tmp/check_unclosed_strings.py src/*.cpp src/*.h data/*.js` —
   catches runaway strings that would otherwise hide bugs from (1).
3. Inline-comment absorbed code (round 3 territory):
   ```bash
   grep -nE "//[^/]*[;){}]\s*$" src/main.cpp | grep -v "^[[:space:]]*//"
   grep -nE "//[^/]*\b(static|extern|#define|enum|struct|typedef)\b" src/main.cpp
   ```
4. Manual check of Korean-garbled `Serial.print*` strings: every one is a
   closing-quote candidate. `grep -P '[^\\x00-\\x7F]' src/main.cpp` surfaces
   them.

## Files verified clean this round (unclosed-string scan)

- `src/main.cpp` after fixes — clean.
- `src/dsp.h` — clean.
- `test/*.js` — all clean.
- `data/*.js` — all clean except regex-literal false positives on
  `measure.js` and `settings.js` (not a bug).

## Residual cleanup for future rounds

- Korean-garbled **comment text** still exists throughout. They are not
  code bugs (they are comments) but are noise. Strip in a focused pass.
- `scripts/check_brace_balance.py` could be upgraded to:
  (a) understand JS backticks and `${}` interpolation,
  (b) understand JS regex literals,
  (c) emit a warning when a `"` remains open at EOL.
  None of those upgrades are done in this round.

---

*Co-authored-by: Claude Opus 4.7 (sweep + patches)*
*Branch: `claude/fix-comment-parsing-bug-NXstQ`*
