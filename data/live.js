// ============================================================
// FEMTO SHAPER Live Spectrum + Print Validation v0.8
// Phase 2: ESP32 /api/adxl/raw
// ============================================================

let liveRunning   = false;
let liveInterval  = null;
let liveBinCount  = 59;
window.liveBinMin = 6;
window.liveFreqRes = 3.125;
let liveData      = new Array(liveBinCount).fill(0);
let livePeakFreq  = 0;
let liveEnergy    = 0;
const LIVE_BAR_ALPHA = 0.25;
const LIVE_PEAK_ALPHA = 0.2;

function resizeLiveBins(binCount) {
  const nextCount = Math.max(1, parseInt(binCount || 0, 10));
  if (!Number.isFinite(nextCount) || nextCount <= 0 || nextCount === liveData.length) return;
  liveBinCount = nextCount;
  liveData = new Array(liveBinCount).fill(0);
  if (typeof syncLiveChartBinCount === 'function') syncLiveChartBinCount(liveBinCount);
}

function blendLiveValue(prev, next, alpha) {
  const safePrev = Number.isFinite(prev) ? prev : 0;
  const safeNext = Number.isFinite(next) ? next : 0;
  return safePrev * (1 - alpha) + safeNext * alpha;
}


// ADXL
// /api/adxl/raw 160ms FFT raw
// Phase 3 WebSocket FFT


// Live Spectrum SSE FFT
let liveEventSource = null;

