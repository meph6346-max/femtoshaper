# FEMTO SHAPER Bug Fix Changelog

> **Codex / Claude Code Shared Reference**
>
> This file tracks all bug fixes applied to the codebase.
> Update this file whenever a fix is merged.
> Encoding: UTF-8 (no BOM). All string literals use `\uXXXX` escapes for non-ASCII.

---

## [BF-001] dsp.h: Static buffer retains stale data in dspNoiseFloor()

- **File**: `src/dsp.h` line ~373
- **Severity**: CRITICAL
- **Type**: C++ static local variable bug
- **Symptom**: Noise floor estimate polluted by data from previous measurement sessions.
- **Root cause**: `static float tmp[DSP_NBINS]` — `static` keyword causes the array to
  persist across function calls, carrying over values from the previous call.
- **Fix**: Removed `static`; added `n` bounds guard before sort loop.
- **Before**:
  ```cpp
  int n = binMax - kMin + 1;
  static float tmp[DSP_NBINS];
  ```
- **After**:
  ```cpp
  int n = binMax - kMin + 1;
  if (n <= 0 || n > DSP_NBINS) return 0.0f;
  float tmp[DSP_NBINS];
  ```

---

## [BF-002] main.cpp: SSE buffer direct index writes without bounds check

- **File**: `src/main.cpp` — both Print-mode SSE (~line 1483) and Live-mode SSE (~line 1539)
- **Severity**: HIGH
- **Type**: Buffer safety
- **Symptom**: `buf[len++] = ','` and `buf[len++] = '0'` had no guard — if `len`
  reached `sizeof(buf)-1`, the next write would be out-of-bounds.
- **Fix**: Added `len < (int)sizeof(buf)-12` loop guard and `len < (int)sizeof(buf)-2`
  per-write guard to all four direct-index assignments in both SSE loops.
- **Note**: In practice buf[2048] is large enough for 59 bins, but the guard is now explicit.

---

## [BF-003] main.cpp: `abs()` used on float (should be `fabs()`)

- **File**: `src/main.cpp` ~line 1094 (handleMeasStatus)
- **Severity**: HIGH
- **Type**: Wrong function for type
- **Symptom**: `abs()` is the integer absolute value function. On float operands it
  truncates to int first, then takes absolute value — wrong result for sub-integer
  differences.
- **Fix**: `abs(k * dspFreqRes() - st.peakFreq) > 15` -> `fabs(...) > 15.0f`

---

## [BF-004] main.cpp: Live SSE missing `sy` field (API inconsistency)

- **File**: `src/main.cpp` ~line 1534
- **Severity**: LOW
- **Type**: API inconsistency
- **Symptom**: Print-mode SSE sends `{"sx":..., "sy":...}` but Live-mode SSE only sent
  `{"sx":...}`. JS `live.js` had no issues because it does not use `sy` from live
  events, but the field is expected for symmetry.
- **Fix**: Added `"sy":%d` to the live SSE header format string.

---

## [BF-005] main.cpp: hostname validation — operator precedence ambiguity

- **File**: `src/main.cpp` ~line 591
- **Severity**: MEDIUM (logic was accidentally correct, but unreadable)
- **Type**: Operator precedence / readability
- **Before**:
  ```cpp
  if (cfg.hostname[0]=='\0' || !(a-z) && !(A-Z))
  ```
- **After**:
  ```cpp
  if (cfg.hostname[0]=='\0' || (!(a-z) && !(A-Z)))
  ```
- **Note**: The original was semantically correct due to C++ precedence rules, but the
  added parentheses make the intent explicit and prevent future misreading.

---

## [BF-006] main.cpp: Division by `_segCount` without zero guard in boot noise loop

- **File**: `src/main.cpp` ~line 1423
- **Severity**: MEDIUM
- **Type**: Division by zero (defensive)
- **Symptom**: `_psdSum[k] / (float)_segCount` inside the boot noise processing block.
  In practice `dspBgSegs > 0` implies `_segCount >= 5`, but an explicit guard is safer.
- **Fix**: Added `if (_segCount <= 0) break;` at the top of the PSD loop body.

---

## [BF-007] app.js: Garbled Unicode / broken HTML in log messages

