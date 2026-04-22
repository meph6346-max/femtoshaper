# Round 15 — Long-blocking operations + partial-apply POSTs (2026-04-22)

> **Audience:** Codex / other Claude instances. User said "chase the
> chain, go round the loop, then dig the same spot again". Round 14
> found stack overflow risk. Round 15 followed the chain to other
> main-loop blockers and atomic-write expectations.

## Bugs fixed

### [BF-R15-001] `WiFi.scanNetworks` blocks loop for up to 3.3 s during active measurement

- **File:** `src/main.cpp` `handleWifiScan`
- **Class:** MEDIUM — silent measurement data-quality loss.
- **Symptom:** `WiFi.scanNetworks(false, false, false, 300)` does a
  300 ms scan per channel × 11 channels = up to 3.3 s of blocked
  main loop. During that window:
  - ADXL hardware FIFO holds only 32 samples = 10 ms at 3200 Hz.
  - Overflow counter ticks up every 10 ms for 3.3 s.
  - The DSP gets a 3.3-second gap in its segment stream.
  If a user hits the WiFi-scan button in settings during an active
  measurement run (easy to do — no UI lockout), the measurement
  silently loses ~40 segments of continuity.
- **Fix:** reject with HTTP 409 +
  `{"error":"scan_blocked_during_measurement"}` when
  `measState == MEAS_PRINT`. UI can surface the error or gray out the
  scan button.

### [BF-R15-002] WiFi recovery paths `delay()` ~300–900 ms during active measurement

- **File:** `src/main.cpp` 30-s AP watchdog block
- **Class:** MEDIUM — same shape as BF-R15-001.
- **Symptom:** The 30-s watchdog has two recovery paths:
  - STA → AP fallback: `delay(100)` + `WiFi.mode(WIFI_AP)` + `delay(200)`
  - AP reinit (stage 2): `delay(500) + delay(200) + delay(200)`
  Both totalling 300-900 ms of blocked loop. If WiFi glitches once
  during a 30 s measurement run, the watchdog fires and blocks mid-run.
- **Fix:** skip these blocking recovery paths when
  `measState == MEAS_PRINT`, logging "deferred" and retrying on the
  next watchdog tick after the measurement ends. Non-blocking
  `WiFi.reconnect()` is still allowed (no delay).

### [BF-R15-003] `handlePostConfig` partial-apply on pin conflict

- **File:** `src/main.cpp` `handlePostConfig`
- **Class:** MEDIUM — data-loss on user typo.
- **Symptom:** The pin-conflict check sat at line 875 (line numbers
  post-fix), AFTER sampleRate change processing (line 781+). If a
  user POSTed with a new sampleRate *and* a bad pin combination, the
  handler:
  1. Cleared measPsdValid + dspBgPsd + all dsp arrays
  2. Called dspResetDual() — wipes live accumulators
  3. Called adxlApplySampleRate() — reprograms hardware
  4. Reached the pin-conflict check, returned 400 without saveConfig()
  So the request "failed" but the side effects were already applied:
  the user's stored measurement snapshot was wiped, the running live
  chart was reset, the ADXL was reconfigured. User sees a 400 error
  AND has lost their prior measurement in one shot.
- **Fix:** moved the pin-conflict validation to the TOP of
  `handlePostConfig`, before any cfg mutation. Uses a staging array
  that only reads from `doc` (and falls back to current cfg values for
  missing fields). Duplicate detection runs on that staging array and
  rejects with 400 *before* any side effect fires. The later
  equivalent check still runs as a redundant safety net but will
  always pass (values came from the same source).

## Verification

```
python3 scripts/check_brace_balance.py src/main.cpp src/dsp.h
# src/main.cpp: braces 295/295 [+0], parens 1517/1517 [+0]  OK
# src/dsp.h:    braces 102/102 [+0], parens  318/318 [+0]  OK

g++ -std=c++17 -c -O2 -Wall -Wextra -I/tmp/stubs -o /tmp/main.o src/main.cpp
# 0 warnings, 0 errors

node --check data/*.js test/*.js
# all pass
```

## Running total

179 (after round 14) + 3 = **182** bugs fixed across all rounds.

## Chain pattern update

Rounds 10-15 trace a consistent pattern:
1. **Accept a value** (bump buffer, change state, apply config).
2. **Chain 1 (R11):** does the *hardware* see it?
3. **Chain 2 (R12):** does the value have a *bound-checked* input?
4. **Chain 3 (R13):** does the *response path* have a big-enough buffer?
5. **Chain 4 (R14):** does the big buffer fit in the *memory category*
   we chose (stack vs static)?
6. **Chain 5 (R15):** does the value change happen *atomically* with
   respect to the rest of the request?

Each chain opened a new bug that the previous chain's fix created or
exposed. User's instruction to "chase the chain back around" has been
the right discipline.

---

*Co-authored-by: Claude Opus 4.7 (atomicity + long-blocking audit)*
*Target: `main` (direct push, no PR per user instruction)*