function toggleLive() {
  liveRunning = !liveRunning;
  document.getElementById('liveInd').classList.toggle('on', liveRunning);
  document.getElementById('liveBtnTxt').textContent =
    liveRunning ? t('btn_stop_live') : t('btn_start_live');

  if (liveRunning) {
    // v1.0:
    fetch('/api/config').then(function(r){return r.json()}).then(function(d){
      if (!d.useCalWeights) {
        var el = document.getElementById('liveHint');
        if (el) el.innerHTML = '<span style="color:#EBCB8B">⚠ 캘리브레이션 미실행 — 센서 raw 축 사용 중. 정확한 X/Y 분리를 위해 설정에서 캘리브레이션을 실행하세요.</span>';
      }
    }).catch(function(){});
    ledBlink();
    // R38: EventSource (Safari <15)
    if (typeof EventSource === 'undefined') {
      appLog && appLog('logShaper', `<span class="log-err">!</span> EventSource not supported in this browser`);
      liveRunning = false;
      return;
    }
    // SSE. We wrap EventSource setup in a function so the watchdog below
    // can re-attach the onmessage / onerror handlers after a stale-reset.
    // Previously the watchdog did `new EventSource(...)` without rewiring
    // handlers, so the first watchdog-triggered reconnect left the client
    // permanently frozen (new socket, no data sink).
    let _liveLastMsgAt = Date.now();
    const _attachLiveHandlers = (src) => {
      src.addEventListener('message', () => { _liveLastMsgAt = Date.now(); });
      src.onmessage = _onLiveMessage;
      src.onerror = _onLiveError;
    };
    liveEventSource = new EventSource('/api/live/stream');
    // R38: stale-connection watchdog (10s)
    if (window._liveWatchdog) clearInterval(window._liveWatchdog);
    window._liveWatchdog = setInterval(() => {
      if (!liveRunning) { clearInterval(window._liveWatchdog); return; }
      if (Date.now() - _liveLastMsgAt > 10000) {
        console.warn('[live] stale connection detected, resetting');
        try { if (liveEventSource) liveEventSource.close(); } catch(e) {}
        liveEventSource = null;
        _liveLastMsgAt = Date.now();
        try {
          liveEventSource = new EventSource('/api/live/stream');
          _attachLiveHandlers(liveEventSource);
        } catch(e) {}
      }
    }, 5000);
    // Handlers declared below, then attached. Declaring first keeps the
    // watchdog reset path simple (same function reference every time).
    const _onLiveMessage = (evt) => {
      try {
        const d = JSON.parse(evt.data);
        // Propagate bin geometry to chart renderers (charts.js reads
        // window.liveBinMin / liveFreqRes to draw correct Hz labels).
        if (typeof d.bm === 'number') window.liveBinMin  = d.bm;
        if (typeof d.fr === 'number') window.liveFreqRes = d.fr;
        // v1.0: (bx/by)
        const binsX = d.bx || d.b || [];
        const binsY = d.by || [];
        if (binsX.length > 0) {
          if (Number.isFinite(d.bm)) window.liveBinMin = d.bm;
          if (Number.isFinite(d.fr)) window.liveFreqRes = d.fr;
          resizeLiveBins(Math.max(binsX.length, binsY.length || 0));
          for (let i = 0; i < binsX.length && i < liveData.length; i++) {
            liveData[i] = blendLiveValue(liveData[i], binsX[i], LIVE_BAR_ALPHA);
            if (liveData[i] < 0.01) liveData[i] = 0;  //
          }
          const ySmoothed = new Array(liveData.length).fill(0);
          for (let i = 0; i < binsY.length && i < ySmoothed.length; i++) {
            ySmoothed[i] = blendLiveValue(typeof liveDataY !== 'undefined' ? liveDataY[i] : 0, binsY[i], LIVE_BAR_ALPHA);
            if (ySmoothed[i] < 0.01) ySmoothed[i] = 0;
          }
          drawLiveFrame(liveData, ySmoothed);

          // X
          const pk = d.pkx || d.pk || 0;
          if (pk > 0) {
            livePeakFreq = blendLiveValue(livePeakFreq, pk, LIVE_PEAK_ALPHA);
            const peakEl = document.getElementById('livePeak');
            if (peakEl) peakEl.textContent = livePeakFreq.toFixed(1) + ' Hz';
          }
          // Y
          if (d.pky > 0) {
            const smoothedPeakY = blendLiveValue(parseFloat(document.getElementById('livePeakY')?.textContent) || 0, d.pky, LIVE_PEAK_ALPHA);
            const pyEl = document.getElementById('livePeakY');
            if (pyEl) pyEl.textContent = smoothedPeakY.toFixed(1) + ' Hz';
          }
          liveEnergy = d.e || 0;
        }
      } catch(e) {}
    };
    const _onLiveError = () => {
      // R16.20: stop (ESP32 will GC the socket)
      try { fetch('/api/live/stop', {method:'POST'}).catch(()=>{}); } catch (e) {}
    };
    _attachLiveHandlers(liveEventSource);
  } else {
    ledOn();
    // R16.18: close + null
    try { if (liveEventSource) liveEventSource.close(); } catch (e) {}
    liveEventSource = null;
    fetch('/api/live/stop', {method:'POST'}).catch(()=>{});
    liveData.fill(0);
    // R19.28: OFF destroy ( )
    if (typeof destroyLiveChart === 'function') destroyLiveChart();
    drawLiveFrame(liveData);
    const peakEl = document.getElementById('livePeak');
    const peakYEl = document.getElementById('livePeakY');
    if (peakEl) peakEl.textContent = '—';
    if (peakYEl) peakYEl.textContent = '—';
    const st = document.getElementById('liveStatus');
    if (st) st.textContent = '';
    const hint = document.getElementById('liveHint');
    if (hint) hint.style.display = '';
  }
}


// R16.20: / SSE stream (sendBeacon )
if (typeof window !== 'undefined' && !window._femtoBeforeUnload) {
  window._femtoBeforeUnload = true;
  window.addEventListener('beforeunload', () => {
    try {
      if (liveEventSource) {
        liveEventSource.close();
        if (navigator.sendBeacon) navigator.sendBeacon('/api/live/stop');
        else fetch('/api/live/stop', {method:'POST', keepalive: true})
          .catch(err => console.warn('[live] unload stop failed:', err));
      }
    } catch (e) { console.warn('[live] beforeunload err:', e); }
  });
}

function initLive() {
  drawLiveFrame(liveData);
  const hintEl = document.getElementById('liveHint');
  fetch('/api/config').then(function(r){return r.json()}).then(function(d){
    if (hintEl && !d.useCalWeights) {
      hintEl.innerHTML = '<span style="color:#EBCB8B">⚠ 캘리브레이션 필요<br>설정에서 먼저 실행하세요</span>';
    }
  }).catch(function(){});
}


// v1.0: Quick/Print fusion Print-only
