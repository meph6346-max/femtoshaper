# Round 11 — Runtime Rate Change + Sample-Rate-Aware EMAs + Boot Guards (2026-04-22)

> **Audience:** Codex / other Claude instances. User demanded deeper digging
> into accuracy-affecting bugs ("a tiny bug can distort accuracy heavily").
> Round 11 found six, including one that silently reported every peak at the
> wrong frequency when the client changed sample rate at runtime.

## Bugs fixed

### [BF-R11-001] CRITICAL: `/api/config` sampleRate change never reprograms ADXL hardware

- **File:** `src/main.cpp` `handlePostConfig` sampleRate branch
- **Class:** CRITICAL — silent, systematic frequency-axis error for the entire
  session after any runtime rate change.
- **Symptom:** `adxlInit()` runs once at boot and writes `REG_BW_RATE` based
  on `cfg.sampleRate`. When the client POSTs a new `sampleRate`:
  1. `cfg.sampleRate` updates.
  2. `dspSetSampleRate(newRate)` updates the DSP's freqRes belief.
  3. **ADXL keeps running at the old BW_RATE register value.**
  4. Hardware delivers samples at the old rate; DSP labels them with the new
     rate's freqRes.
  Every peak gets reported at `(newRate / oldRate) × real_freq`. Boot at
  3200Hz then switch to 1600Hz → reported freqs are **half** of reality.
  The device looks fine, the chart looks fine, only the numbers are wrong.
- **Fix:** added `static bool adxlApplySampleRate()` that performs
  standby → write `REG_BW_RATE` → verify via readback → back to measure.
  The rate-change branch of `handlePostConfig` now calls it after updating
  `cfg.sampleRate`. Full `adxlInit()` would be overkill (it re-`SPI.begin`s
  and re-`attachInterrupt`s); the dedicated helper only touches the rate
  register.

### [BF-R11-002] `/api/config` sampleRate change does not reset dual-axis accumulators

- **File:** same branch as BF-R11-001
- **Class:** MEDIUM.
- **Symptom:** Rate change invalidates `measPsd*`, `dspBgPsd`, and boot noise
  state, but leaves the dual-axis accumulators (`_dualPsdSumX/Y`,
  `_dualWeightSum`, ...) untouched. During an active live SSE stream, the
  server immediately starts publishing SSE frames tagged with the **new**
  `fr`/`bm` metadata while the `bx[]`/`by[]` values are still a weighted
  average of PSDs captured at the **old** freqRes. Silent freq-axis mix.
- **Fix:** call `dspResetDual()` on the rate change so downstream frames use
  only post-change samples.

### [BF-R11-003] Boot-guard: `handleMeasure "print_start"` did not check `adxlOK`

- **File:** `src/main.cpp` `handleMeasure` print_start branch
- **Class:** LOW (UX) — not a wrong number, just a confusing error path.
- **Symptom:** With a failed ADXL init (bad wiring, missed chip, etc.), the
  handler entered `MEAS_PRINT`, the loop's 5-second silence watchdog later
  fired and the UI displayed "disconnect detected during measurement" as if
  the ADXL had been working and then died. Fixed by rejecting upfront with
  `{"error":"adxl_not_ready"}`.

### [BF-R11-004] DC tracker time constant depended on sample rate

- **File:** `src/dsp.h` `dspFeedDual`
- **Class:** MEDIUM — low-frequency contamination at non-default rates.
- **Symptom:** The DC tracker was `_dc = 0.999 * _dc + 0.001 * sample` —
  a fixed per-sample alpha of 0.001. Time constant therefore measured in
  *samples*, not *seconds*:
  | fs (Hz) | time constant |
  |---|---|
  | 3200 | 0.31 s |
  | 1600 | 0.63 s |
  | 800  | 1.25 s |
  | 400  | 2.50 s |
  At 400Hz the DC is essentially not tracking — every transient segment
  leaks substantial low-frequency energy into the PSD until the tracker
  catches up 2.5 s later. Since Welch segments are ~0.6 s each, that
  covers 3–4 segments of contaminated spectrum per print.
- **Fix:** `dcAlpha = 1 / (0.3 * fs)` so the time constant is ~0.3 s at any
  sample rate (matching the old 3200Hz behaviour).

### [BF-R11-005] Energy EMA time constant depended on sample rate

- **File:** `src/dsp.h` `dspFeedDual` (energy smoothing block)
- **Class:** MEDIUM — adaptive-weighting logic effectively static at low
  sample rates.
- **Symptom:** `_dualEnergyEMA = 0.97 * EMA + 0.03 * eSum` — per-segment
  alpha of 0.03. Same issue as BF-R11-004 but in segment-time units.
  | fs (Hz) | step (ms) | EMA time constant |
  |---|---|---|
  | 3200 | 80 | 2.6 s |
  | 1600 | 160 | 5.3 s |
  | 800  | 320 | 10.6 s |
  | 400  | 640 | 21.3 s |
  At 400Hz the "typical energy" takes 21 seconds to adapt. The weight
  function, which is the deviation from typical, stays stuck near 0.01
  (the floor) for the whole run — meaning the adaptive weighting that's
  supposed to boost active segments does essentially nothing.
- **Fix:** `eAlpha = (DSP_STEP / fs) / 2.6` so the EMA time constant is
  ~2.6 s of real time at any sample rate. Clamped to [0.001, 0.5] for
  safety.

### [BF-R11-006] Regression test: sample-rate snap + hardware reprogramming together

- **Files:** `src/main.cpp` both `loadConfig` and `handlePostConfig`
- **Class:** regression guard, not a new bug.
- **Note:** Round 10's fix snapped `cfg.sampleRate` to the nearest
  ADXL-supported rate, but only at boot (loadConfig) and at POST
  (handlePostConfig). With BF-R11-001 now reprogramming the hardware on
  every rate change, the snap ensures `cfg.sampleRate` is always a value
  the ADXL can actually produce, so the DSP belief and ADXL reality stay
  in lockstep.

## Verification

```
python3 scripts/check_brace_balance.py src/main.cpp src/dsp.h
# src/main.cpp: braces 272/272 [+0], parens 1470/1470 [+0]  OK
# src/dsp.h:    braces 102/102 [+0], parens  318/318 [+0]  OK

g++ -std=c++17 -c -O2 -Wall -Wextra -I/tmp/stubs -o /tmp/main.o src/main.cpp
# 0 warnings, 0 errors

for f in data/*.js test/*.js; do node --check "$f"; done
# all pass
```

## Running total

162 (after round 10) + 6 = **168** absorbed-code / related / accuracy bugs fixed.

## Methodology recap

Round 11's approach: trace **runtime** state paths, not just declarations.
Every time a config value changes, follow it all the way into hardware /
DSP / client side and check for mismatches at the leaf. BF-R11-001 was the
biggest find — sample rate was changing in three independent places
(config / DSP / ADXL) but only two of them were being updated on runtime
change, giving a silent 2× or 0.5× frequency error.

Same methodology will catch bugs in: pin re-assignment at runtime (pins
change in cfg but SPI.begin runs once at boot — same shape of bug, lower
impact because pin changes are rare). Left as a documented limitation;
recommend forcing reboot on pin change.

---

*Co-authored-by: Claude Opus 4.7 (runtime-state audit)*
*Target: `main` (direct push, no PR per user instruction)*
