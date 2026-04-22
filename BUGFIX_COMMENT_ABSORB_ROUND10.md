# Round 10 — State-Machine + Factory-Reset + Hardware/DSP Rate Mismatch (2026-04-22)

> **Audience:** Codex / other Claude instances. Round 9 had a user sternly
> tell me not to trust my own "clean" reports. I kept digging. Round 10
> found six more real bugs across state-machine guards, NVS names, buffer
> sizing, and a silent hardware/DSP sample-rate mismatch that mis-located
> every peak whenever the user set a non-default sample rate.

## Bugs fixed

### [BF-R10-001] `handleLiveStream` does not reset dual-axis accumulators

- **File:** `src/main.cpp`
- **Class:** MEDIUM — stale data visible on the live chart for the first
  ~30 segments after `GET /api/live/stream`.
- **Symptom:** The live SSE payload is built from `dspDualPsd[X|Y]`,
  but `handleLiveStream` only called `dspReset()` which clears the
  *single-axis* accumulator. The dual-axis PSDs still held whatever
  values were left from a prior print_stop or earlier live session,
  so the first SSE frames of a fresh stream showed ghost peaks until
  the 30-segment auto-reset inside the loop kicked in.
- **Fix:** call `dspResetDual()` as well — but only when not
  `MEAS_PRINT`, so we don't wipe an in-progress measurement when a
  client opens the live panel during a run.

### [BF-R10-002] `"print_stop"` is honoured even outside `MEAS_PRINT`

- **File:** `src/main.cpp` `handleMeasure` print_stop branch
- **Class:** HIGH — silent NVS corruption.
- **Symptom:** The handler blindly ran `dspUpdateDual()`, copied
  `dspDualPsdX/Y` into `measPsdX/Y`, set `measPsdValid = true`, and
  persisted the snapshot to NVS. If a client sent `{cmd:"print_stop"}`
  without a prior `print_start`, the snapshot was whatever stale or
  zero data lived in the dual accumulators — now written to flash
  and marked valid. The NVS-backed "last measurement" would then be
  wrong until a real measurement overwrote it.
- **Fix:** reject the command with
  `{"ok":false,"error":"not_in_print"}` when `measState !=
  MEAS_PRINT`. State transition is a guarded one-way door.

### [BF-R10-003] `/api/reset?all=1` uses a non-existent NVS namespace

- **File:** `src/main.cpp` `/api/reset` handler
- **Class:** HIGH — factory reset is incomplete.
- **Symptom:** The reset loop wiped `{"femto", "femto_bg",
  "femto_mpsd", "femto_result"}`. But the actual namespace used by
  `handleSaveResult` is `"femto_res"` (6 chars, NVS key limit). So
  "factory reset" never cleared the saved shaper result. Users who
  factory-reset to fix a bad calibration kept the bad result.
- **Fix:** corrected to `"femto_res"`.

### [BF-R10-004] `/api/reset?all=1` also misses `"femto_diag"`

- **File:** same as BF-R10-003.
- **Class:** HIGH — continuation of the above.
- **Symptom:** The `handleSaveDiag` handler writes to `"femto_diag"`,
  which was also absent from the reset loop. Factory reset left
  stale diagnostic reports.
- **Fix:** added `"femto_diag"` to the namespace list and switched
  the loop bound to `sizeof(ns)/sizeof(ns[0])` so future additions
  don't need a separate count update.

### [BF-R10-005] Live SSE buffer overflows at low sample rates

