// ============================================================
// FEMTO SHAPER Live Spectrum + Print Validation v0.8
// Phase 2: 실제 ESP32 /api/adxl/raw 폴링으로 교체
// ============================================================

let liveRunning   = false;
let liveInterval  = null;
const DSP_BINS = 59; // DSP_BIN_MAX - DSP_BIN_MIN + 1 (bin 6~64)
let liveData      = new Array(DSP_BINS).fill(0);
let livePeakFreq  = 0;
let liveEnergy    = 0;


// ── 실시간 ADXL 폴링 ─────────────────────────────────
// /api/adxl/raw를 160ms마다 폴링 → FFT 없이 raw 에너지로 바 표시
// Phase 3에서 WebSocket 실시간 FFT로 교체 예정


// ── Live Spectrum 토글 — SSE 기반 실시간 FFT ───────
let liveEventSource = null;

function toggleLive() {
  liveRunning = !liveRunning;
  document.getElementById('liveInd').classList.toggle('on', liveRunning);
  document.getElementById('liveBtnTxt').textContent =
    liveRunning ? t('btn_stop_live') : t('btn_start_live');

  if (liveRunning) {
    // v1.0: 캘리브레이션 미실행 경고
    fetch('/api/config').then(function(r){return r.json()}).then(function(d){
      if (!d.useCalWeights) {
        var el = document.getElementById('liveHint');
        if (el) el.innerHTML = '<span style="color:#EBCB8B">⚠ 캘리브레이션 미실행 — 센서 raw 축 사용 중. 정확한 X/Y 분리를 위해 설정에서 캘리브레이션을 실행하세요.</span>';
      }
    }).catch(function(){});
    ledBlink();
    // SSE 연결
    liveEventSource = new EventSource('/api/live/stream');
    liveEventSource.onmessage = (evt) => {
      try {
        const d = JSON.parse(evt.data);
        // v1.0: 듀얼 포맷 (bx/by)
        const binsX = d.bx || d.b || [];
        const binsY = d.by || [];
        if (binsX.length > 0) {
          for (let i = 0; i < binsX.length && i < liveData.length; i++) {
            liveData[i] = liveData[i] * 0.3 + binsX[i] * 0.7;
            if (liveData[i] < 0.01) liveData[i] = 0;  // 양자화 노이즈 차단
          }
          const ySmoothed = new Array(59).fill(0);
          for (let i = 0; i < binsY.length && i < ySmoothed.length; i++) {
            ySmoothed[i] = (typeof liveDataY !== 'undefined' ? liveDataY[i] : 0) * 0.3 + binsY[i] * 0.7;
            if (ySmoothed[i] < 0.01) ySmoothed[i] = 0;
          }
          drawLiveFrame(liveData, ySmoothed);

          // X 피크
          const pk = d.pkx || d.pk || 0;
          if (pk > 0) {
            livePeakFreq = pk;
            const peakEl = document.getElementById('livePeak');
            if (peakEl) peakEl.textContent = pk.toFixed(1) + ' Hz';
          }
          // Y 피크
          if (d.pky > 0) {
            const pyEl = document.getElementById('livePeakY');
            if (pyEl) pyEl.textContent = d.pky.toFixed(1) + ' Hz';
          }
          liveEnergy = d.e || 0;
        }
      } catch(e) {}
    };
    liveEventSource.onerror = () => {
      // 연결 끊김 → 자동 재연결 (EventSource 기본)
    };
  } else {
    ledOn();
    if (liveEventSource) {
      liveEventSource.close();
      liveEventSource = null;
    }
    fetch('/api/live/stop', {method:'POST'}).catch(()=>{});
    liveData.fill(0);
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


function initLive() {
  drawLiveFrame(liveData);
  const hintEl = document.getElementById('liveHint');
  fetch('/api/config').then(function(r){return r.json()}).then(function(d){
    if (hintEl && !d.useCalWeights) {
      hintEl.innerHTML = '<span style="color:#EBCB8B">⚠ 캘리브레이션 필요<br>설정에서 먼저 실행하세요</span>';
    }
  }).catch(function(){});
}


// v1.0: Quick/Print fusion 삭제 — Print-only
