# Round 9 — API Contract Mismatch + DSP Scaling Bugs (2026-04-22)

> **Audience:** Codex / other Claude instances. Round 8 reported the
> codebase was "clean". User insisted on a deeper look. This round
> cross-checked every JSON key the server writes against every key the
> client reads, and walked the DSP accumulator logic. Found five real
> bugs that pass every compiler/linter check.

## Bugs fixed

### [BF-R9-001] `GET /api/psd?mode=print` response missing `peakPower*` / `peak*` / `segs*`

- **File:** `src/main.cpp` `handleGetPsd` print-mode branch
- **Class:** HIGH — user-visible data loss.
- **Symptom:** `data/app.js:264-265` reads `d.peakPowerX` and
  `d.peakPowerY` when building `lastShaperResult`:
  ```js
  x: { primary: { freq: filtPeakX, power: d.peakPowerX || 0 } },
  y: { primary: { freq: filtPeakY, power: d.peakPowerY || 0 } },
  ```
  The server had the values in the module-scope globals
  (`peakPowerX`, `peakPowerY`, set in `handleMeasure` at print_stop)
  but **never put them into the response**. Client silently got
  `power: 0` for both axes.
- **Fix:** emit `peakFreqX`, `peakFreqY`, `peakPowerX`, `peakPowerY`,
  `segsX`, `segsY` into the print-mode response.

### [BF-R9-002] `GET /api/result` never returns `savedAt`

- **File:** `src/main.cpp` `handleLoadResult`
- **Class:** MEDIUM — feature-disabled-silently.
- **Symptom:** `handleSaveResult` writes `prefs.putULong("savedAt", millis())`
  on every save. `data/app.js:593-597` uses that value as a newer-
  wins race guard:
  ```js
  const ts = data.savedAt || 0;
  if (ts > 0 && ts < _lastLoadedResultTs) { /* skip older load */ }
  ```
  But `handleLoadResult` **never reads `savedAt` back** or puts it
  in the response. `ts` was always 0, condition always false, the
  R20.30 race guard was permanently disabled.
- **Fix:** read `prefs.getULong("savedAt", 0)` and add
  `doc["savedAt"] = savedAt;` to the load response (including the
  "no result" early path).

### [BF-R9-003] `dsp.h` accumulator rollover forgets to halve jerk PSD sums

- **File:** `src/dsp.h` line ~632-639
- **Class:** MEDIUM — measurable artefact at long runs.
- **Symptom:** To prevent float overflow, every `DUAL_MAX_TOTAL_SEGS`
  (45000) segments the DSP halves `_dualPsdSumX/Y`, `_dualPsdSqX/Y`,
  and `_dualWeightSum`. The published PSDs use `sumX / weightSum`
  normalisation so halving both keeps the ratio constant.
  However `_dualJerkPsdSumX/Y` were **not** halved. Since the
  published `dspJerkPsdX/Y = _dualJerkPsdSumX/Y / _dualWeightSum`,
  halving only the denominator doubles the published jerk values at
  every rollover. On a ~60-second measurement window this creates
  a 2× step artefact.
- **Fix:** halve the jerk sums alongside the regular PSD sums in
  the same for-loop.

### [BF-R9-004] `filter.js` background subtraction hardcoded to 3.125 Hz/bin

- **File:** `data/filter.js` `filterByBackground`
- **Class:** MEDIUM — wrong PSD data at non-default sample rates.
- **Symptom:** The function maps PSD frequency to `bgPsd` index via
  `Math.round((p.f - filterFreqMin) / 3.125)`. `3.125` is the
  freqRes only at `cfg.sampleRate == 3200`. At other rates
  (feature supports 400-3200):
  |  `sampleRate` | actual freqRes | hardcoded | error |
  |---|---|---|---|
  | 1600 | 1.5625Hz | 3.125Hz | 2× wrong index |
  | 800  | 0.78Hz   | 3.125Hz | 4× wrong index |
  | 400  | 0.39Hz   | 3.125Hz | 8× wrong index |
  Effect: the wrong `bgPsd` bin is subtracted from each PSD point, so
  background noise cancellation quietly misses its target band.
- **Fix:** derive `binRes` from the PSD itself
  (`psd[1].f - psd[0].f`), and compute `bgStartHz` from `psd[0].f`
  rather than the hardcoded `filterFreqMin`.

### [BF-R9-005] Live SSE payload omits bin geometry; client hardcodes 59 bins × 3.125 Hz

- **Files:** `src/main.cpp` (SSE emit), `data/live.js` (SSE parse),
  `data/charts.js` (chart labels)
- **Class:** MEDIUM — chart axis labels wrong at non-3200Hz rates.
- **Symptom:** The live SSE payload was
  `{m, sx, sy, bx[], by[], pkx, pky}`. No freqRes, no binMin. The
  chart module computed labels via `(i+6)*3.125` — both `6` and
  `3.125` are the 3200Hz constants. So X-axis Hz labels on the live
  chart are wrong at every other sample rate.
- **Fix (protocol, additive-only):**
  - Server now emits `"fr":<freqRes>,"bm":<binMin>` in both
    print-mode and live-mode SSE messages.
  - `data/live.js` copies them into `window.liveBinMin` /
    `window.liveFreqRes` on every frame.
  - `data/charts.js` reads those two globals (falls back to `6` /
    `3.125` when they're not set, so behaviour is unchanged for old
    firmware during a hot reload).
  - Also fixed the `_hitMap` loop in `charts.js` that hardcoded
    `i < 59`; it now honours `_hitMap.length`.

## Known limitation NOT fixed (different scope)

`data/live.js:8` has `const DSP_BINS = 59;` and `data/charts.js`
allocates several `new Array(59)` buffers. At sampleRate < 3200 the
server streams **more** bins than 59, and the client clips at the
first 59. This is a pre-existing fixed-buffer design limit that would
require refactoring the live rendering pipeline; not in scope for this
round.

## Verification

```
python3 scripts/check_brace_balance.py src/main.cpp src/dsp.h
# src/main.cpp: braces 259/259 [+0], parens 1433/1433 [+0]  OK
# src/dsp.h:    braces 102/102 [+0], parens  307/307 [+0]  OK

g++ -std=c++17 -c -O2 -Wall -Wextra -I/tmp/stubs -o /tmp/main.o src/main.cpp
# 0 warnings / 0 errors (stubs updated to include getULong)

for f in data/*.js test/*.js; do node --check "$f"; done
# all pass
```

## Running total

151 (after round 8) + 5 = **156** absorbed-code / related bugs fixed.

---

*Co-authored-by: Claude Opus 4.7 (cross-checked server↔client API + DSP walk)*
*Target: `main` (direct push, no PR per user instruction)*
