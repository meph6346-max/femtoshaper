# Round 18 — Absorbed-code bug found in JavaScript (2026-04-22)

> **Audience:** Codex / other Claude instances. Rounds 1–8 recovered
> absorbed-code bugs in `src/main.cpp`. Round 18 finds the same class
> of bug in JavaScript — the early sweeps only audited C++.

## Bugs fixed

### [BF-R18-001] MEDIUM: `loadBgPsd` retry branch absorbed into a `//` comment

- **File:** `data/app.js` `loadBgPsd`
- **Class:** ABSORBED-CODE (same class as R1–R8 in `src/main.cpp`).
- **Symptom:** The pre-fix source read:
  ```js
  } else if (retryCount < 3) {
    // ?? ???3 ???? ?? setTimeout(() => loadBgPsd(retryCount + 1), 3000);
  }
  ```
  The `setTimeout(() => loadBgPsd(retryCount + 1), 3000);` call was
  supposed to execute — it's clearly what the branch is for — but a
  Korean-to-English conversion round-trip corrupted the preceding
  Korean comment into `?? ???3 ???? ??` and **inlined the setTimeout
  onto the same line as the comment**. Because `//` runs to EOL, the
  setTimeout became part of the comment and never executed.
  Effect: when `/api/noise` returns `valid=false` (bootNoise still
  capturing), `loadBgPsd` never retries. The `.catch` path DID retry
  on fetch errors, but the "valid=false" path was silently dead. The
  UI's `_bgPsdCache` would stay null, disabling background subtraction
  in chart overlays.
- **Fix:** moved `setTimeout` onto its own line as real code, and
  rewrote the comment in English explaining the intent.

## Why earlier rounds missed it

Rounds 1–8 were focused on `src/main.cpp` — I grep'd only `*.cpp`
and `*.h` files. The Korean→English conversion had also hit `data/*.js`,
but the scanners (brace-balance, unclosed-string, awk-stack) only ran
against C++ sources. Client JS has its own grammar (template literals
etc.) so the earlier toolchain didn't apply.

**Lesson**: whenever you find an absorbed-code bug pattern in one
language, re-run the scan against every other language in the repo.

## Verification

```
node --check data/app.js
# pass
```

## Running total

185 (after round 17) + 1 = **186** bugs fixed across all rounds.

## Next-round audit candidates

The same pattern might hit:
- Korean comments that got converted to `//` and silently ate trailing
  code on the same line — I did a broader regex scan this round (see
  commit for the script) and found only one real instance, but the
  absence of other hits could mean the grep is too narrow.
- Regex: any `// <non-ASCII>.* (setTimeout|setInterval|fetch|appLog|
  console\.[a-z]+)\s*\(` with no matching `)` AFTER the `//` — i.e.,
  the call's parens sit inside the comment.

---

*Co-authored-by: Claude Opus 4.7 (JS-side absorbed-code sweep)*
*Target: `main` (direct push, no PR per user instruction)*
