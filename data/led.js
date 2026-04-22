// ============ FEMTO SHAPER LED API v0.8 ============
// ESP32-C3 LED (Active Low)
// : off( ), on( ), blink( )

function ledCmd(state) {
  fetch('/api/led', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state })
  }).catch(() => {});
}
function ledOn()    { ledCmd('on'); }
function ledOff()   { ledCmd('off'); }
function ledBlink() { ledCmd('blink'); }
