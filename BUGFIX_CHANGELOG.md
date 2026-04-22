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

- **Opt-in only** via `window._hfMode = true` (see FEAT-P2-02 below)
- Graceful fallback to raw `X(f)` when jerk data unavailable
- Peak charts keep showing `X(f)` (user-familiar), analysis uses `H(f)` if enabled
- Log line `H [EXPERIMENTAL] Transfer function H(f) active (...)` makes opt-in state clear

---

## [FEAT-P2-02] Phase 2 auto-activation REVERTED (simulation-driven correction)

- **Files**: `data/app.js` (~line 75)
- **Date**: Added in same session as FEAT-P2-01, after simulation-based validation
- **Type**: Safety rollback / theoretical correction

### What changed

`app.js::fetchAndRenderPsdDual` no longer auto-activates H(f) mode when jerk data
is present. It now requires an explicit opt-in:

```javascript
if (typeof window !== 'undefined' && window._hfMode === true && ...)
```

### Why we reverted auto-activation

After implementing FEAT-P2-01, we built `test/sim_accuracy.js` to quantify the
improvement. The simulation generates synthetic printer signals (2nd-order system
driven by random decel events) with known ground-truth resonance, then runs both
raw `X(f)` and `H(f) = X(f) / F(f)` peak detection pipelines.

**Simulation results (7 scenarios x 5 trials each):**

| Scenario | Raw X(f) err | H(f) err | H(f) / Raw |
|----------|--------------|----------|------------|
| Typical (42Hz) | 1.26 Hz | **19.97 Hz** | 15.8x worse |
| Low freq (25Hz) | 0.26 Hz | 0.27 Hz | 1.04x |
| High freq (80Hz) | 3.43 Hz | **47.01 Hz** | 13.7x worse |
| Low damping (42Hz, z=0.05) | 0.39 Hz | **14.45 Hz** | 37.1x worse |
| High damping (42Hz, z=0.20) | 2.36 Hz | 19.95 Hz | 8.5x worse |
| Low excitation | 1.14 Hz | 19.01 Hz | 16.7x worse |
| Noisy | 1.42 Hz | 19.89 Hz | 14.0x worse |

**H(f) was worse in 7 out of 7 scenarios.**

### Root cause (theoretical flaw)

The Phase 2 premise was: "jerk(measured_signal) approximates input spectrum F(f)".
This is **mathematically incorrect**.

If `x(t)` is the measured acceleration and the system is LTI with input `f(t)`:
```
x(t) = h(t) * f(t)
X(f) = H(f) * F(f)
```

What we compute for "jerk":
```
jerk(x) = d/dt(x) = d/dt(h * f)
|JERK(f)|^2 = omega^2 * |X(f)|^2
```

So the "H(f) estimate" becomes:
```
|H_est|^2 = |X|^2 / |JERK|^2 = |X|^2 / (omega^2 * |X|^2) = 1 / omega^2
```

Peak of `1/omega^2` is always at the lowest frequency in the search range
(~18.75 Hz), NOT at the structural resonance. This explains why H(f) peaks landed
near 20 Hz regardless of the true resonance (42, 60, 80 Hz).

The only scenario where H(f) was competitive (25 Hz) is precisely because the
true resonance IS near the low-frequency edge where `1/omega^2` bias aligns with
the actual peak.

### What we kept

- **All Phase 2 C++ infrastructure** (dsp.h, main.cpp) — still collects and
  exposes jerk PSD. This is useful raw data for future research/debugging.
- **`computeTransferFunction()` function in shaper.js** — available for
  experimental opt-in via `window._hfMode = true`.
- **Jerk broadness metric** — exposes excitation quality to users regardless.

### Lesson learned

The simulation revealed that the theoretical shortcut (using output jerk as
proxy for input) is fundamentally invalid for LTI systems. To genuinely upgrade
from OMA to EMA, we would need one of:
- Direct measurement of motor-commanded input (hardware change)
- Random Decrement Technique (event-triggered averaging, pure output-only)
- Stochastic Subspace Identification (statistical method, output-only)

None of these are simple drop-in replacements; they require substantial
architectural changes. For now, raw `X(f)` with Lorentzian refinement remains
the best approach.

---

## [FEAT-SIM-01] Accuracy simulation harness `test/sim_accuracy.js`

