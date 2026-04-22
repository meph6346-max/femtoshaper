# Round 19 — HTML/UI audit (wheel 1 of 3) (2026-04-22)

> **Audience:** Codex / other Claude. Starting the first of three
> continuous loops around the chain. R18 caught an absorbed-code bug
> in JS that earlier passes missed. R19 audits the HTML file that the
> earlier passes also never touched.

## Bugs fixed

### [BF-R19-001] MEDIUM: dead `/manual` link in app bar

- **File:** `data/index.html`
- **Class:** UX — dead link opens the app itself as the "manual".
- **Symptom:** App bar had
  `<a href="/manual" target="_blank" class="ab-link">📖</a>`. No server
  handler is registered for `/manual`; `server.onNotFound` falls back
  to `serveFile("/index.html", "text/html")`. So clicking the 📖 icon
  opened the FEMTO SHAPER app itself in a new tab. Users saw the same
  UI twice, no manual.
- **Fix:** removed the link. Left a comment block for anyone adding a
  manual later (either a real `server.on("/manual", ...)` entry or a
  hosted URL).

### [BF-R19-002] LOW: `doFactoryReset()` doesn't actually factory-reset

- **Files:** `data/settings.js`, `data/index.html`
- **Class:** misleading function name (potential user error).
- **Symptom:** The "⚠ Reset" button called `doFactoryReset()`, which
  only called `resetSettings()` + `saveSettings()` — it reset the
  FORM fields to defaults and persisted them via `/api/config`, but
  did NOT touch the NVS namespaces `femto_bg`, `femto_mpsd`,
  `femto_res`, or `femto_diag`. True factory reset is `POST
  /api/reset?all=1`. A user hitting a red warning button that says
  "Reset" and sees a confirm dialog reading "Reset ALL settings?"
  would reasonably expect everything to be wiped.
- **Fix:** renamed to `doResetSettingsToDefaults()` so the function
  name matches its actual scope. Added a stronger confirm message
  ("Measurement data and saved results are kept"). Kept a backwards-
  compat alias `const doFactoryReset = doResetSettingsToDefaults;`
  so any inline HTML not updated still works. Updated index.html
  button to call the new name + added a tooltip.
  Full NVS wipe via `/api/reset?all=1` remains unexposed to the UI;
  future-work, not in scope for this round.

## Verification

```
node --check data/settings.js
# pass
```

## Running total

186 (after round 18) + 2 = **188** bugs fixed across all rounds.

## Wheel 1 observations

Client JS and HTML were never audited by rounds 1-17 beyond compile /
syntax. UX-semantic bugs (dead links, misleading names) only surface
on manual review. Next laps:
- Wheel 2: revisit server chain with fresh eyes, now that R11-R15 fixes
  might have exposed new mismatches.
- Wheel 3: final sanity pass — do the bugs I've "fixed" actually work
  together, or have I made things contradict?

---

*Co-authored-by: Claude Opus 4.7 (3-wheel continuous pass, wheel 1/3)*
*Target: `main` (direct push, no PR per user instruction)*
