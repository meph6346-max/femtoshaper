# Round 16 — Client-side chain: watchdog handler rewire (2026-04-22)

> **Audience:** Codex / other Claude instances. Rounds 10-15 chased the
> server-side chain. Round 16 follows the same "chase the chain"
> discipline on the client. Found one CRITICAL latent bug in the live
> SSE watchdog.

## Bugs fixed

### [BF-R16-001] CRITICAL: Live SSE watchdog reconnect silently drops message handlers

- **File:** `data/live.js` live SSE init + 10 s watchdog
- **Class:** CRITICAL — first watchdog-triggered reconnect leaves the
  live chart permanently frozen with no visible error. User sees an
  active green "LIVE" indicator but zero data flowing.
- **Symptom:** The initial SSE setup was:
  ```js
  liveEventSource = new EventSource('/api/live/stream');
  // watchdog setInterval(...) scheduled
  liveEventSource.addEventListener('message', ...);  // data sink
  liveEventSource.onmessage = ...;                   // parse + render
  liveEventSource.onerror = ...;                     // trigger stop
  ```
  The watchdog body, on stale detection:
  ```js
  try { if (liveEventSource) liveEventSource.close(); } catch(e) {}
  liveEventSource = null;
  _liveLastMsgAt = Date.now();
  try { liveEventSource = new EventSource('/api/live/stream'); } catch(e) {}
  ```
  Creates a fresh EventSource but **never re-attaches** the handlers.
  The new socket receives SSE frames but nothing parses them, so
  `_liveLastMsgAt` stays at the reset time and the next watchdog tick
  fires again — infinite loop of zombie reconnects.
  This is a latent bug: only triggers when a stale connection is
  detected (e.g., WiFi flicker during an active Live session), but
  once triggered the user has to reload the page.
- **Fix:** extracted handler setup into `_attachLiveHandlers(src)`
  that attaches `addEventListener('message', ...)`, `onmessage`, and
  `onerror` to any passed-in EventSource. Called once at init and on
  every watchdog reset:
  ```js
  const _attachLiveHandlers = (src) => {
    src.addEventListener('message', () => { _liveLastMsgAt = Date.now(); });
    src.onmessage = _onLiveMessage;
    src.onerror = _onLiveError;
  };
  // init: create + attach
  liveEventSource = new EventSource('/api/live/stream');
  _attachLiveHandlers(liveEventSource);
  // watchdog: close, create, attach
  ```
  `_onLiveMessage` and `_onLiveError` are declared as named consts
  so the same function reference is reused on every reconnect (no
  handler leaks).

## Verification

```
node --check data/live.js
# pass

g++ -std=c++17 -c -O2 -Wall -Wextra -I/tmp/stubs -o /tmp/main.o src/main.cpp
# 0 warnings (this round didn't touch C++ but sanity-checked)
```

## Running total

182 (after round 15) + 1 = **183** bugs fixed across all rounds.

## Chain implication

The client half of the chain pattern starts to show. R16 is the
client-side analog of R11 (server BW_RATE register never reprogrammed
on runtime rate change). Both are the same bug shape: **resource A
changes state, but resource B derived from A doesn't re-derive**. On
the server side, cfg.sampleRate changed but ADXL register didn't.
On the client side, the EventSource socket was replaced but handlers
weren't re-attached.

Classes of bugs this pattern predicts (to audit next):
- Chart.js chart recreate after tab switch — are event handlers kept?
- `realPsdX` / `realPsdY` global mutation during a render — is there
  a half-drawn state?
- `loadSettings` retry loop — are stale values overwritten cleanly?

---

*Co-authored-by: Claude Opus 4.7 (client-side chain continuation)*
*Target: `main` (direct push, no PR per user instruction)*
