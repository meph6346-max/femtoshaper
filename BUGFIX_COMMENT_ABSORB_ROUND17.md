# Round 17 — Tab-switch resource symmetry (2026-04-22)

> **Audience:** Codex / other Claude instances. Round 16 found the live
> watchdog lost handlers on reconnect. Round 17 follows the same
> pattern: what OTHER resources go stale when the user switches tabs?

## Bugs fixed

### [BF-R17-001] `switchTab` killed live watchdog but left EventSource open

- **File:** `data/app.js` `switchTab`
- **Class:** MEDIUM — silent stream stall on the live tab after a
  WiFi glitch.
- **Symptom:**
  ```js
  if (id !== 'live' && typeof window !== 'undefined' && window._liveWatchdog) {
    clearInterval(window._liveWatchdog);
    window._liveWatchdog = null;
  }
  ```
  Tab switch off live killed the 10-second stale-connection watchdog.
  But `liveEventSource` stayed open — still delivering SSE frames to
  handlers that still ran.
  Problem: after the user returns to the live tab, the watchdog was
  never re-created (initLive doesn't schedule it; only `toggleLive`
  does). If the connection then goes stale (WiFi glitch, server
  reboot), nothing detects the stall. User sees "LIVE" on but frozen
  chart until they toggle LIVE off/on.
  Resource symmetry: watchdog ↔ EventSource should live together. Either
  both open or both closed.
- **Fix:** removed the `clearInterval` on tab switch. The watchdog
  already self-terminates when `liveRunning` goes false
  (see `data/live.js` line 49 `if (!liveRunning) clearInterval(...)`).
  Letting it keep watching across tab switches means it still detects
  stale connections when the user returns.

### [BF-R17-002] `switchTab` entering shaper didn't resume print polling

- **File:** `data/app.js` `switchTab`
- **Class:** MEDIUM — stale UI after any tab round-trip during an
  active print measurement.
- **Symptom:** Leaving the shaper tab called `stopPrintPolling()`
  (line 39-41). Returning to shaper did NOT call
  `resumePrintMeasureIfActive()` even though a helper exists in
  `data/measure.js` for that exact purpose (already used at page
  load, app.js:710). Result: user starts print measurement, switches
  to settings to check something, comes back to shaper — sees stale
  progress % and segment count. The server-side measurement is
  actually still running fine; only the client's display is frozen
  until the user manually clicks Done or restarts.
- **Fix:** call `resumePrintMeasureIfActive()` inside the existing
  `if (id === 'shaper') setTimeout(...)` block so the same 100 ms
  delay that guards chart redraws also delays the polling resume
  until the tab is visually active.

## Verification

```
node --check data/app.js
# pass

node --check data/live.js
# pass
```

## Running total

183 (after round 16) + 2 = **185** bugs fixed across all rounds.

## Pattern observation

Two R17 bugs are both **resource-pair asymmetry**:
- Watchdog and EventSource should live or die together.
- stopPolling and resumePolling should both fire on matching tab events.

R16 was a handler-rewire pattern; R17 is a paired-lifecycle pattern.
Both are variants of "resource A's state changed but derived resource
B wasn't updated to match".

Next candidate to audit with this lens: any pair of
`addEventListener` / `removeEventListener` (none used here — good);
any `fetch` whose result updates a global that's expected to match a
different fetch's cache (suspect: `_bgPsdCache`, `_calWeights`,
`_fanHotendPsd` — each read from multiple places).

---

*Co-authored-by: Claude Opus 4.7 (tab-switch resource symmetry)*
*Target: `main` (direct push, no PR per user instruction)*