- **File**: `test/sim_accuracy.js` (~300 lines, Node.js)
- **Type**: Test infrastructure
- **Run**: `node test/sim_accuracy.js`

### What it does

Self-contained Node.js simulation that:
1. Generates synthetic printer commanded motion (random decel events)
2. Drives a 2nd-order mechanical system (Newmark-beta integration) with known
   resonance frequency and damping ratio
3. Adds sensor noise
4. Runs Welch PSD + weighted Welch (mimics `dsp.h::dspFeedDual`)
5. Tests multiple peak detection methods: centroid, parabolic, quad-log, Lorentzian
6. Quantifies accuracy (mean/std error vs ground truth)

### Method comparison findings

| Scenario | Centroid | Parabolic | QuadLog | Lorentzian |
|----------|----------|-----------|---------|------------|
| f=25Hz z=0.10 | 0.651 Hz | 0.679 Hz | 0.801 Hz | 0.833 Hz |
| f=42Hz z=0.10 | 1.147 Hz | 1.243 Hz | 1.178 Hz | **0.746 Hz** |
| f=42Hz z=0.05 | 0.630 Hz | 0.592 Hz | 0.488 Hz | **0.462 Hz** |
| f=42Hz z=0.20 | 2.061 Hz | 1.937 Hz | 1.954 Hz | **1.641 Hz** |
| f=60Hz z=0.10 | 2.037 Hz | 2.195 Hz | 2.202 Hz | **1.463 Hz** |
| f=80Hz z=0.10 | 2.962 Hz | 3.551 Hz | 3.562 Hz | **1.684 Hz** |
| f=100Hz z=0.10 | 4.457 Hz | 4.671 Hz | 4.662 Hz | **3.664 Hz** |

**Lorentzian fitting wins in 6/7 scenarios**, with biggest gains at higher
frequencies (~1.76x better at 80 Hz).

### Conclusion

- Current pipeline (`filter.js::zoomPeakRefine`) already uses a Lorentzian grid
  search - roughly equivalent to the Newton iteration in the simulation.
- No algorithmic changes needed to the peak refinement path right now.
- Simulation file is kept in repo for future regression testing when any DSP
  change is proposed.

### How to use

```bash
node test/sim_accuracy.js                    # run all scenarios
# (~4 seconds on typical laptop)
```

---

---

## [FEAT-SIM-02] Realistic simulation reveals CI miscalibration and multi-mode gap

- **Files**: `test/sim_realistic.js` (+330), `test/sim_realistic_helpers.js` (+250),
  `test/sim_diagnostics.js` (+170), `test/sim_ci_validate.js` (+90), `test/ci_inspect.js` (+30)
- **Type**: Test infrastructure - realistic 3D printer physics simulation

### What it models

| Aspect | Implementation |
|--------|----------------|
| Mechanical system | Multi-mode coupled 2nd-order SDOFs (primary + secondary) |
| Commanded motion | Realistic trapezoidal velocity profiles, random moves |
| Move types | Perimeter (single-axis), travel (diagonal), mixed |
| ADXL345 sensor | 4mg/LSB quantization, 5% cross-axis, 1-pole LP filter, bias |
| Fan vibration | 70Hz + 120Hz fundamental + 2nd/3rd harmonics |
| CoreXY projection | A/B motor combination + angle error rotation |
| Noise sources | Gaussian sensor noise, quantization, drift |

### Baseline simulation results (current pipeline, 10 trials/scenario)

| Scenario | X err | Y err | Max err |
|----------|-------|-------|---------|
| Baseline (clean) | 0.39 Hz | 0.53 Hz | 1.1 Hz |
| + Fan noise (70+120Hz) | 0.53 | 0.82 | 1.6 |
| + Secondary mode (65/72Hz) | 0.84 | 0.17 | 2.5 |
| + Calibration error (5 deg) | 0.60 | 0.57 | 1.4 |
| + Low excitation (10 moves) | 0.67 | 1.32 | 1.8 |
| + ADXL cross-axis (10%) | 0.63 | 0.46 | 1.3 |
| + Perimeter-only | 0.51 | 0.52 | 1.4 |
| **Realistic combined** | **0.74** | **0.31** | **1.7** |
| **Average** | **0.60 Hz** | | |

**Current pipeline already performs at ~0.60 Hz average error**, significantly
better than the 1-2 Hz prediction from earlier analysis. No algorithmic changes
needed for the common case.

