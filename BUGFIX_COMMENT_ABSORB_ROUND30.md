# Round 30 — Cross-file untracked-region audit (2026-04-22)

> **Audience:** Codex / other Claude. User asked for an audit of the
> previously-less-scrutinised files. Running Explore sub-agents on
> `data/shaper.js`, `data/kinematics.js`, `data/validator.js`,
> `data/diagnostic.js`, `data/report.js`, `data/i18n.js`, and
> `src/dsp.h` internals.

## Summary: 0 new bugs (11 reports, all false positives on verification)

Sub-agents reported a total of 11 suspected defects across the audited
files. Each was manually verified against call sites and field-
population paths. All 11 were false positives:

| # | Reported | Verification result |
|---|---|---|
| shaper.js:417 | offset180 dt-squared wrong | Physics correct: x = 0.5·a·t² matches `half_accel * dt * dt` |
| shaper.js:588 | R² denominator mismatch at edges | `sliceArr.length` exactly matches loop iterations (both clip the same way at the boundary) |
| shaper.js:827 | Fallback vibrRatio scale mismatch | Dead-branch analysis confirmed no 0-100 vs 0-1 mix |
| kinematics.js:475-476 | `evaluateKinCorrelation` too permissive | First-condition `return` makes second condition implicit `min <= corr <= max` — logic is correct |
| kinematics.js:436-440 | Asymmetric peak-count thresholds | Design choice, not a defect (±2 vs ±1 are deliberate) |
| validator.js:42-43 | `100 - corr*100` wrong formula | Algebraically identical to `(1-corr)*100` |
| validator.js:88-91 | `mainPeak.snr.toFixed(1)` null-unsafe | Only caller is `validateResult` from app.js:285, which always passes detectPeaks output (snr always set) |
| diagnostic.js:72 / report.js:72-75 | `_zoom.damping.toFixed` unguarded | `_zoom` field is never assigned anywhere in the codebase — dead branch |
| diagnostic.js:256 | `p.snr > 10` undefined→'weak' | `_peaks` is set only from detectPeaks output (snr always present) |
| diagnostic.js:318 | `p.harmonicOrder` undefined | filter.js sets `harmonicOrder = 0` default, `harmPeaks` filter requires `isHarmonic === true` which implies `harmonicOrder >= 2` |
| report.js:116 | `getKinProfile(kin).name` crash | Function returns `KIN_PROFILES[kin] || KIN_PROFILES.corexy`; all profiles carry a `name` |
| dsp.h:142,593 | norm=0 division risk | `dspGetSampleRate()` clamped to >0 at setter; `_hannPower` initialised before first `_processSegment` via `dspReset()` in setup() |

## Methodology notes

- Explore agents consistently reported field-access defensiveness gaps
  as "concrete bugs." On this codebase, following the call graph back
  to field-population sites proved that every reported risk was
  blocked by the producers (detectPeaks always sets snr, filter.js
  always sets harmonicOrder, etc.).
- When a "missing null check" is reported, the verification step that
  matters is "can an object reach this site without the field?" not
  "what if the field were undefined?" The latter is too permissive
  and always says yes.
- Dead code in the codebase (`_zoom` assignments exist nowhere) masks
  the surface area of real risk. Worth future cleanup but not a bug.

## Running total

**200 bugs fixed** (no change). R30 is a "verification-only" round —
the third consecutive round (lap 3 R29 and this) to find no functional
defects in the pattern families scanned.

## Final status

After 30 rounds covering absorbed-code, runaway strings, forward refs,
pointer comparison, input validation, runtime state propagation,
buffer sizing, stack safety, long-blocking ops, atomicity, resource-
pair asymmetry, NVS silent-failure, and now cross-file field-access
defensiveness — the chain pattern appears truly exhausted.

Next-round risk areas (not covered this pass):
- Concurrency between `adxlISR` and main loop (currently safe because
  ISR only sets `adxlFifoReady = true`; drain is main-loop side)
- LittleFS write amplification if `handlePostConfig` is called in a
  tight loop (mitigated by 2-minute user-initiated cadence)
- WiFi.setTxPower() return-value check (R29 fix uses it void)

These are theoretical risks with no known trigger — would require a
deliberate adversarial test to provoke.

---

*Co-authored-by: Claude Opus 4.7 (cross-file untracked-region audit)*