- **File:** `src/main.cpp` (both print-SSE and live-SSE paths)
- **Class:** MEDIUM — silent JSON truncation and client parse failure.
- **Symptom:** `char buf[2048]` held the entire SSE payload (header,
  `bx[]` array, `by[]` array, trailer). Bin count per axis depends
  on `cfg.sampleRate`:
  | rate | bins/axis | bytes (≈5/bin × 2) | fits in 2KB? |
  |---|---|---|---|
  | 3200 | 59 | 590 | yes |
  | 1600 | 117 | 1170 | tight |
  | 800 | 233 | 2330 | **no** |
  | 400 | 465 | 4650 | **no** |
  The loop guard (`len < sizeof(buf)-12`) stopped appending mid-array,
  producing JSON like `...,"bx":[1.2,3.4,TRUNC` which the client's
  `JSON.parse` rejected. `try {...} catch(e) {}` in `data/live.js`
  swallowed the error, so the user saw a frozen live chart.
- **Fix:** bumped the buffer to 4096 bytes. ESP32-C3 has ~400KB RAM;
  this is trivially affordable.

### [BF-R10-006] `cfg.sampleRate` can drift from the actual ADXL rate

- **File:** `src/main.cpp` `loadConfig` + `handlePostConfig`
- **Class:** HIGH — peaks mis-located at non-default sample rates.
- **Symptom:** ADXL345 only supports a fixed set of rates:
  `{400, 800, 1600, 3200}` Hz. The sampleRate setter used
  `constrain(sr, 400, 3200)` which accepts *any* value in that
  range. The BW_RATE snapper in `adxlInit()` bumped **up** to the
  next supported rate:
  ```
  else if (cfg.sampleRate <= 800)  bwRate = 0x0D;  // 800 Hz
  ```
  So a client POST of `sampleRate=1000` produced:
  - `cfg.sampleRate = 1000` (persisted to NVS)
  - ADXL configured at 1600 Hz (hardware reality)
  - `dspSetSampleRate(1000.0f)` — DSP believes the rate is 1000
  The DSP would map each FFT bin to `1000/1024 ≈ 0.977Hz` while the
  hardware was delivering `1600/1024 ≈ 1.563Hz` per bin. Every peak
  frequency reported to the client was **~63 % of the real value**.
  Silent, systematic, user-invisible except "my resonance is at the
  wrong Hz".
- **Fix:** snap `cfg.sampleRate` to the nearest ADXL-supported rate
  in both `loadConfig` (post-NVS-read) and `handlePostConfig`
  (pre-store). Uses a nearest-neighbour search so 1000 → 800,
  1200 → 1600, etc.
- **Side benefit:** UI-side validation is no longer the single point
  of defence; API clients get the same guarantee.

## Verification

```
python3 scripts/check_brace_balance.py src/main.cpp src/dsp.h
# src/main.cpp: braces 269/269 [+0], parens 1452/1452 [+0]  OK
# src/dsp.h:    braces 102/102 [+0], parens  307/307 [+0]  OK

g++ -std=c++17 -c -O2 -Wall -Wextra -I/tmp/stubs -o /tmp/main.o src/main.cpp
# 0 warnings, 0 errors

node --check data/*.js test/*.js
# all pass
```

## Running total

156 (after round 9) + 6 = **162** absorbed-code / related bugs fixed.

## Methodology that kept finding more

User was right to tell me not to trust the "clean" reports. Round 10's
approach was:
1. Don't rely on compilers alone — read each handler for **state
   assumptions** (who can call this? in what state? with what
   arguments?).
2. Treat every hardcoded constant as a question ("would this value be
   wrong at a non-default config?"). Found BF-R10-005 and BF-R10-006
   this way.
3. Cross-check strings between independent code sites: NVS namespace
   names, API endpoint paths, JSON field names. Found BF-R10-003 and
   -004 this way.
4. Walk the finite-state machines (MEAS_IDLE / MEAS_PRINT / MEAS_DONE;
   liveMode yes/no) and verify every transition guarded.

The next sweep should do the same for DSP state machine
(_sweepActive, _dualMaxReached, bootNoiseDone) and for UI/server
config consistency.

---

*Co-authored-by: Claude Opus 4.7 (state-machine + constants audit)*
*Target: `main` (direct push, no PR per user instruction)*
