// ============ FEMTO SHAPER LED API v0.8 ============
// ESP32-C3 온보드 LED 제어 (Active Low)
// 상태: off(대기), on(연결), blink(측정중)

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
