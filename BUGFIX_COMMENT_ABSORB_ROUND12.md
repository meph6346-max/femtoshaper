# Round 12 — Numerical Edge Cases + Config Validation Gaps (2026-04-22)

> **Audience:** Codex / other Claude instances. Round 11 found a CRITICAL
> runtime-state mismatch. Round 12 dug into DSP/shaper math edges and
> config validation gaps. Six more bugs.

## Bugs fixed

### [BF-R12-001] `fitLorentzian` R² overestimated at PSD edges

- **File:** `data/shaper.js` `fitLorentzian`
- **Class:** MEDIUM — silent quality-metric error that could let a poor
  Lorentzian fit pass the `rSquared < 0.5` acceptance threshold.
- **Symptom:** The mean for R² used `sliceArr.reduce(...) / (2*fitRange+1)`.
  When `peakIdx` sat near index 0 or `psd.length-1`, `Array.slice` truncated
  so the slice had **fewer** than `2*fitRange+1` elements, but the
  denominator was still the full `2*fitRange+1`. This under-estimated
  `meanV`, inflated `ssTot`, and therefore inflated
  `rSquared = 1 - ssRes/ssTot`.
- **Fix:** divide by `sliceArr.length`, with a zero-length guard.

### [BF-R12-002] `/api/config` did not validate `scv`

- **File:** `src/main.cpp` `handlePostConfig`
- **Class:** MEDIUM — garbage in, garbage through the entire shaper chain.
- **Symptom:** `cfg.scv = doc["scv"].as<float>()` accepted any value,
  including 0, negative, NaN, Infinity. Downstream `calcSmoothing` uses
  `scv + halfAccel * dt` and could produce negative smoothing offsets.
  `calcMaxAccel` bisects over smoothing and would either return 0
  immediately or fail to converge.
- **Fix:** accept only finite values in `(0, 1000]`; reject others silently
  (leave previous value in place).

### [BF-R12-003] `/api/config` did not validate `damping` or `targetSm`

- **File:** same handler
- **Class:** MEDIUM — same shape as BF-R12-002.
- **Symptom:** `damping >= 1` causes `sqrt(1 - damping²)` in
  `estimateShaperResponse` to return NaN, which then poisons every shaper
  score. `targetSm <= 0` makes `calcMaxAccel` return 0 early.
- **Fix:** accept damping only in `(0, 1)`, targetSm only in `(0, 1)`.
  Silent reject (safer than an error - UI validation already rejects bad
  values; API is just a belt-and-suspenders layer).

### [BF-R12-004] `/api/config` did not snap `txPower` to a supported level

- **File:** same handler
- **Class:** LOW — NVS-vs-hardware drift, same *shape* as BF-R10-006 but
  for TX power.
- **Symptom:** ESP32-C3 supports only `{2, 5, 8, 11, 15, 20}` dBm as
  `WIFI_POWER_*` enums. The setup-time switch falls back to 8.5 dBm on any
  non-matching value, so posting `txPower=12` leaves `cfg.txPower = 12`
  forever while the radio actually operates at 8.5 dBm. User's `GET
  /api/config` shows "12 dBm" but the radio is not at that power.
- **Fix:** snap to nearest supported value on POST. Matches the sampleRate
  snap logic added in round 10.

### [BF-R12-005] `/api/config` did not snap `powerHz` either

- **File:** same handler
- **Class:** LOW — stored but never acted on currently, but keeping a bogus
  value in NVS is still wrong.
- **Fix:** snap to `{0, 50, 60}` (off / 50-Hz mains / 60-Hz mains).

### [BF-R12-006] `loadConfig` did not sanity-check NVS-loaded shaper params / txPower / powerHz

- **File:** `src/main.cpp` `loadConfig`
- **Class:** MEDIUM — NVS bit-flip or stale pre-validator writes could
  inject `scv=0`, `damping=1.5`, `txPower=12`, etc. directly at boot,
  completely bypassing the POST validators added in BF-R12-002/3/4/5.
- **Fix:** after `prefs.getFloat/getInt` and the existing sampleRate
  snap, apply the same sanity clamps and snap loops. Any corrupted value
  gets replaced with a safe default before `dspSetSampleRate` or the
  WiFi setup consumes it.

## Verification

```
python3 scripts/check_brace_balance.py src/main.cpp src/dsp.h
# src/main.cpp: braces 291/291 [+0], parens 1507/1507 [+0]  OK
# src/dsp.h:    braces 102/102 [+0], parens  318/318 [+0]  OK

g++ -std=c++17 -c -O2 -Wall -Wextra -I/tmp/stubs -o /tmp/main.o src/main.cpp
# 0 warnings, 0 errors

node --check data/*.js test/*.js
# all pass
```

## Running total

168 (after round 11) + 6 = **174** absorbed-code / related / accuracy /
validation bugs fixed.

## Methodology note

This round's approach: every `doc["X"].as<float>()` / `.as<int>()` without
a subsequent bounds check is a potential silent-corruption vector. Found
by grepping for `doc\["[^"]+"\].as<(float|int)>` and reading the two lines
after each match. Recommend future sweeps to apply this pattern to any
new POST handlers.

---

*Co-authored-by: Claude Opus 4.7 (numerical edge + validation audit)*
*Target: `main` (direct push, no PR per user instruction)*
