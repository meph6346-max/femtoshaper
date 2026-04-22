# Comment-Absorbed-Code Bug Sweep — Round 3 (2026-04-22)

> **Audience:** Codex and other Claude instances picking up this repository.
> This document explains which bugs this round fixed, how they were discovered,
> and what patterns to search for in future passes so the same class of bug
> does not resurface.

## Context

The `claude/fix-comment-parsing-bug-NXstQ` branch has been iteratively
recovering executable code that was accidentally swallowed into `//` comments
during earlier Korean → English comment normalization sweeps. Previous rounds
(see `BUGFIX_CHANGELOG.md`) already recovered 20+ absorbed items. This round
found **4 more** by using a paren/brace-balance script plus a targeted
stack-based search.

Running total of absorbed-code bugs fixed: **124 + 4 = 128**.

## Summary of fixes (all in `src/main.cpp`)

| # | Line (post-fix) | Class | Severity |
|---|-----------------|-------|----------|
| 1 | 1186–1189 | Runtime call swallowed into comment (`dspResetDual();`) | HIGH (stale PSD across mode switch) |
| 2 | 1305–1308 | File-scope declaration swallowed (`static unsigned long lastActivityMs`) | CRITICAL (undefined symbol, compile failure) |
| 3 | 1510–1513 | **Unterminated string literal** (missing closing `"`) | CRITICAL (silently ate ~5 lines of real code for the brace checker, hid downstream bugs from detection) |
| 4 | 1615–1618 | Lambda close tokens `});` swallowed into comment | CRITICAL (server.on block unterminated) |

All four are verified against `scripts/check_brace_balance.py`:

```
Before round 3:  main.cpp: braces 248/248 [+0], parens 1395/1393 [+2]  MISMATCH
After  round 3:  main.cpp: braces 250/250 [+0], parens 1402/1402 [+0]  OK
```

> The previous handover note claimed the `+2` parens were "harmless format-string
> parens inside printf string literals." **That diagnosis was wrong.** Both extra
> opens were real bugs (see BF-R3-003 and BF-R3-001 below).

---

## [BF-R3-001] `dspResetDual();` swallowed at `print_start` handler

- **File:** `src/main.cpp` (was line 1186, now 1186–1189)
- **Severity:** HIGH — functional, not a compile error
- **Symptom:** When the user starts a Print Measurement via
  `POST /api/measure {cmd:"print_start"}`, the dual-axis PSD accumulators were
  **not** reset. Any PSD data accumulated during prior Live-mode streaming
  (which runs `dspUpdateDual()` on every FIFO drain) would bleed into the
  print-measure capture, corrupting the very first segments of the new run.
- **How the bug looked pre-fix:**
  ```cpp
  liveMode = false;  // ?? ???? ?? ?????? ?? ??? ? ???????? ?? dspResetDual();
  measState = MEAS_PRINT;
  ```
  The `dspResetDual();` token is trailing text of a `//` comment, so the C++
  parser never sees it. The rest of the handler proceeds straight to
  `measState = MEAS_PRINT;` with stale dual-axis state.
- **Fix:**
  ```cpp
  // print_start: stop any live SSE streaming and reset the dual-axis DSP
  // accumulators so the fresh capture does not inherit stale live-mode PSDs.
  liveMode = false;
  dspResetDual();
  measState = MEAS_PRINT;
  ```
- **Corroboration:** `dspResetDual()` is also called in the reset branch
  (`main.cpp:1255`) and in the live-SSE periodic reset (`main.cpp:1819`).
  The print-start call sits between those, matching the existing pattern.

## [BF-R3-002] `static unsigned long lastActivityMs = 0;` swallowed

- **File:** `src/main.cpp` (was line 1304, now 1305–1308)
- **Severity:** CRITICAL — compile failure. (This should have been caught by
  any real build, but the prior sweeps either never built or built a version
  that still had another declaration hiding elsewhere.)
- **Symptom:** The deep-sleep inactivity timer references `lastActivityMs` at
  three sites (`main.cpp:1385`, `:1928`, `:1931`) but the declaration was
  absorbed into the comment that ends the preceding `#define` line.