- **File**: `data/app.js` — lines 410, 433, 434, 436, 437, 510
- **Severity**: CRITICAL
- **Type**: Encoding corruption (source file encoding issue)
- **Symptom**: Check mark and cross mark characters (originally `\u2713` / `\u2717`)
  were corrupted to `??` during a codex encoding incident. Additionally, `??/span>`
  was missing the leading `<`, producing invalid HTML like `??/span>` instead of
  `\u2713</span>`.
- **Fix**: Replaced all corrupted sequences with `\uXXXX` Unicode escapes:
  - `??/span>` -> `\u2713</span>` (check mark)
  - `??/span>` in log-err -> `\u2717</span>` (cross mark)
  - `'??'` prefix strings -> `'\u2713 '` or `'\u2717 '`

> **IMPORTANT for Codex**: Always use `\uXXXX` escapes for any non-ASCII symbol in JS
> string literals. Do NOT paste emoji or special characters directly — they get
> corrupted when the file is re-encoded. This is the primary cause of BF-007.

---

## [BF-008] app.js: `toggleApplyPanel()` null dereference

- **File**: `data/app.js` ~line 372
- **Severity**: HIGH
- **Type**: Null pointer dereference
- **Symptom**: `document.getElementById('applyPanel')` returns `null` if the element
  does not exist. Calling `.classList.toggle()` on `null` throws a TypeError.
- **Fix**: Added early return guard: `if (!panel) return;`

---

## [BF-009] settings.js: Duplicate vector utility function definitions

- **File**: `data/settings.js` ~lines 500-505 (old) and 513-519 (canonical)
- **Severity**: HIGH
- **Type**: Dead code / silent function shadowing
- **Symptom**: `vecNorm`, `vecLen`, `vecDot`, `vecSub`, `vecScale`, `vecCross` were
  declared twice in the same scope. JavaScript hoists all function declarations;
  the second definition silently replaces the first. The two definitions differed:
  - First `vecNorm` used epsilon `1e-9`; second used `1e-12` (more precise).
  - First `vecNorm` was standalone; second used `vecLen()` internally.
- **Fix**: Removed the first (obsolete) set of definitions (lines 500-505).
  The canonical second set (lines 513-519) is now the only definition.

---

## Pending / Not Fixed (Deferred)

| ID | File | Line | Severity | Description |
|----|------|------|----------|-------------|
| P-01 | `settings.js` | ~600,749 | LOW | `fetch('/api/adxl/raw')` has no AbortController timeout — polling stalls if ESP32 hangs |
| P-02 | `charts.js` | ~155 | LOW | Frequency label uses hardcoded `3.125` resolution instead of deriving from PSD data |
| P-03 | `shaper.js` | ~589 | MEDIUM | Catmull-Rom interpolation: guard needed for `psd[i2].f == psd[i1].f` (division by zero in frequency denominator) |
| P-04 | `dsp.h` | ~787 | LOW | `dspDualFindPeak` early-exit condition uses `&&` — should use `||` if `segCount=0` OR `weightSum<eps` |

---

## Encoding Rules for Codex Collaboration

1. **All source files must be saved as UTF-8 without BOM.**
2. **Never paste emoji or Korean/CJK characters directly into JS string literals.**
   Use `\uXXXX` escapes. Example: `'\u2713'` not `'✓'`.
3. **C++ comments may contain Korean** — they are in string literals only for Serial
   output and are harmless. Do not convert them.
4. **Do not add or remove the BOM** from any file — the build system expects BOM-free UTF-8.
5. **When editing JS files**, run a quick grep for `??` after saving to detect encoding
   corruption before committing:
   ```bash
   grep -rn '\?\?' data/*.js
   ```

---

## How to Verify Fixes

```bash
# Check no garbled unicode remains in JS
grep -rn '\?\?' data/*.js

# Check fabs usage in C++
grep -n 'abs(' src/main.cpp | grep -v 'fabs'

# Build firmware (PlatformIO)
pio run -t upload && pio run -t uploadfs

# Run JS test suites
node test_v10_integ.js
node test_v10_full.js
```

---

*Last updated: 2026-04-22 by Claude Code (claude-sonnet-4-6)*
*Session branch: claude/clever-lichterman-066b6f*
