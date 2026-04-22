# Round 14 — Chasing the chain: stack safety + uninit memory (2026-04-22)

> **Audience:** Codex / other Claude instances. User said "chase each
> fix's chain back around". Round 13 bumped _jbuf to 32KB and SSE buf to
> 8KB. Following that chain: what else on the stack / bss is sized
> recklessly now? Round 14 audits stack usage and re-checks `char[]`
> initializer consistency.

## Bugs fixed

### [BF-R14-001] CRITICAL: Two `char buf[8192]` locals in loop() risked stack overflow

- **File:** `src/main.cpp` two SSE send sites
- **Class:** CRITICAL — default Arduino-ESP32 loop task stack is 8 KB.
  Allocating an 8 KB local leaves effectively zero margin for function
  frames, other locals, and ISR context saves.
- **Symptom:** Round 13 bumped the live-SSE and print-SSE per-frame
  buffers from 4 KB to 8 KB on the stack. With the default
  `CONFIG_ARDUINO_LOOP_STACK_SIZE = 8192` (platformio.ini doesn't
  override it), an 8 KB local char[] consumes the entire stack before
  any function frame. Any snprintf / deeply-nested call would overflow
  into neighbouring memory — silent corruption or hard crash.
- **Fix:** moved the buffer to a file-scope `static char _sseBuf[8192]`
  and use a C++ array reference alias at each SSE site so `sizeof(buf)`
  still works in all the length-guard checks:
  ```cpp
  static char _sseBuf[8192];  // file scope
  ...
  // in loop:
  char (&buf)[sizeof(_sseBuf)] = _sseBuf;  // preserves sizeof
  ```
  Single-threaded loop means no concurrent reuse concern. +8 KB bss,
  −8 KB stack peak.

### [BF-R14-002] `char shTypeX/shTypeY[16]` not zero-initialised before `prefs.getString`

- **File:** `src/main.cpp` `handleLoadResult`
- **Class:** MEDIUM — undefined behaviour on missing NVS key.
- **Symptom:** When `prefs.getString("shaperTypeX", buf, len)` cannot
  find the key, it **does not touch the buffer**. The adjacent
  `char shType[16] = "";` was zero-initialised but `shTypeX` and
  `shTypeY` were not, so they contained whatever stack garbage was
  left. The fallback check `if (!shTypeX[0]) strncpy(shTypeX, shType, ...)`
  then branches on the garbage's first byte — unpredictable whether
  the fallback fires.
  Real impact: the first reload of a device that only had a
  generic `shaperType` but no per-axis types would sometimes show
  the fallback (`shTypeX = shType`) and sometimes show garbage
  characters in the UI, depending on what else was recently on the
  stack.
- **Fix:** initialise all three to `""` on declaration.

### [BF-R14-003] Regression guard: platformio.ini stack size

- **File:** `platformio.ini`
- **Class:** documentation / regression guard.
- **Note:** the fix for BF-R14-001 assumes the default 8 KB loop stack.
  If a future change bumps the loop stack (via
  `CONFIG_ARDUINO_LOOP_STACK_SIZE`), moving the SSE buffer back to the
  stack could be considered. For now the file-scope buffer is
  unconditionally safer. No change to platformio.ini this round — just
  flagging the coupling.

## Verification

```
python3 scripts/check_brace_balance.py src/main.cpp src/dsp.h
# src/main.cpp: braces 291/291 [+0], parens 1511/1511 [+0]  OK
# src/dsp.h:    braces 102/102 [+0], parens  318/318 [+0]  OK

g++ -std=c++17 -c -O2 -Wall -Wextra -I/tmp/stubs -o /tmp/main.o src/main.cpp
# 0 warnings, 0 errors

node --check data/*.js test/*.js
# all pass
```

## Running total

177 (after round 13) + 2 = **179** bugs fixed across all rounds.

## Chain of chains

Rounds 10 → 11 → 12 → 13 → 14 form one continuous chain:
- R10 bumped SSE buf 2→4 KB (wrong size, still too small)
- R11 re-audited runtime state mismatches
- R12 tightened input validation
- R13 discovered `_jbuf` at 8 KB overflowed at 400Hz, bumped to 32 KB
- R14 discovered R10/R13's stack-allocated SSE buf was itself a
  stack-overflow hazard after growing to 8 KB

Each round's fix created a new concern. Lesson: when you change a
buffer size, re-audit all memory categories (stack/static/heap) against
new constraints, not just "does it fit".

## Observed (not fixed) items left for future audits

- ESP32-C3 WebServer's send() of a 32KB `_jbuf` response takes ~10-20ms
  over WiFi. During that window loop() is blocked; the ADXL hardware
  FIFO (32 samples) can overflow at sampleRate=3200Hz (10ms of data).
  Counter `_adxlOverflowCount` already exists (R33). Reducing payload
  size via bin decimation at low sample rates would help; not in scope.
- Default `/api/psd` (no mode, no axis) returns `dspPsdAccum` which is
  only populated during the 1-second boot-noise capture. After boot,
  it's zero. The UI uses `?mode=print` and `?axis=x/y` (both work), so
  the default path is effectively dead. Documenting; not changing the
  response shape without user input.

---

*Co-authored-by: Claude Opus 4.7 (stack audit following _jbuf chain)*
*Target: `main` (direct push, no PR per user instruction)*
