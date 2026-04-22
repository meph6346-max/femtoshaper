# Round 29 — Restart-from-scratch Lap 3/3: WiFi txPower runtime apply (2026-04-22)

> **Audience:** Codex / other Claude. Final lap of the user-requested
> restart-from-scratch 3-lap sweep.

## Chain link: runtime state propagation (R11 pattern - 3rd recurrence)

R11 caught sampleRate not reaching the ADXL hardware.
R28 caught two more siblings (dspReset + liveSegReset).
This round found one more: WiFi TX power.

### [BF-R29-001] `handlePostConfig` did not apply cfg.txPower to live WiFi

- **File:** `src/main.cpp` `handlePostConfig` txPower block.
- **Class:** MEDIUM — user-visible regression between setting and
  actual hardware state until reboot.
- **Symptom:** `cfg.txPower = best;` stored the snapped value but did
  not call `WiFi.setTxPower(...)` to update the live radio. The
  WIFI_POWER_* enum mapping existed only inside `setup()`. Effect:
  a user lowering tx power to 2 dBm to reduce interference saw no
  change until reboot; the NVS/API view silently diverged from the
  radio's actual transmit power.
- **Fix:** In the txPower branch, if the snapped value differs from
  the prior cfg.txPower, map to the WIFI_POWER_* enum and call
  `WiFi.setTxPower(txPower)` live, with a Serial log for traceability.
- **Collateral:** `txPower` (static wifi_power_t) moved from its
  pre-R29 position (line ~1213, after handlePostConfig) to the top
  of the file (line ~53, alongside `_jbuf`/`_sseBuf`) so the handler
  can reference it. This is a pure declaration-order move.

## Verification

```
python3 scripts/check_brace_balance.py src/main.cpp src/dsp.h
# braces 311/311 [+0], parens 1566/1566 [+0]  OK

g++ -std=c++17 -fsyntax-only -Wall -Wextra -I/tmp/stubs src/main.cpp
# 0 warnings, 0 errors (after resolving the forward-reference that the
# first edit attempt exposed - good sanity that the rule of never
# writing C++ blindly still holds)

node test/sim_ci_validate.js  # all 5 scenarios OK
```

## Running total

**200 bugs fixed** (199 + 1 this round).

## 3-lap summary (R27 ~ R29)

- **Lap 1 (R27)**: absorbed-code confirmed exhausted; NVS read-path
  hardened (2 diagnostic-consistency fixes).
- **Lap 2 (R28)**: sampleRate change leaked 2 state siblings
  (dspReset for single-axis, liveSegReset).
- **Lap 3 (R29)**: WiFi txPower runtime apply missing; 1 more fix.

**Pattern insight:** R11 (runtime state not propagated) was the
origin; every lap found fresh instances because the check was always
done per-handler, never systematically. A better long-term fix would
be a "config mutator" abstraction that logs every cfg field change
and routes it to a registry of hardware-apply callbacks. That's
out of scope for a bug-sweep round but the failure mode recurs
often enough to warrant it.

---

*Co-authored-by: Claude Opus 4.7 (restart-from-scratch lap 3/3 - final)*
