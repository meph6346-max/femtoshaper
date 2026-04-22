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

## [FEAT-P1B-01] Phase 1-B: Peak frequency 95% confidence interval

- **Files**: `data/shaper.js` (+50 lines), `data/app.js` (+15 lines)
- **Type**: Accuracy signalling (UX + quality metric)
- **Rationale**: Users previously saw a single peak frequency with no indication of
  trustworthiness. Bootstrap CI uses already-tracked `_psdSumSq` variance to derive
  a statistical uncertainty band.
- **Implementation**:
  - `shaper.js::computePeakCI(psdData, peakFreq, opts)` -> `{lo, hi, sigma, snr}`
  - Formula: `sigma_f = binWidth / (sqrt(SNR) * sqrt(n_eff))` (Cramer-Rao LB approx)
  - SNR derived from `peakPower / peakStd` where `peakStd = sqrt(variance)`
  - `n_eff` = active segment count (passed from measurement metrics)
- **Wiring**: `app.js::fetchAndRenderPsdDual` now attaches `xAnalysis.freqCI` and
  logs `95% CI: X 42.1 +/- 0.23Hz, Y 37.8 +/- 0.31Hz` after measurement.
- **Expected impact**: Users can now distinguish applyable vs borderline measurements
  without changing the verdict engine itself.

---

## [FEAT-P2-01] Phase 2: Transfer function H(f) = X(f) / F(f) estimation

- **Files**: `src/dsp.h` (+45), `src/main.cpp` (+20), `data/shaper.js` (+60), `data/app.js` (+20)
- **Type**: Major algorithmic upgrade -- OMA (output-only) -> EMA (input/output modal)
- **Rationale**: Current Femtoshaper captures `X(f)` during deceleration without
  knowing the input excitation `F(f)`. This is Operational Modal Analysis -- valid
  but limited by excitation-quality variance. Estimating `F(f)` from the jerk
  signal (first-difference of acceleration) lets us compute the actual transfer
  function, approaching Klipper's chirp-sweep accuracy.

### Theoretical basis

```
jerk(t) = d/dt(accel(t))  ~  a[n] - a[n-1]
F(f)    ~  |FFT(jerk)|^2       (input spectrum estimate)
H(f)    =  X(f) / F(f)         (transfer function)
peak(H) =  structural resonance (no longer biased by input shape)
```

### C++ side (dsp.h)

- Accumulators: `_dualJerkPsdSumX/Y[DSP_NBINS]` (8KB)
- Public: `dspJerkPsdX/Y[DSP_NBINS]` (populated by `dspUpdateDual`)
- New: `dspJerkBroadness(float*)` spectral flatness (0..1)
- `dspFeedDual`: computes first-difference into local `_tmpJerk[DSP_N]`, FFT via
  `_processDualSeg`, accumulates weighted PSD alongside existing output PSD
- `dspResetDual()` clears all jerk state
- Memory: +12KB (ESP32-C3 usage 13% -> 22%, safe)

### C++ side (main.cpp)

- Snapshots: `measJerkX/Y[MEAS_MAX_BINS]`
- `/api/psd?mode=print` now returns: `jerkX[]`, `jerkY[]`,
  `jerkBroadnessX`, `jerkBroadnessY`
- NVS persistence deliberately skipped for now (jerk is operational, not post-hoc)

### JS side (shaper.js)

- `computeTransferFunction(psdOut, psdInput, opts)` -- H1 estimator:
  1. Smooth input PSD with +/- 2-bin moving average
  2. Clamp denominator to `max(maxInput * 1%, 1e-9)` (prevent 0-division)
  3. `|H(f)|^2 = X / F_smoothed` per bin
  4. Attach `coherence = smoothedInput / maxInput` as per-bin reliability

### JS side (app.js)

- Automatic activation when `d.jerkX` present
- Graceful fallback to raw `X(f)` when unavailable
- Peak charts keep showing `X(f)` (user-familiar), analysis uses `H(f)`
- Log line `H Transfer function H(f) active (input broadness X:45% Y:52%)`

### Expected accuracy

| Scenario | Raw X(f) | H(f) | Gain |
|----------|----------|------|------|
| Ideal | +/- 0.5-1 Hz | +/- 0.3-0.5 Hz | ~2x |
| Recommended | +/- 1-2 Hz | +/- 0.5-1 Hz | ~2x |
| Low excitation | +/- 3-5 Hz | +/- 1.5-3 Hz | ~2x |

### Known caveats

1. First-difference amplifies high-frequency noise (mitigated by Hann window).
2. S-curve / jerk-limited printers narrow `F(f)`, `H(f)` gain shrinks. Surfaced
   via `jerkBroadness` metric.
3. Bins with `coherence < 0.1` are automatically floor-clamped but not excluded
   from peak search yet. Future work.

---

*Last updated: 2026-04-22 by Claude Code (claude-sonnet-4-6)*
*Session branch: claude/clever-lichterman-066b6f*