- **How the bug looked pre-fix:**
  ```cpp
  #define DEEP_SLEEP_TIMEOUT_MS  (5 * 60 * 1000)  // 5????? ????????? ?static unsigned long lastActivityMs = 0;
  ```
  Everything from `// 5?...` to the semicolon is a single-line comment. The
  static-storage declaration disappears into the comment and the linker would
  emit `undefined reference to 'lastActivityMs'`.
- **Fix:** Split the line so the declaration stands on its own:
  ```cpp
  // ============ Deep sleep timeout ============
  // 5 minutes of inactivity before the MCU drops into deep sleep to save power.
  #define DEEP_SLEEP_TIMEOUT_MS  (5 * 60 * 1000)
  static unsigned long lastActivityMs = 0;
  ```

## [BF-R3-003] Unterminated string literal on line 1513 (DNS log)

- **File:** `src/main.cpp` (was line 1513, now 1510–1513)
- **Severity:** CRITICAL — silent parser desync plus it hid other defects
  from the brace-balance checker.
- **Symptom:** The DNS-started log line had no closing `"`:
  ```cpp
  Serial.println("[DNS] 癲ル슓釉????????????筌믨퀣援?);
  ```
  The raw bytes (hex dump) confirm there is no `"` between the mangled Korean
  text and the `)`. The C++ compiler would treat everything up to the next
  `"` (on line 1518 inside `esp_log_level_set("WiFiUdp", ...)`) as a single
  string constant spanning ~5 lines, consuming `}` on line 1514, the `if
  (staConnected) {` tokens on line 1517, and more. On a real build this is a
  loud error; on the brace-balance checker used in this repo, it gave
  *looks-balanced* false positives that hid other bugs (notably BF-R3-004).
- **Why earlier passes missed it:** The checker respects `"`-strings correctly
  but has no concept of "should this string close on the same line?" A
  runaway string that happens to balance the surrounding counts passes the
  sanity script.
- **Fix:** Replace the corrupted string with a clean ASCII log message and
  rewrite the preceding Korean comment:
  ```cpp
  // DNS server: when in AP mode, redirect every hostname to the captive portal.
  if (!staConnected) {
    dnsServer.start(53, "*", AP_IP);
    Serial.println("[DNS] captive-portal DNS started");
  }
  ```

## [BF-R3-004] `});` closing tokens of `server.on("/success.txt", ...)` swallowed

- **File:** `src/main.cpp` (was line 1613, now 1615–1618)
- **Severity:** CRITICAL — `server.on()` call never terminated; downstream
  handlers would register inside the captive-portal lambda body rather than
  at the outer scope.
- **Symptom:** The Firefox captive-portal probe handler was written as:
  ```cpp
  server.on("/success.txt",    []() {
    server.sendHeader("Cache-Control", "no-cache");
    server.send(200, "text/plain", "success");  // Firefox ?? ????? ? ? });
  // ? ? ? ?URL ??index.html (SPA ?? ??+ ????? ??????????
  server.onNotFound([]() { ... });
  ```
  The only `});` that would have closed the `/success.txt` lambda + call is
  **inside a `//` comment on line 1613**. The compiler would then treat
  `server.onNotFound([]() { ... });` as appearing *inside* the `/success.txt`
  lambda, which is nonsense.
- **Why balance-checker didn't flag it pre-fix:** The runaway string from
  BF-R3-003 ate lines 1514–1518 including a `{` and a `}`. That artificially
  balanced the `{`/`}` counts so this separate `});` loss wasn't visible
  until BF-R3-003 was fixed.
- **Fix:**
  ```cpp
  server.on("/success.txt",    []() {
    server.sendHeader("Cache-Control", "no-cache");
    server.send(200, "text/plain", "success");  // Firefox captive-portal probe
  });
  // SPA fallback: unknown URLs serve index.html so client-side routing works
  // + avoids 404s on direct tab reloads.
  server.onNotFound([]() { ... });
  ```

---

## Detection workflow (for the next sweep)

1. **Run the balance script first.** It is fast and finds the gross bugs.
   ```bash
   python3 scripts/check_brace_balance.py src/main.cpp src/dsp.h
   for f in data/*.js test/*.js; do python3 scripts/check_brace_balance.py "$f"; done
   ```

