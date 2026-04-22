# Round 8 — Logic Bugs Beyond Static Analysis (2026-04-22)

> **Audience:** Codex / other Claude instances. Rounds 1-7 drove the
> compiler to zero warnings. Round 8 is manual code review for logic
> bugs that a syntax checker cannot catch: wrong constants, dead code,
> missing validation, and leftover log-format glitches.

## Fixes this round

### [BF-R8-001] `/api/belt` endpoints + `femto_belt` NVS dead code

- **File:** `src/main.cpp` (removed three things, ~20 lines)
- **Class:** dead code — the `belt-tension` feature was retired in an
  earlier round but the server-side artefacts were never cleaned up.
  No code in `data/*.js` calls `POST /api/belt` or `GET /api/belt`;
  `grep -rn "/api/belt" data docs` returns nothing.
- **Removed:**
  - `void handleSaveBelt()` handler
  - `void handleLoadBelt()` handler
  - Two route registrations for `/api/belt` (HTTP_GET + HTTP_POST)
- **Side effect:** The `femto_belt` NVS namespace is no longer
  written. Existing data in that namespace on a device's flash stays
  there harmlessly until a factory reset clears it.

### [BF-R8-002] Orphan `adxl_test.js` registration comment

- **File:** `src/main.cpp:1559` (pre-fix)
- **Class:** misleading comment. Round 7 incorrectly guessed that the
  comment referred to a `/api/adxl_test` endpoint. There's no such
  endpoint; the `/adxl_test.js` static-file route was already removed
  in an earlier pass. Stale comment removed.

### [BF-R8-003] `handleAdxlRate` validates against hardcoded 3200 Hz

- **File:** `src/main.cpp` `handleAdxlRate`
- **Class:** HIGH — user-visible false negative.
- **Symptom:** The handler reports `ok: true` only when the measured
  ADXL sample rate is in 2800–3400 Hz. That's hardcoded, so **any
  non-default `cfg.sampleRate`** (the setting supports 400–3200 Hz)
  will always fall outside the range and the UI will permanently
  show "sensor rate NOT OK".
- **Fix:** derive the window from `cfg.sampleRate` with a ±8 %
  tolerance, and include `target` in the JSON response so the UI can
  show both values:
  ```cpp
  const float targetHz = (float)cfg.sampleRate;
  const float lo = targetHz * 0.92f;
  const float hi = targetHz * 1.08f;
  ...
  doc["target"] = targetHz;
  doc["ok"] = (adxlRateHz > lo && adxlRateHz < hi);
  ```

### [BF-R8-004] `handlePostConfig` accepts calWx without calWy

- **File:** `src/main.cpp` `handlePostConfig`
- **Class:** MEDIUM — logic bug that could corrupt calibration.
- **Symptom:** The inbound check only validated `doc["calWx"]`. If
  the client sent only `calWx` (but not `calWy`) or sent a
  wrong-shaped `calWy`, the code would:
  1. Read `doc["calWy"][0..2]` as floats (likely zeros)
  2. Set `cfg.useCalWeights = true`
  3. Persist zero-vector Y weights
  Result: subsequent measurements would compute
  `projY = 0*ax + 0*ay + 0*az = 0`, destroying the Y-axis data.
- **Fix:** require both arrays to be well-formed before accepting:
  ```cpp
  if (doc["calWx"].is<JsonArray>() && doc["calWx"].size() == 3 &&
      doc["calWy"].is<JsonArray>() && doc["calWy"].size() == 3) {
      // ... apply both
  }
  ```

### [BF-R8-005] `handleDebugPost` missing `checkBodyLimit`

- **File:** `src/main.cpp` `handleDebugPost`
- **Class:** MEDIUM — DoS protection gap.
- **Symptom:** Every other POST handler (`handlePostConfig`,
  `handleLed`, `handleSaveResult`, `handleSaveDiag`, `handleMeasure`)
  calls `checkBodyLimit(8192)` per R25. `handleDebugPost` was the
  only one that didn't. A malicious client could send an arbitrarily
  large body to `/api/debug` and bypass the DoS guard.
- **Fix:** add the call + proper JSON error response on parse failure.

