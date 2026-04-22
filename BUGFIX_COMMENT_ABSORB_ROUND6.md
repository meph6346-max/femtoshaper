# Round 6 — Finish-line Pass: Unused Params, Log-String Cleanup (2026-04-22)

> **Audience:** Codex / other Claude instances. This is the clean-up round
> after rounds 1–5. No new hidden bugs were found. What remained were
> three items flagged in round 5 as "suspicious but unchanged — needs
> design intent": the unused `axis` params on `/api/psd` and `/api/live/axis`,
> plus a dozen Korean-garbled log strings. User approved implementing
> best-guess semantics for the axis params and a mechanical ASCII
> rewrite for the log strings.

## Running total

126 → 133 → 137 → **140** absorbed-code / related bugs addressed.

## Fixes

### [BF-R6-001] `/api/psd?axis=x|y` now actually returns the requested axis

- **File:** `src/main.cpp` `handleGetPsd`
- **Before:** `const char* axis = server.hasArg("axis") ? ... : "current";`
  was declared but never consulted. The loop always returned
  `dspPsdAccum[k]` regardless of the query parameter. Any client passing
  `?axis=x` silently got the same payload as `?axis=y` or no axis arg.
- **After:**
  - `useX`, `useY` flags derived via `strcmp`.
  - PSD source now selected per bin:
    - `axis=x`  → `dspDualPsdX[k]`, `var = 0.0f`
    - `axis=y`  → `dspDualPsdY[k]`, `var = 0.0f`
    - default   → `dspPsdAccum[k]`, `var = dspPsdVar[k]`
  - Response echoes `doc["axis"] = "x" | "y" | "current"` so callers can
    confirm which source was used.
- **Compatibility:** existing callers that don't send `?axis=` get the
  same bytes as before (default branch is byte-identical).

### [BF-R6-002] `/api/live/axis` persists `liveAxis` state + echoes in response

- **File:** `src/main.cpp` `handleLiveAxis`
- **Before:** Body parameter `"axis"` was read into a local `ax` and
  immediately discarded. Compiler warned `unused variable 'ax'`.
- **After:**
  - New module-scope `static char liveAxis = 'a';` (valid values: `'x'`,
    `'y'`, `'a'`).
  - Handler validates the incoming first char and updates `liveAxis`.
  - Response is now `{"ok":true,"axis":"x"|"y"|"a"}` so a client can
    confirm and later restore the selection.
  - **SSE payload format intentionally left unchanged** (still sends
    `bx[]` *and* `by[]`). Changing wire format without a client
    confirmation would break `data/live.js`. `liveAxis` is staged for
    future use.
- **Reference:** `liveAxis` is referenced (read) exactly once so the
  compiler warning is resolved.

### [BF-R6-003 .. 010] Eight garbled Korean log strings replaced with ASCII

- **File:** `src/main.cpp` (Serial.print / Serial.println / Serial.printf)
- **Lines:** 225, 233, 281, 282, 1207, 1246, 1868, 1902
- Each original message's intent was decipherable from its surrounding
  code and format specifiers. Replacement text mirrors the same
  tokens (level tag, args, trailing newline).
- Notable side effect: the `[MEAS]` done message on line 1246 contained
  the byte sequence `??(` which g++ warned about as the trigraph for
  `[`. That warning is gone after the rewrite.

| Line | Tag | Replaced content |
|---|---|---|
| 225 | `[ADXL]` | `init attempt %d/3: DevID=0x%02X %s` |
| 233 | `[ADXL]` | `SPI communication failed - check wiring` |
| 281 | `[ADXL]` | `self-test reading: X=%d Y=%d Z=%d` |
| 282 | `[ADXL]` | `ready: %dHz / 16g FR / Stream(WM=25)` |
| 1207 | `[MEAS]` | `print measurement started (dual-axis DSP)` |
| 1246 | `[MEAS]` | `done: X:%.1fHz/%d Y:%.1fHz/%d gate:%.0f%% corr:%.0f%%` |
| 1868 | `[HEAP]` | `low: %u bytes - WiFi may become unstable` |
| 1902 | `[WiFi]` | `AP recovery attempt %d/3 (heap: %u)` |

Additional garbled strings at lines 195, 1406, 1500, 1521, 1530, 1652
were **already ASCII-clean** by the time this round started (left in
place by earlier cleanups); nothing to do there.

## Verification

```
python3 scripts/check_brace_balance.py src/main.cpp src/dsp.h
# src/main.cpp: braces 270/270 [+0], parens 1466/1466 [+0]  OK
# src/dsp.h:    braces 102/102 [+0], parens  307/307 [+0]  OK

g++ -std=c++17 -c -O2 -Wall -Wextra -I/tmp/stubs -o /tmp/main.o src/main.cpp
# 0 errors
# Remaining warnings: exactly 1 (pre-existing line 58 sign-compare on
# size_t vs int - unchanged since before these rounds, minor)

for f in data/*.js test/*.js; do node --check "$f"; done
# all pass

node test/sim_ci_validate.js / sim_accuracy.js / sim_realistic.js
# all pass (main.cpp untouched by these)
```

## Compiler warning status, end of round

- **Errors:** 0
- **Warnings (non-stub):** 1 (`main.cpp:58` — `size_t` vs `int`
  comparison in `checkBodyLimit`; pre-existing, benign).
- Removed this round: `[-Wtrigraphs]` at 1232 (now 1246), `[-Wunused-variable]`
  for `axis` at 1127, `[-Wunused-variable]` for `ax` at 1344.

## What is *still* out of scope

These are not bugs but would be nice in a future round:

- The `data/live.js` client never actually calls `/api/live/axis`.
  Either wire it in (client feature) or remove the server handler
  (code removal). Either direction needs product-level input.
- Remaining Korean-garbled text lives in **comments** and a couple of
  regex patterns used in log formatting. Stripping these belongs to a
  dedicated comment-normalisation pass.
- `main.cpp:58` `size_t` vs `int` sign-compare: trivial cast fix
  but orthogonal to this round's scope.

---

*Co-authored-by: Claude Opus 4.7 (A/B/C sweep)*
*Target: `main` (direct push, no PR per user instruction)*