2. **Known false positives**
   - `data/measure.js`, `data/settings.js` report brace mismatches. These are
     false positives caused by **JavaScript template literals** (`` ` ``).
     The Python script in `scripts/check_brace_balance.py` does not handle
     backtick-delimited strings. When the script flags these files, confirm
     with `node --check data/<file>.js` — if node is happy, the mismatch is
     spurious. We did **not** modify those two files in this round.
   - `scripts/check_brace_balance.py` should be upgraded to track backticks
     and `${...}` interpolation before it is trusted on JS. Logged as a
     follow-up task, not done here.

3. **When the script reports a mismatch on `src/*.cpp` / `src/*.h`:**
   the mismatch is almost always real. Use a per-token stack walk:
   ```bash
   awk '
     BEGIN{ in_line=0; in_block=0; in_str=0; str_ch=""; esc=0 }
     { for(i=1;i<=length($0);i++){
         ch=substr($0,i,1)
         if(esc){esc=0;continue}
         if(in_line){continue}
         if(in_block){if(ch=="*"&&substr($0,i+1,1)=="/"){in_block=0;i++} continue}
         if(in_str){if(ch=="\\"){esc=1;continue} if(ch==str_ch){in_str=0} continue}
         if(ch=="\""||ch=="\x27"){in_str=1;str_ch=ch;continue}
         if(ch=="/"&&substr($0,i+1,1)=="/"){in_line=1;i++;continue}
         if(ch=="/"&&substr($0,i+1,1)=="*"){in_block=1;i++;continue}
         if(ch=="("){printf("%d:(\n",NR)}
         if(ch==")"){printf("%d:)\n",NR)}
       }
       in_line=0
     }' src/main.cpp > /tmp/parens.txt

   awk -F: '
     { if($2=="(") { stack[nest++]=$1 }
       else if($2==")") { if(nest>0) nest-- } }
     END{ for(i=0;i<nest;i++) print "unmatched ( at line "stack[i] }
   ' /tmp/parens.txt
   ```
   The line(s) it prints are the opens that never closed. **In this round,
   that pointed directly at the unterminated string on line 1513.**

4. **Targeted regex sweeps** for the remaining pattern classes:
   ```bash
   # Inline-comment absorbed statements/decls
   grep -nE "//[^/]*[;){}]\s*$" src/main.cpp
   grep -nE "//[^/]*\b(static|extern|#define|enum|struct|typedef)\b" src/main.cpp
   # Function calls captured into a comment
   grep -nE "//[^/]*[A-Za-z_][A-Za-z0-9_]*\s*\(" src/main.cpp | grep -v "^[[:space:]]*//"
   ```
   Any line that looks like an inline Korean-garbled comment ending in code
   punctuation (`;`, `)`, `}`) is suspect.

5. **Before committing,** re-run:
   ```bash
   python3 scripts/check_brace_balance.py src/main.cpp src/dsp.h
   # Expect: braces x/x [+0], parens y/y [+0]  OK
   ```

## Files NOT touched in this round (verified clean)

- `src/dsp.h` — balanced and no suspicious patterns.
- `test/*.js` — all balanced per checker.
- `data/charts.js`, `data/diagnostic.js`, `data/filter.js`, `data/i18n.js`,
  `data/kinematics.js`, `data/led.js`, `data/live.js`, `data/report.js`,
  `data/shaper.js`, `data/validator.js`, `data/app.js` — all balanced.
- `data/measure.js`, `data/settings.js` — checker reports a mismatch; this
  is a **false positive** from template literals. `node --check` passes. Not
  modified.

## Known residual cleanup (not in scope of this branch)

- Many `Serial.printf`/`println` messages still contain Korean text that has
  been mangled by a lossy UTF-8 round-trip (e.g. `"????????"`, `??NVS` in
  arrow form `→`, etc.). These compile and run; they are logging noise. See
  the existing changelog entry "English-only comments" for prior cleanup of
  this class.
- The `scripts/check_brace_balance.py` does not understand JS template
  literals. A small upgrade would remove the `data/measure.js` +
  `data/settings.js` noise from the checker output.

---

*Co-authored-by: Claude Opus 4.7 (sweep + patches)*
*Branch: `claude/fix-comment-parsing-bug-NXstQ`*