---

## [FIX-CI-01] CI formula recalibrated (simulation-driven)

- **Files**: `data/shaper.js::computePeakCI`
- **Type**: Correctness fix

### Problem discovered

The Phase 1-B CI formula `sigma_f = binWidth / (sqrt(SNR) * sqrt(n_eff))`
was derived from the Cramer-Rao Lower Bound but over-reduced sigma via the
`sqrt(n_eff)` term (Welch already averages, so this double-counts).

**Validation test (test/sim_diagnostics.js, 30 trials each):**

| Scenario | Predicted sigma | Actual sigma | Coverage |
|----------|-----------------|--------------|----------|
| Baseline | 0.215 Hz | 0.445 Hz | **37%** (target 95%) |
| Fan noise | 0.214 | 0.662 | **30%** |
| Low excitation | 0.230 | 0.275 | **13%** |

CI was too narrow, giving users false confidence in imprecise measurements.

### v2 attempt (overcorrected)

First recalibration tried `0.15·Δf + 1.5·Δf·relVar + 0.5·Δf/√SNR`. Empirical
measurements of simulation:
- `relVar = sqrt(var)/mean` typical 0.43-0.96 (NOT ~0.1 as expected)
- `SNR = mean / std` typical 1.0-2.3 (NOT ~10-100 as expected)

Result: predicted sigma 5 Hz (10x too wide, 100% coverage but useless).

### v3 (final, validated)

```javascript
sigma_f = 0.15 * binWidth + 0.15 * binWidth * Math.max(0, relVar - 0.5);
```

Empirically chosen constants. Baseline floor `0.47 Hz`, plus variance-dependent
widening when peak variance is high.

**Validation results (50 trials each):**

| Scenario | Predicted | Actual | Ratio | Coverage |
|----------|-----------|--------|-------|----------|
| Baseline | 0.567 | 0.474 | 1.20 | **96%** |
| Fan noise 70Hz | 0.547 | 0.610 | 0.90 | **92%** |
| Fan 70+120Hz | 0.568 | 0.612 | 0.93 | 86% |
| Low excitation | 0.587 | 0.310 | 1.89 | 100% |
| Noisy sensor | 0.556 | 0.565 | 0.98 | **92%** |

Average coverage **93%** (target 95%). Users now get meaningful confidence
intervals for peak frequency.

---

## [FEAT-DEFL-01] Multi-mode deflation peak detection

- **Files**: `data/shaper.js::detectPeaksDeflation` (new, 40 lines),
  `data/app.js` (+20 lines auto-detection)
- **Type**: Accuracy improvement for close-peak scenarios

### Problem discovered

`test/sim_diagnostics.js` multi-mode test revealed secondary peak error of
5-8 Hz when modes are within 8-10 Hz of each other. This is because the
centroid-based peak detection smears nearby peaks together.

### Solution

Iterative deflation:
1. Find strongest peak via existing `detectPeaks()`
2. Fit Lorentzian, subtract from residual PSD
3. Find next peak in residual
4. Repeat up to 4 peaks

### Validation results (10 trials per scenario)

| Scenario | Current (pri/sec err) | Deflation | Secondary gain |
|----------|------------------------|-----------|----------------|
| Close modes (Δ=4Hz) | 0.42 / 3.79 Hz | 0.42 / 3.45 Hz | 1.1x |
| **Moderate gap (Δ=10Hz)** | 0.64 / 8.38 Hz | 0.81 / **2.42 Hz** | **3.5x** |
| Wide gap (Δ=25Hz) | 1.01 / 2.88 Hz | 0.91 / 3.13 Hz | 1.0x |
| **Equal amplitude (Δ=8Hz)** | 0.02 / 5.11 Hz | 0.19 / **1.10 Hz** | **4.6x** |

### Activation

`app.js::fetchAndRenderPsdDual` auto-activates deflation when:
- First two detected peaks are 3-20 Hz apart AND
- Secondary peak power is > 30% of primary

Emits log line `D X-axis deflation applied (N separated peaks)` when triggered.

For wide-gap scenarios (Δ > 20Hz), existing detectPeaks is already sufficient,
so deflation is skipped. For close-mode (Δ < 4Hz), neither method resolves
well — future work.

---

*Last updated: 2026-04-22 by Claude Code (claude-sonnet-4-6)*
*Session branch: main (direct commits per user preference)*
