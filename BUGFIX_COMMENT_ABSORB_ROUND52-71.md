# Rounds 52-71 — Second 20-scenario user-flow sweep (2026-04-22)

> **Audience:** Codex / other Claude. User requested a second
> 20-round user-flow sweep. Previous 20-round batch (R32-R51) found
> 1 MEDIUM bug (R40 STA deep sleep). This batch: **0 real bugs**.

## 20 Scenarios audited

| # | Scenario | Result |
|---|---|---|
| R52 | sampleRate=400Hz → 465 bins, chart overflow? | clean — 32KB jbuf + Chart.js autoSkip handle it |
| R53 | Calibration X-only (user skips Y phase) | clean — handlePostConfig line 886-891 rejects partial updates atomically |
| R54 | Measurement with no peak (flat spectrum) | clean — shaper.js:665-666 returns empty-ZV fallback, UI renders gracefully |
| R55 | Very low SNR (<3dB) signal | clean — analyzeShaper always returns safe fallback (peakFreq=40Hz scan) |
| R56 | Two equal-power peaks (dual_balanced) | clean — shaper.js:965/1029/1036 handles; applyCmd emits per-axis directives |
| R57 | resonanceMode === 'unknown' | clean — resonanceMode is always one of {single, dual_dominant, dual_balanced, broad, harmonic}; never 'unknown' |
| R58 | X=ZV, Y=MZV asymmetric recommendation | clean — applyCmd per-axis supported for all firmwares |
| R59 | firmware field change (marlin_is / klipper / rrf) | clean — applyCmd switch covers all 4 firmware types |
| R60 | PSD saturation (>1e6 value) | clean — Lorentzian fit bounds clamp; measureJson prefix check prevents truncation |
| R61 | print_stop → immediate Start Live | clean — dspResetDual sequenced correctly on both transitions |
| R62 | demoMode ON→OFF after measurement | clean — `demoMode` is a pure preference flag with NO runtime branch; demo data always loads and gets overwritten by real PSD. (Explore sub-agent reported this as a bug but the field has no effect on data rendering — verified by grep: no `if (cfg.demoMode)` anywhere.) |
| R63 | Window resize on hidden tab | clean — app.js:54-66 redraws PSDs on tab show |
| R64 | Diagnostic Stage 2 with no measurement | clean — extractFeatures guards against null/undefined |
| R65 | Generate Report during print_start | clean — report.js:12-22 guards on xAnalysis/yAnalysis.recommended.performance |
| R66 | POST body > 8KB | clean — checkBodyLimit on every handlePost* before deserializeJson |
| R67 | Captive portal redirect loop | clean — one-shot 302 to portal root; no re-probe recursion |
| R68 | Negative calWx (sensor flipped) | clean — projection matrix allows negative weights; saved as-is by design |
| R69 | peakFreq=0 → analyzeShaper | clean — line 669-672 guard + 40Hz fallback scan |
| R70 | detectPeaks > MAX_DETECT_PEAKS | clean — MAX_DETECT_PEAKS=8 in filter.js:112, selection loop truncates by power-desc ordering (line 151) |
| R71 | Measurement-save race with settings-save | clean — HTTP single-threaded; sampleRate/minSegs rejected during MEAS_PRINT with 409 |

## 1 Explore-sub-agent-reported bug, verified false positive

**R62 (demoMode toggle does not refetch PSD):** Sub-agent reported
this as a MEDIUM bug. Direct verification showed that `demoMode`
is a NVS-persisted preference with NO runtime branch in either
main.cpp or any data/*.js file — the demo PSD data (xPsdData,
yPsdData) is always generated at load and gets overwritten by
real PSD when a measurement runs or loadResultFromESP restores.
Toggling demoMode has no effect on data rendering.

Verified by:
```
grep -rn 'if.*demoMode\|demoMode.*?' data/ src/
# Only finds: read of cfg.demoMode for UI checkbox state; write of
# cfg.demoMode on form save. No branch anywhere that changes
# client or server behaviour based on the flag.
```

**Verdict:** `demoMode` is effectively dead code — a preference that
does nothing. Could be removed entirely, but not a functional bug.

## Running total

**202 bugs fixed** (no change). Cumulative flow-scan hit rate:

| Batch | Scenarios | Real bugs | Hit rate |
|---|---|---|---|
| R31  |  5 | 1 | 20% |
| R32-R51 | 20 | 1 |  5% |
| R52-R71 | 20 | 0 |  0% |
| **Cumulative** | **45** | **2** | **4.4%** |

The curve has flattened to zero for this batch. Flow-based scanning
has reached the same fixpoint as pattern-based scanning did at R30.
Any future real bugs will likely come from new feature additions
rather than existing-code review.

## Remaining theoretical risk areas (not real bugs)

- **demoMode dead field** — remove or wire up
- **`applyCmd` HTML escape only handles `<`** (R45 note) — escape
  `&`/`"`/`'` for correctness; trusted content today but brittle
- **Kinematic peak-count threshold asymmetry** (kinematics.js:436-440
  — R30 note) — design choice, documented
- **Explore sub-agent false-positive rate**: ~50% in this batch.
  Verifying sub-agent reports against call graphs is essential.

---

*Co-authored-by: Claude Opus 4.7 (second 20-scenario user-flow sweep)*