### [BF-R8-006] `handleMeasure "stop"` comment said "reset"

- **File:** `src/main.cpp` `handleMeasure` stop branch
- **Class:** LOW — documentation accuracy.
- **Symptom:** My round-7 comment said "Reset command: clear all
  measurement state" but the branch actually transitions to
  `MEAS_DONE` (not IDLE) and snapshots peaks. The "reset" semantics
  belong to the `else` branch. Corrected the comment.

### [BF-R8-007] `adxlLatest()` dead utility function

- **File:** `src/main.cpp:335-338` (pre-fix)
- **Class:** dead code.
- **Symptom:** `static AdxlSample adxlLatest()` is defined but never
  called. `-O2` surfaced it via `-Wunused-function`. Removed.
- **Note:** This was the last `-Wall -Wextra -O2` warning. After this
  round, `main.cpp` compiles with zero warnings at every standard
  optimisation level.

### [BF-R8-008] Five `Serial` log messages had literal `??` instead of `->`

- **File:** `src/main.cpp` lines 1385, 1458, 1693, 1698, 1704, 1936
- **Class:** log readability / character-encoding artefact.
- **Symptom:** Korean arrow characters (`→` / U+2192, three UTF-8 bytes)
  collapsed to `??` in an earlier round-trip. These sat inside string
  literals (so prior rounds that cleaned `//` comments missed them).
  Example pre-fix:
  ```
  "[BOOT] bgPsd inconsistent (ratio=%.2f) ??NVS fallback"
  "[SLEEP] 5min idle ??deep sleep (press reset to wake)"
  ```
- **Fix:** each `??` replaced with `->`. One place (`[WAKE]`) had five
  question marks in a row; given there was no obvious arrow there,
  rewrote the message as `"[WAKE] cause: %d"`.

### [BF-R8-009] Stale trailing `?` on `R27.1` comment

- **File:** `src/main.cpp:1338` (was)
- **Class:** cosmetic leftover from round 7's comment pass.
- **Fix:** `// R27.1: 3s send timeout - stuck client ?` →
  `// R27.1: 3s send timeout so a stuck client cannot block the loop`

## Verification

```
python3 scripts/check_brace_balance.py src/main.cpp src/dsp.h
# src/main.cpp: braces 259/259 [+0], parens 1428/1428 [+0]  OK
# src/dsp.h:    braces 102/102 [+0], parens  307/307 [+0]  OK

g++ -std=c++17 -fsyntax-only -Wall -Wextra -I/tmp/stubs src/main.cpp
# 0 lines of output

g++ -std=c++17 -c -O2 -Wall -Wextra -I/tmp/stubs -o /tmp/main.o src/main.cpp
# 0 lines of output (all prior warnings including -Wunused-function gone)

for f in data/*.js test/*.js; do node --check "$f"; done
# all pass

node test/sim_{accuracy,ci_validate,realistic}.js
# all pass
```

## End-state

- `main.cpp`: 0 compiler warnings at `-O2 -Wall -Wextra` with stubs.
  (Ignoring `-Wconversion` which triggers dozens of benign int→float
  narrowing warnings in DSP math — not noise worth suppressing per-site.)
- No dead handlers, no dead endpoints, no dead static helpers remain.
- Every comment in `main.cpp` and `dsp.h` is English-readable.
- Every `Serial.print*` format string is pure ASCII with working arrows.
- All POST handlers enforce the same body-size limit.

## Running total

143 (after round 7) + 8 = **151** absorbed-code / related bugs fixed.

## What's genuinely left

- `data/*.js` UI emoji (✓, ✗, ▓, 🔒) — intentional.
- `test/*.js` Korean research notes (30 comment lines) — not
  production code.
- `dsp.h` contains many `int -> float` conversion warnings at
  `-Wconversion`. All benign (bin indices, segment counts, etc.).
  Suppressing them individually would bloat the source without
  value; skipping `-Wconversion` is standard for embedded DSP code.

---

*Co-authored-by: Claude Opus 4.7 (manual logic review after compiler was silent)*
*Target: `main` (direct push, no PR per user instruction)*
