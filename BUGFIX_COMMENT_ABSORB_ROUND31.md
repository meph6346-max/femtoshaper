# Round 31 — User-flow bug hunt: live chart bin count (2026-04-22)

> **Audience:** Codex / other Claude. User asked for a flow-based
> bug test — walking through "a typical user's usage sequence"
> rather than pattern-based scanning. This surfaced one real bug
> hidden behind sampleRate != 3200.

## Scenarios walked

- A: First boot (NVS empty, no calibration) → main page load
- B: Measurement attempt without calibration → error paths
- C: Measurement → save → reboot → restore
- D: **Live mode + sampleRate change** ← bug found here
- E: Settings changes applied without reboot (R28/R29 re-verified)

## [BF-R31-001] Live-mode bin buffers hard-coded to 59, truncating at lower sample rates

- **Files:** `data/live.js`, `data/charts.js`
- **Class:** MEDIUM — silent loss of the upper half of the 18.75-200Hz
  band whenever sampleRate != 3200.
- **Symptom:** The live chart allocates `liveData`, `liveDataY`,
  `_peakHold`, `_hitMap` as fixed `new Array(59).fill(0)`. That size
  matches the sampleRate=3200 geometry (binMax-binMin+1 = 64-6+1 = 59).
  At lower rates the server correctly streams more bins (117 @1600Hz,
  233 @800Hz, 465 @400Hz), but the client loops ran
  `for (let i = 0; i < binsX.length && i < liveData.length; i++)` so
  only the first 59 bins (low-freq half) made it into the chart. A
  user running at 1600 Hz (common for lower-noise captures) saw the
  live spectrum stop at ~110 Hz, missing anything above that - the
  very frequencies the user might be tuning for. Shaper/print paths
  were unaffected (they use dynamic bin arrays), so this only
  surfaced in live mode.
- **Fix:**
  - New helper `ensureLiveBufSize(n)` in `charts.js` that resizes all
    four live buffers (and drops the Chart.js instance so labels get
    rebuilt) when `n` differs from the current length.
  - `live.js` SSE handler calls `ensureLiveBufSize(binsX.length)` on
    every frame; matched-size is a no-op.
  - `live.js` `ySmoothed` allocation changed from `new Array(59)` to
    `new Array(liveData.length)`.
  - `charts.js` drawLiveFrame's `for (let i=0; i<59; i++)` loop
    changed to `i < liveData.length`.
- **Side effect:** On sampleRate change, the first frame after the
  R28 dual-reset will trigger a size change, causing a brief chart
  flash as the instance rebuilds. Acceptable since it's a ≤500 ms
  boundary that only happens on explicit user rate change.

## Other scenarios — no new bugs

- **A:** `loadBgPsd` retries up to 3 times with 3 s gap; filter.js
  handles null bgPsd as "no subtraction." OK.
- **B:** Client pre-checks `useCalWeights` via `/api/config` before
  POST, then falls back to server's `calibration_required` error.
  Double-layered. OK.
- **C:** `loadResultFromESP` falls back from `/api/psd?mode=print` to
  `/api/psd` with single-axis fan-out (X=Y). Fallback triggers a
  visible log line. OK.
- **E:** R28 / R29 fixes verified by re-reading the sampleRate /
  txPower branches — both now apply at runtime without reboot.

## Verification

```
for f in data/*.js; do node --check "$f"; done  # all pass
node test/sim_ci_validate.js                     # all scenarios OK
python3 scripts/check_brace_balance.py src/main.cpp src/dsp.h
# No C++ changes this round.
```

## Running total

**201 bugs fixed** (200 + 1 this round).

## Methodology note

Pattern-based scanning rounds (R27-R30) were hitting diminishing
returns (many false positives, few real bugs). Flow-based scanning
(this round) found a MEDIUM bug that pattern scanning had missed,
because the defect only exhibits under a specific runtime condition
(sampleRate change) that static pattern scans don't exercise.
Consider a "user story" pass the primary driver going forward.

---

*Co-authored-by: Claude Opus 4.7 (user-flow bug hunt)*
