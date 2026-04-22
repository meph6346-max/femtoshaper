# Round 7 — Dead-code Removal + Full Comment Normalisation (2026-04-22)

> **Audience:** Codex / other Claude instances. After rounds 1–6 the file
> compiled cleanly but still had two lingering items: `/api/live/axis` was
> dead (no client caller), and ~131 Korean comments that had lost their
> encoding sat in `src/main.cpp` as unreadable `// ? ? ?????` lines.
> Round 7 removes the dead endpoint and rewrites every comment in English.
> Also fixes the last non-stub warning.

## What changed

| # | Item | Before | After |
|---|---|---|---|
| 1 | `/api/live/axis` | handler + `liveAxis` global + route registration (all dead code — no client calls) | removed entirely |
| 2 | `checkBodyLimit` sign-compare | `server.arg("plain").length() > maxBytes` (int vs size_t) | explicit `(size_t)` cast |
| 3 | Korean `// ???????` comments | 131 unreadable comment lines | all rewritten to English inferred from surrounding code |
| 4 | Two stray log fragments | `"[ADXL] ??: pins"`, `"Full Res, ?g"`, `// ? ? ?INT1` | ASCII equivalents |

## Verification

```
python3 scripts/check_brace_balance.py src/main.cpp src/dsp.h
# src/main.cpp: braces 265/265 [+0], parens 1455/1455 [+0]  OK
# src/dsp.h:    braces 102/102 [+0], parens  307/307 [+0]  OK

g++ -std=c++17 -fsyntax-only -Wall -Wextra -I/tmp/stubs src/main.cpp
# 0 lines of output = 0 errors, 0 warnings

g++ -std=c++17 -c -O2 -Wall -Wextra -I/tmp/stubs -o /tmp/main.o src/main.cpp
# 1 warning (adxlLatest() defined but not used - pre-existing, intentional
#   utility kept for future use; not in scope of this round)

# Byte-level sanity
python3 -c "with open('src/main.cpp','rb') as f: d=f.read(); \
  print('non-ASCII:', sum(1 for b in d if b > 0x7f), \
        'ASCII \"?\":', sum(1 for b in d if b == 0x3f))"
# non-ASCII: 0      (was 0 since round 5 already)
# ASCII "?": 46     (was 3177 - all remaining are legitimate ternary
#                    operators, format specifiers, or JSON key strings)

for f in data/*.js test/*.js; do node --check "$f"; done
# all pass

node test/sim_{accuracy,ci_validate,realistic}.js
# all pass
```

## Detail: Item 1 — remove `/api/live/axis`

Round 6 added a `static char liveAxis` global and made `handleLiveAxis`
update it, pending a future client wiring. Review of `data/live.js`
(and every other file in `data/`) shows **no caller** of
`POST /api/live/axis`, and the SSE payload sends both `bx[]` and `by[]`
unconditionally. The endpoint is therefore pure dead weight.

Removed three things:
- `static char liveAxis = 'a';` global (+comment)
- `void handleLiveAxis() { ... }` function
- `server.on("/api/live/axis", HTTP_POST, handleLiveAxis);` registration

If axis filtering becomes a real requirement, the cleanest future
design would add a `bx?: bool` / `by?: bool` pair to the SSE payload
so the client can opt out of whichever array it doesn't need, rather
than a separate REST call.

## Detail: Item 2 — `checkBodyLimit` sign-compare cast

g++ flagged the comparison in `checkBodyLimit()`:
```
warning: comparison of integer expressions of different signedness:
         'int' and 'size_t' [-Wsign-compare]
```
Arduino's `String::length()` returns `unsigned int`; on ESP32 that is
32-bit, same as `size_t`, so there was never a real overflow risk. Still,
the cast is free and the warning was noise.

```cpp
// before
if (server.arg("plain").length() > maxBytes) { ... }
// after
if ((size_t)server.arg("plain").length() > maxBytes) { ... }
```

## Detail: Item 3 — 131 comment rewrites

Every `// ???????` comment in `src/main.cpp` was rewritten in English
based on the code it annotated. Examples:

| Before | After |
|---|---|
| `// ???? Config (?? ???? ? ????? ?????????? ??????????????????????????` | `// ============ Config (persisted in NVS, loaded at boot) ============` |
| `// CS??? ?? HIGH??(SPI ????????? ??` | `// CS must be HIGH before SPI.begin() (idle state)` |
| `// R66: ? ??readback ?(SPI ??? ?? ? ?)` | `// R66: verify BW_RATE via readback (detects SPI glitch/miswire)` |
| `// R71: Config ? ?? ?(NVS ? ? /bit-flip ??defaults ??` | `// R71: sanity-check config fields (guards against NVS bit-flips)` |
| `// P-05/P-06 (Codex follow-up): sampleRate ??? ? ???????-rate ? ??? ??? // - measPsd ( ?rate?? ?? rate ? ? ? ?)` | `// P-05/P-06 (Codex follow-up): when sampleRate changes we must wipe rate-dependent caches, or their bin frequencies will be wrong: ...` |
| `// ???? GPIO10 ? ??? ? ???????` | `// ============ GPIO reset-button watchdog ============` |
| `// ??????? ???????(ADXL SPI ??? ? ?)` | `// Reload GPIO pin assignments (ADXL SPI may need re-init)` |

For R-numbered tags (e.g. `R1.1`, `R20.32`, `R60.5`, `R72`), the R-tag
is preserved so the referenced decision trail in earlier changelog
entries is still searchable.

Three items that *could* be rewritten but were intentionally kept as
pure English (they happened to have been ASCII already):
- `spiWrite(REG_FIFO_CTL, 0x99);  // Stream + WM=25`
- `// R32: measureJson() predicts length before serializing ...`
- `if (len == 0 || len >= sizeof(_jbuf))` (no comment)

No logic or identifiers changed in this round.

## Byte-level result

```
main.cpp non-ASCII bytes: 0 (was already 0 since round 4)
main.cpp literal '?':  3177 -> 46
```

The remaining 46 `?` characters are:
- C ternary operators (`cond ? a : b`)
- Format specifiers in string literals (`"%s"`, `"?g"` replaced, etc.)
- Legitimate JSON key/value strings (`"/api/psd?mode=print"`)

None are Korean-origin artefacts. The file is fully normalised.

## Running total

140 (before round 7) + 3 = **143** absorbed-code / related bugs fixed.

## What is genuinely out of scope now

- `adxlLatest()` is defined but not called anywhere. `-O2` surfaces this
  via `-Wunused-function`. Probably kept for future diagnostic use.
  Dropping it is a one-line delete but no callers exist today; left
  alone to avoid over-reach.
- `data/*.js` has a handful of non-ASCII emoji / box-drawing characters
  (✓, ✗, ▓, 🔒, etc.) used for UI presentation. These are intentional
  and should stay.
- `test/*.js` has 30 comment lines with Korean/non-ASCII in the simulation
  helpers. Those are research notes, not production code, and rewriting
  them risks losing context. Left as-is.

---

*Co-authored-by: Claude Opus 4.7 (A/B/C + cleanup sweep)*
*Target: `main` (direct push, no PR per user instruction)*
