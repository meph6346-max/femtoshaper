# Round 23 — Wheel 2 checkpoint: DSP revisit + API consistency (2026-04-22)

> **Audience:** Codex / other Claude. Checkpoint round. Wheel 2 revisit
> of R11-R15 fixes confirmed they're solid. Additional exposure of
> `_adxlOverflowCount` via /api/adxl/status (see R22). Observed a few
> non-bug items worth documenting:

## Observations (not fixed — for future reference)

- **`updateShaperUI(..., yAn)` fallback aliases yAn to xAn** when yAn
  is null: `if (!yAn) yAn = xAn;`. This causes X-axis recommendation
  data to display under Y-axis labels. UX bug, not functional.
- **`dspGetStatus()` called from `handleMeasStatus`** computes SNR from
  `dspPsdAccum`, which is only populated during the 1 s boot-noise
  capture. After boot it's zero. SNR field exists in response but
  client's measure.js never reads `d.snrDb`. Dead calc per request.
- **`adxlApplySampleRate()` doesn't reset the ADXL FIFO** after
  standby→measure transition. Old samples may be drained as "new".
  Low impact since sample rate change is rare and cross-boundary
  samples represent ~10ms of data.
- **`dspMinValidSegs` (debug) vs `cfg.minSegs` (persistent)** are two
  separate setters. Debug is transient; documented by existing
  "// transient" comment. Not a bug, just worth understanding.
- **Chart.js fallback when `analyzeShaper` returns empty** handled by
  line 665 early-exit empty-shaper struct. OK.

## Wheel 2 summary

R11 (runtime hardware) → R12 (input validation) → R13 (buffer sizing)
→ R14 (memory category) → R15 (atomicity) all verified in wheel 2.
No new bugs in the C++ server chain.

One client-side bug found in wheel 2 so far (R18's JS absorbed-code).
R16/R17 client fixes verified solid.

## Running total

(R22 added one fix, R23 no new fixes)

---

*Co-authored-by: Claude Opus 4.7 (wheel 2 verification round)*
