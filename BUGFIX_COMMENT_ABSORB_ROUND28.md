# Round 28 — Restart-from-scratch Lap 2/3: sampleRate change state propagation gap (2026-04-22)

> **Audience:** Codex / other Claude. Lap 2/3 of the user-requested
> fresh 3-lap chain. R27 established the NVS read-path pattern; this
> round chases runtime-state propagation on sampleRate change.

## Chain link: runtime state propagation (R11 pattern recurrence)

R11 caught `adxlApplySampleRate()` missing from `handlePostConfig`.
This round found two more siblings in the same block that were
silently leaving stale state behind on sampleRate change.

### [BF-R28-001] `dspReset()` (single-axis accumulator) not called on rate change

- **File:** `src/main.cpp` `handlePostConfig` sampleRate-change block.
- **Class:** MEDIUM — stale data leak across rate transitions.
- **Symptom:** `dspResetDual()` was called to wipe the dual-axis
  accumulators, but the single-axis `dspPsdAccum`/`_psdSum`/
  `_segCount`/`dspSegCount` was left untouched. `handleGetPsd` (no
  axis param / default "current") reads `dspPsdAccum[k]`; the bin
  indices of that array refer to the OLD freqRes but the response
  attaches the NEW freqRes in `doc["freqRes"]`. Result: UI renders
  stale peaks at wrong frequencies after any rate change.
  `handleMeasStatus` SNR calc has the same issue (reads `dspPsdAccum`).
- **Fix:** Call `dspReset()` alongside `dspResetDual()` in the
  sampleRate-change block.

### [BF-R28-002] `liveSegReset` not reset, delays next live SSE publish

- **File:** `src/main.cpp` same block.
- **Class:** LOW — live UI responsiveness regression.
- **Symptom:** `liveSegReset` (file-scope `int`) tracks the segTotal
  at which the previous SSE frame was published. On sampleRate
  change `dspResetDual()` zeroes `_dualSegTotal`, but `liveSegReset`
  stayed at its prior value (e.g. 28). The publish gate at
  `loop()` is `segNow - liveSegReset >= cfg.liveSegs`. With
  segNow=1 and liveSegReset=28, the expression is -27 (signed int
  subtraction — no underflow, just negative), which never satisfies
  `>= cfg.liveSegs (=2)` until segNow catches up. Delays the first
  post-rate-change live publish by up to ~28 segments (~2.2 s at
  3200 Hz / DSP_STEP=256).
- **Fix:** `liveSegReset = 0;` alongside the other invalidations.

## Verification

```
python3 scripts/check_brace_balance.py src/main.cpp src/dsp.h
# braces 309/309 [+0], parens 1562/1562 [+0]  OK

g++ -std=c++17 -fsyntax-only -Wall -Wextra -I/tmp/stubs src/main.cpp
# 0 warnings, 0 errors

node test/sim_ci_validate.js
# all 5 scenarios OK / ACCEPT (baseline/fan/fan2/lowexc/noisy)
```

## Running total

**199 bugs fixed** (197 + 2 this round).

## Lap 2/3 observation

Lap 2 found functional bugs where lap 1 (R27) found only diagnostic
consistency items. The chain is not fully exhausted — a particular
pattern ("resource-pair asymmetry" / "runtime state not propagated")
still has undiscovered instances when looking at state variables
owned by `main.cpp` (not wrapped in `dsp*Reset()` helpers).

---

*Co-authored-by: Claude Opus 4.7 (restart-from-scratch lap 2/3)*
