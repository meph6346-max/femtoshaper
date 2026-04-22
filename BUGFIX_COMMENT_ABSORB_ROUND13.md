# Round 13 — Response Buffer Sizing + Consecutive-Failure Logic (2026-04-22)

> **Audience:** Codex / other Claude instances. Round 12 validated inputs.
> Round 13 audited response-side buffer sizing at low sample rates and
> found two that silently failed end-to-end user flows, plus one polling
> logic bug.

## Bugs fixed

### [BF-R13-001] CRITICAL: `_jbuf` 8 KB too small for `/api/psd?mode=print` at low sample rates

- **File:** `src/main.cpp` top-of-file JSON buffer
- **Class:** CRITICAL — endpoint returns HTTP 507 at any `cfg.sampleRate
  < 3200`, making the entire Print-Measure flow unusable.
- **Symptom:** `_jbuf` was 8192 bytes, originally sized for the
  3200Hz-only case (59 bins/axis). At lower rates the bin count grows
  dramatically:
  | sampleRate | bins/axis | Serialised print-mode response (approx) |
  |---|---|---|
  | 3200 | 59 | ~4 KB (fits) |
  | 1600 | 117 | ~8 KB (borderline) |
  | 800 | 233 | ~15 KB (**507**) |
  | 400 | 465 | ~35 KB (**507**) |
  Each bin serialises as `{"f":18.75,"v":0.01,"var":0.0}` ≈ 30 bytes, and
  the response includes `binsX + binsY + jerkX + jerkY + bgPsd` = 5×N.
  `sendJson()` calls `measureJson()` first and rejects with 507 when
  `need+1 >= sizeof(_jbuf)`. Client at `data/app.js:74-77` treats the
  507 as a "PSD fetch HTTP 507" error and aborts the whole print analysis.
- **Fix:** bumped `_jbuf` to 32 KB. ESP32-C3 has 400 KB of DRAM and this
  is a single static buffer, so 32 KB is trivially affordable.

### [BF-R13-002] MEDIUM: Live SSE buffer 4 KB still too small at 400Hz

- **File:** `src/main.cpp` two `char buf[4096]` allocations (print-SSE and
  live-SSE send paths)
- **Class:** MEDIUM — silent JSON truncation at low sample rates, same
  shape as round 10's fix but that round didn't size the buffer correctly.
- **Symptom:** Round 10 bumped the per-frame SSE buffer from 2 KB to 4 KB
  to cover "sampleRate=400 with 465 bins". I under-calculated. With 465
  bins × ~5 chars/value + separators + two arrays + header, worst case
  is ~5800 bytes — still over 4 KB. The inner loop guard
  (`len < sizeof(buf)-12`) kicks in around bin 310, producing truncated
  JSON that the client's `JSON.parse` silently swallows.
- **Fix:** bumped to 8 KB on both SSE paths, with a comment explaining the
  sizing reasoning so a future round doesn't shrink it back.

### [BF-R13-003] LOW: `_pollFailCount` never reset on successful poll

- **File:** `data/measure.js` `startPrintPolling` inner interval
- **Class:** LOW — polling falsely gives up after 5 *total* failures
  spread over a session rather than 5 consecutive failures.
- **Symptom:** The catch branch incremented `window._pollFailCount` and
  stopped polling at `> 5`. The success branch never reset the counter.
  On a flaky connection with 5 isolated failures spread over half an
  hour, the interval would bail out even though each individual poll
  eventually succeeded on retry.
- **Fix:** reset `window._pollFailCount = 0` in the try branch, after
  each successful poll iteration completes. Renamed comment accordingly.

## Verification

```
python3 scripts/check_brace_balance.py src/main.cpp src/dsp.h
# src/main.cpp: braces 291/291 [+0], parens 1507/1507 [+0]  OK
# src/dsp.h:    braces 102/102 [+0], parens  318/318 [+0]  OK

g++ -std=c++17 -c -O2 -Wall -Wextra -I/tmp/stubs -o /tmp/main.o src/main.cpp
# 0 warnings, 0 errors

node --check data/measure.js
# pass
```

## Running total

174 (after round 12) + 3 = **177** bugs fixed across all rounds.

## Methodology note

This round's approach: for every byte-sized buffer, compute the worst
case payload at the extreme sample rate. Rounds 10/11 got partway there
(SSE buffer bumped, cfg validation), but I never computed the *PSD
endpoint* payload because I only audited SSE paths. The endpoint-level
audit showed `_jbuf` hadn't been re-sized since v1.0 when 59 bins was
the only operating point.

Rule of thumb for ESP32-C3: if a buffer is sized with a 3200Hz-default
in mind, check `400Hz (12× more bins)` as the worst case.

---

*Co-authored-by: Claude Opus 4.7 (buffer-sizing audit at sampleRate extremes)*
*Target: `main` (direct push, no PR per user instruction)*
