# Round 27 — Restart-from-scratch Lap 1: absorbed-code exhausted + NVS read-path hardening (2026-04-22)

> **Audience:** Codex / other Claude. User asked for a fresh 3-lap chain
> starting again from the absorbed-code origin pattern. Lap 1 of 3.

## 1. Absorbed-code re-scan: exhausted

Broad scan across `.cpp`, `.h`, `.hpp`, `.c`, `.js`, `.css`, `.html`,
`.py`, `.ino` (excluding build/cache dirs) with four detection patterns:

- `susp_trail` (multi-token `//` followed by identifier + `(/[/=`)
- `block_cmt_code` (`/* ... ; ... */`)
- `css_cmt_decl`  (`/* prop: val; */`)
- `garbled_near_code` (`???...` adjacent to `; { } = ( )`)

**Results:** 88 `susp_trail` hits all legitimate trailing comments
(e.g. `#define ADXL_SCK 4  // GPIO4 = SCK`), 1 `block_cmt_code` in a
Python script that legitimately emits block comments, 1
`garbled_near_code` in `data/app.js:28` that is a benign Korean-garbled
comment with no code inside.

No newly-absorbed code. Pattern fixpoint confirmed.

## 2. Chain-link 2 (runaway strings): clean

Lexer-style scan for odd `"` counts per line after stripping `//` and
`/* */`. 6 reported hits all false positives from scanner limitations
(JS regex literals `/"/g`, HTML-escape tables) — manual inspection
confirms every string is properly closed.

## 3. Chain-link 12 (NVS begin() return): 3 more sites hardened

R24/R25 established that `prefs.begin()` return must be checked.
Scanning found three read-path sites in `main.cpp` that still ignored
it. Individually each was benign (getXxx returns default on bad handle),
but the pattern is inconsistent and masks NVS mount failures from
Serial logs.

### [BF-R27-001] `loadBgPsdFromNVS` ignored `prefs.begin` return

- **File:** `src/main.cpp` `loadBgPsdFromNVS` (~line 982)
- **Class:** LOW (diagnostic consistency; no functional bug).
- **Symptom:** On NVS mount failure or first-boot absence of the
  `femto_bg` namespace, begin() returned false but execution continued
  into `prefs.getBool("valid", false)`, `getInt`, `getBytes` — all
  returning defaults. The function logged nothing. Indistinguishable
  from a successful load of a namespace with `valid=false`.
- **Fix:** Check return, log a distinct message on failure, return
  early. Matches the R24/R25 pattern.

### [BF-R27-002] Boot-time legacy-bgPsd probe ignored both `prefs.begin` returns

- **File:** `src/main.cpp` `setup()` (~line 1675)
- **Class:** LOW.
- **Symptom:** The legacy v0.8 513-bin clear probe opens `femto_bg`
  read-only, then reopens for write. Both `begin()` returns were
  ignored. On NVS failure the probe silently no-oped, and a
  subsequent write-reopen would also silently no-op.
- **Fix:** Nested `if (prefs.begin(...))` guards on both opens. Log on
  the write-reopen failure path so a partial legacy purge is visible.

## 4. Verification

```
python3 scripts/check_brace_balance.py src/main.cpp src/dsp.h
# braces 309/309 [+0], parens 1561/1561 [+0]  OK
# braces 102/102 [+0], parens  318/318 [+0]  OK
# (main.cpp gained 4 braces/5 parens from the new if-blocks, as expected)

g++ -std=c++17 -fsyntax-only -Wall -Wextra -I/tmp/stubs src/main.cpp
# 0 warnings, 0 errors

for f in data/*.js test/*.js; do node --check "$f"; done  # all pass

node test/sim_ci_validate.js  # baseline/fan/lowexc/noisy scenarios all OK
```

## 5. Running total

**197 bugs fixed** (195 + 2 this round).

## Summary of lap 1/3

Absorbed-code origin pattern truly exhausted at this scale. Only 2
diagnostic-consistency items found in the NVS read-path. Chain is
running out of material — if lap 2/3 also find nothing functional,
this marks the chain fixpoint.

---

*Co-authored-by: Claude Opus 4.7 (restart-from-scratch lap 1/3)*
