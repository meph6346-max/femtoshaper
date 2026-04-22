# Comment-Absorbed-Code Bug Sweep — Round 5 (2026-04-22)

> **Audience:** Codex and other Claude instances picking up this repository.
> Round 4 (PR #3) fixed five unclosed string literals. Those fixes *exposed*
> bugs that no previous pass could see because they lived inside a runaway
> string. This round finds and fixes those newly-visible bugs, plus one
> long-standing `==` comparison that only surfaced when g++'s syntax-only
> mode was finally run end-to-end.

## Headline

Step-change: the earlier rounds only used a brace/paren balance checker. This
round is the first to run **actual syntax checking with `g++ -fsyntax-only`**
(against stubbed Arduino/ESP32 headers in `/tmp/stubs/`). The compiler
immediately surfaced 1 real bug that the brace checker could never see and
1 real bug that was formerly inside a runaway string.

Running total: 133 (before) + 4 = **137** absorbed/related bugs fixed.

## Bugs fixed

### [BF-R5-001] `measState` (+9 siblings) referenced before declaration

- **File:** `src/main.cpp`, previous line 656 (call site) / 964 (declaration)
- **Class:** forward-reference compile failure. Hidden for months because
  line 656 sat inside the BF-R4-003 runaway string (lines 457–658 were
  invisible to prior sweeps). Once that runaway was closed by round 4,
  the compiler could finally see line 656 — and it could not resolve the
  identifier.
- **Symptom:**
  ```
  src/main.cpp:656:7: error: 'measState' was not declared in this scope
  src/main.cpp:656:20: error: 'MEAS_PRINT' was not declared in this scope
  src/main.cpp:681:7: error: 'measPsdValid' was not declared
  ... (measSampleRate, measBinMin, measBinCount,
       measPsdX, measPsdY, measVarX, measVarY, measJerkX, measJerkY)
  ```
  `handlePostConfig` (line 650) references 10 measurement-state globals that
  were declared 300 lines later (line 962–986). C++ needs the declaration
  first; compile fails.
- **Fix:** Moved the entire `// ============ Measurement state machine ============`
  block (enum, state variable, live/SSE state, peak tracking, measured PSD
  snapshot, and `MEAS_MAX_BINS` macro — 25 lines total) from line 962 to
  immediately before `handlePostConfig`. No logic changed; only placement.
- **Verification:** `g++ -std=c++17 -fsyntax-only` now completes with zero
  errors on `src/main.cpp` (against stubbed headers).

### [BF-R5-002] `handleLed` compares `const char*` with `==` (pointer comparison)

- **File:** `src/main.cpp:881–884`
- **Class:** long-standing logic bug. Exists in git history as far back as
  the file goes; never caught because earlier passes focused on structural
  issues. Surfaced now because this pass is the first to run the compiler
  with `-Wall`.
- **Symptom (g++ output):**
  ```
  src/main.cpp:882: warning: comparison with string literal results in
                    unspecified behavior [-Waddress]
  src/main.cpp:883: warning: comparison with string literal results in
                    unspecified behavior [-Waddress]
  ```
- **Runtime consequence:** `POST /api/led {"state":"on"}` **never** turned
  the LED on. `st == "on"` compares the pointer `st` (points into the
  ArduinoJson parse buffer) against the address of the literal `"on"`.
  Those pointers are never equal, so every request fell through to the
  `else` branch and the LED went to `LED_OFF`. `"blink"` was equally broken.
- **Before:**
  ```cpp
  const char* st = doc["state"] | "off";
  if      (st=="on")    ledState=LED_ON;
  else if (st=="blink") ledState=LED_BLINK;
  else                  ledState=LED_OFF;
  ```
- **After:**
  ```cpp
  const char* st = doc["state"] | "off";
  if      (strcmp(st, "on")    == 0) ledState = LED_ON;
  else if (strcmp(st, "blink") == 0) ledState = LED_BLINK;
  else                               ledState = LED_OFF;
  ```
- **Note for future reviewers:** `String == "literal"` is fine (Arduino's
  `String` has an `operator==` overload). `const char* == "literal"` is
  **always** wrong — compare with `strcmp`.

### [BF-R5-003] `DspStatus st = dspGetStatus();` at column 0

- **File:** `src/main.cpp:1129`
- **Class:** cosmetic (bad indentation). Not a compile error but very
  suspicious: this was the only non-`}` statement at column 0 inside a
  function body, strongly suggesting an incomplete refactor. Fixed to
  match the surrounding 2-space indentation for readability.

### [BF-R5-004] `data/app.js` leading UTF-8 BOM (`EF BB BF`)

- **File:** `data/app.js` byte 0
- **Class:** encoding deviation from the project convention. The existing
  `BUGFIX_CHANGELOG.md` header explicitly states
  "Encoding: UTF-8 (no BOM)". The BOM is harmless to modern JS engines
  but inconsistent with other files in `data/`. Removed the 3-byte BOM.

## What else was audited

- **`g++ -fsyntax-only` against `src/main.cpp` with stubs:** 0 errors
  remaining after BF-R5-001.
- **`g++ -fsyntax-only` against `src/dsp.h`:** 0 errors.
- **`node --check` on every file under `data/` and `test/`:** all pass.
- **Every `const char*` variable vs. string-literal comparison in
  `src/main.cpp`:** only `handleLed` had a broken `==`; every other site
  already uses `strcmp`. Catalogued for future sweeps:
  - `AP_SSID` — never compared.
  - `cmd` in `handleMeas` — uses `strcmp(cmd, "...")`. OK.
  - `axis` in `handleGetPsd` — declared but unused (see below).
  - `ax` in `handleLiveAxis` — declared but unused (see below).
  - `JS`, `CSS` in `setup()` — used only as template-capture arg. OK.
- **BOM scan on all source files:** only `data/app.js` had a BOM. Fixed.

## Suspicious but not fixed this round

- `handleGetPsd`: `const char* axis = ...` is declared but never branched
  on. The function always returns the accumulated current PSD, ignoring
  `?axis=x` / `?axis=y`. Could be unfinished feature or an absorbed-code
  victim. Needs design intent from the owner to resolve correctly — not a
  mechanical fix.
- `handleLiveAxis`: `const char* ax = req["axis"] | "a";` is declared but
  never assigned to any module-scope state. The handler only resets the
  DSP. Same "unfinished vs. absorbed" ambiguity as above.
- `Serial.printf` format strings on `main.cpp:1232` and scattered elsewhere
  contain Korean-garbled text including byte sequences that g++ warns
  about (`?? (` = trigraph for `[`). Cosmetic noise in log messages; not
  a code bug. Cleanup candidate for a dedicated log-message sweep.

## Detection workflow update (for the next sweep)

Add these steps to the existing workflow in `BUGFIX_COMMENT_ABSORB_ROUND3.md`
and `ROUND4.md`:

5. **g++ syntax-only compile with stubs.** Create minimal Arduino/ESP32
   stubs in `/tmp/stubs/` (see prompt history for the stub header used
   this round), then:
   ```bash
   g++ -std=c++17 -fsyntax-only -Wall -Wextra -I/tmp/stubs src/main.cpp
   ```
   This is the authoritative check. Fix every non-stub error; the
   balance checker + unclosed-string scanner do not catch forward
   references, wrong comparisons, or type errors.
6. **Remember that round N+1 can expose bugs that round N could not
   see**, because every fixed runaway string newly exposes real code
   to the compiler.

## Verification

```
braces 265/265 [+0], parens 1458/1458 [+0]  OK      (src/main.cpp)
braces 102/102 [+0], parens  307/307 [+0]  OK       (src/dsp.h)
g++ -std=c++17 -fsyntax-only -I/tmp/stubs src/main.cpp   # no output = success
node --check data/*.js test/*.js                         # all clean
```

---

*Co-authored-by: Claude Opus 4.7 (sweep + patches)*
*Branch: `claude/fix-comment-parsing-bug-NXstQ`*
