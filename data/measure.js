// ============ FEMTO SHAPER Measure Engine v0.9 ============
// + app.js

//
let measPollTimer = null;
let measPhase = 'idle';

// ADXL345 +
async function checkAdxlStatus() {
  const dot = document.getElementById('adxlDot');
  const label = document.getElementById('adxlLabel');
  const statusEl = document.getElementById('adxlStatus');
  const banner = document.getElementById('demoBanner');

  try {
    const res = await fetch('/api/adxl/status');
    const d = await res.json();
    adxlConnected = d.ok === true;

    if (adxlConnected) {
      if (dot) dot.style.color = '#4CAF50';
      if (label) label.textContent = 'ADXL345 OK';
      if (statusEl) statusEl.className = 'ab-st adxl-ok';
      if (banner) banner.style.display = 'none';
      appLog('logShaper', `<span class="log-ok">✓</span> ${t('log_adxl_ok')}0x${(d.devId||0).toString(16).toUpperCase()})`);
    } else {
      if (dot) dot.style.color = '#FF5252';
      if (label) label.textContent = t('adxl_conn_fail');
      if (statusEl) statusEl.className = 'ab-st adxl-fail';
      if (banner) banner.style.display = 'block';
      appLog('logShaper', `<span class="log-err">✗</span> ${t('log_adxl_fail')}`);
      appLog('logShaper', `<span class="log-warn">ℹ</span> ${t('log_wiring')}SCK→GPIO${d.pinSCK||'?'} MISO→GPIO${d.pinMISO||'?'} CS→GPIO${d.pinCS||'?'}`);
    }
  } catch (e) {
    // ESP32 ( )
    adxlConnected = false;
    if (dot) dot.style.color = '#FF5252';
    if (label) label.textContent = t('adxl_esp_fail');
    if (statusEl) statusEl.className = 'ab-st adxl-fail';
    if (banner) { banner.style.display = 'block'; banner.textContent = '⚠ '+t('adxl_demo_msg'); }
  }
}


const APP_LOG_MAX = 100;

// R119: HTML (appLog untrusted )
function _escLog(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function appLog(id, html) {
  const el = document.getElementById(id);
  if (!el) return;
  const now = new Date();
  const ts = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}`;
  el.innerHTML += `<div><span style="color:var(--c-t3)">[${ts}]</span> ${html}</div>`;
  // ( )
  const divs = el.querySelectorAll ? el.querySelectorAll('div') : [];
  if (divs.length > APP_LOG_MAX) {
    const lines = el.innerHTML.split('</div>');
    el.innerHTML = lines.slice(-APP_LOG_MAX).join('</div>');
  }
  el.scrollTop = el.scrollHeight;
}

//


// v0.9: / /


//


// X


// Y


//


//


// :






//
// v1.0 Print Measure DSP
// " " = X/Y +
//

let printPollTimer = null;

async function startPrintMeasure() {
  // R52.1: /
  measPhase = 'idle';
  if (typeof stopPrintPolling === 'function') stopPrintPolling();
  // R58.1: (stale )
  if (typeof window !== 'undefined') {
    if (typeof peakFreqXGlobal !== 'undefined') window.peakFreqXGlobal = 0;
    if (typeof peakFreqYGlobal !== 'undefined') window.peakFreqYGlobal = 0;
  }

  //
  try {
    const cfgRes = await fetch('/api/config');
    const cfg = await cfgRes.json();
    if (!cfg.useCalWeights) {
      // R55.1: calibration_required
      appLog('logShaper', `<span class="log-err">\u2717</span> ${t('pm_cal_required') || '축 캘리브레이션이 필요합니다.'} → <a href="#" onclick="switchTab('settings');return false;">설정 → 캘리브레이션</a>`);
      return;
    }
  } catch(e) {
    appLog('logShaper', `<span class="log-err">\u2717</span> ${t('log_conn_err') || 'Connection error: '}${e.message || 'unknown'}`);
    return;
  }

  appLog('logShaper', `<span class="log-ok">▶</span> ${t('pm_start') || '측정 시작 — 출력을 시작하세요'}`);

  try {
    const res = await fetch('/api/measure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'print_start' })
    });
    const d = await res.json();
    if (!d.ok) {
      if (d.error === 'calibration_required') {
        appLog('logShaper', `<span class="log-err">\u2717</span> ${t('pm_cal_required') || '캘리브레이션 필요'}`);
      } else if (d.error === 'cannot_change_sample_rate_during_measurement') {
        appLog('logShaper', `<span class="log-err">\u2717</span> 측정 중에는 샘플레이트를 변경할 수 없습니다.`);
      } else {
        // R51.3: error fallback
        appLog('logShaper', `<span class="log-err">\u2717</span> ${_escLog(d.error) ||  'ESP32 returned error without detail'}`);
      }
      return;
    }

    measPhase = 'print';
    ledBlink();
    setPrintMeasBtn('running');
    appLog('logShaper', `<span class="log-ok">✓</span> ${t('pm_collecting') || '듀얼 수집 중... 출력을 계속하세요'}`);
    startPrintPolling();
  } catch(e) {
    appLog('logShaper', `<span class="log-err">✗</span> ${_escLog(e.message)}`);
  }
}

async function stopPrintMeasure() {
  stopPrintPolling();
  appLog('logShaper', `<span class="log-ok">></span> ${t('pm_analyzing') || '측정 완료 — 분석 중...'}`);

  try {
    const res = await fetch('/api/measure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'print_stop' })
    });
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || 'ESP32 error');

    appLog('logShaper', `<span class="log-ok">✓</span> X: ${d.segsX} segs, Y: ${d.segsY} segs`);

    // PSD
    await fetchAndRenderPsdDual(d);

    measPhase = 'done';
    setPrintMeasBtn('done');
    ledOn();

    // Keep the save-result CTA visible after a successful analysis pass.
    const savedFreqX = xAnalysis?.recommended?.performance?.freq || d.peakX;
    const savedFreqY = yAnalysis?.recommended?.performance?.freq || d.peakY;
    showSaveResultBtn(savedFreqX, savedFreqY);

  } catch(e) {
    // R9.1: stop - 'done'
    appLog('logShaper', `<span class="log-err">\u2717</span> ${_escLog(e.message)}`);
    appLog('logShaper', `<span class="log-err">!</span> 결과를 가져오지 못했습니다. [완료]를 다시 누르거나 측정을 재시작하세요.`);
    measPhase = 'done';  // 'idle' -
    setPrintMeasBtn('done');
    ledOn();
  }
}

// R13.10: - convergence 999 = " / "
const CONVERGENCE_NOT_READY = 999;

function startPrintPolling() {
  stopPrintPolling();
  let lastLog = Date.now();
  let autoNotified = false;
  let phase = 'init';  // init -> collecting -> converging -> ready

  printPollTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/measure/status');
      const d = await res.json();

      const segX = d.segCountX || 0;
      const segTotal = d.segTotal || 0;
      const cvX = d.convergenceX || CONVERGENCE_NOT_READY;
      const cvY = d.convergenceY || CONVERGENCE_NOT_READY;
      const corr = d.correlation || 0;
      const gr = d.gateRatio || 0;
      const cvMax = Math.max(cvX, cvY);

      //
      const pct = d.autoReady ? 100
                : cvMax >= CONVERGENCE_NOT_READY ? Math.min(20, Math.round(segX / 5))
                : cvMax > 3 ? 30 : cvMax > 1 ? 60 : 90;
      const progBar = document.getElementById('pmProgressBar');
      const progEl = document.getElementById('pmProgress');
      const segEl = document.getElementById('pmSegs');
      const minSegMsg = document.getElementById('pmMinSegMsg');
      if (progBar) progBar.style.width = `${pct}%`;
      if (progEl) progEl.textContent = `${pct}%`;
      if (segEl) segEl.textContent = `${segX} / ${segTotal}`;
      if (minSegMsg) minSegMsg.style.display = d.autoReady ? '' : 'none';

      // 5
      if (Date.now() - lastLog > 5000) {
        lastLog = Date.now();

        //
        const newPhase = segX < 10 ? 'init'
                       : cvMax >= CONVERGENCE_NOT_READY ? 'collecting'
                       : cvMax > 1 ? 'converging' : 'ready';
        const phaseChanged = newPhase !== phase;
        phase = newPhase;

        //
        const kin = typeof getCfgKin === 'function' ? getCfgKin() : 'corexy';
        const kinP = typeof getKinProfile === 'function' ? getKinProfile(kin) : null;

        if (phase === 'init') {
          appLog('logShaper', `<span class="log-ok">⏳</span> 데이터 수집 대기 중... 프린터가 움직이는지 확인하세요`);
          if (phaseChanged && kinP) {
            appLog('logShaper', `<span class="log-ok">ℹ</span> ${kinP.guide_ko || kinP.guide_en}`);
          }
        } else if (phase === 'collecting') {
          appLog('logShaper', `<span class="log-ok">📊</span> 수집 중 — ${segX}/${segTotal} segs (gate:${(gr*100).toFixed(0)}% corr:${(corr*100).toFixed(0)}%)`);
        } else if (phase === 'converging') {
          //
          const xConv = cvX < (kinP?.axes?.x?.convergenceHz || 1.0);
          const yConv = cvY < (kinP?.axes?.y?.convergenceHz || 1.5);
          const xIcon = xConv ? '✅' : '🔍';
          const yIcon = yConv ? '✅' : '🔍';
          appLog('logShaper', `<span class="log-ok">🔍</span> 수렴 중 — X${xIcon}±${cvX.toFixed(1)}Hz  Y${yIcon}±${cvY.toFixed(1)}Hz (gate:${(gr*100).toFixed(0)}%)`);

          // ( )
          if (phaseChanged && kinP) {
            const yAxis = kinP.axes?.y;
            if (yAxis?.sensing === 'indirect') {
              appLog('logShaper', `<span class="log-ok">ℹ</span> ${yAxis.desc_ko || yAxis.desc_en}`);
            }
          }
        } else {
          appLog('logShaper', `<span class="log-ok">🟢</span> 수렴 완료 — X±${cvX.toFixed(1)}Hz Y±${cvY.toFixed(1)}Hz`);
          if (phaseChanged) {
            appLog('logShaper', `<span class="log-ok">ℹ</span> [완료]를 눌러 결과를 확인하세요. 계속 수집하면 더 정밀해집니다.`);
          }
        }
      }

      //
      if (d.autoReady && !autoNotified) {
        autoNotified = true;
        appLog('logShaper', `<span class="log-ok">✅</span> 측정 품질 충분! [완료] 버튼을 눌러 결과를 확인하세요.`);
        const doneBtn = document.getElementById('btnPmDone');
        if (doneBtn) doneBtn.classList.add('btn-pulse');
      }
      // R8.2: consecutive-failure counter. Reset on success so a cumulative
      // 5-fail total spread across the session does not falsely stop polling;
      // only 5 failures in a row (never reset) trigger the bail-out.
      window._pollFailCount = 0;
    } catch(e) {
      window._pollFailCount = (window._pollFailCount || 0) + 1;
      if (window._pollFailCount > 5) {
        appLog('logShaper', `<span class="log-err">\u26A0</span> 상태 폴링 실패 반복 — 네트워크 확인: ${_escLog(e.message)}`);
        stopPrintPolling();
      }
    }
  }, 1000);
}

function stopPrintPolling() {
  if (printPollTimer) { clearInterval(printPollTimer); printPollTimer = null; }
  if (typeof window !== 'undefined') window._pollFailCount = 0;
}

// R20.29: ESP32 MEAS_PRINT
async function resumePrintMeasureIfActive() {
  try {
    const r = await fetch('/api/measure/status');
    if (!r.ok) return;
    const d = await r.json();
    if (d.state === 'print' || d.measState === 'print') {
      if (typeof setPrintMeasBtn === 'function') setPrintMeasBtn('running');
      startPrintPolling();
      appLog('logShaper', `<span class="log-ok">\u21BB</span> 측정 진행 중 — 폴링 재개 (seg: ${d.segCountX || 0})`);
    } else if (d.state === 'done' || d.measState === 'done') {
      if (typeof setPrintMeasBtn === 'function') setPrintMeasBtn('done');
    }
  } catch (e) { /*  device offline  */ }
}

function setPrintMeasBtn(phase) {
  const idle = document.getElementById('pmIdle');
  const running = document.getElementById('pmRunning');
  const result = document.getElementById('resultSection');

  if (idle) idle.style.display = (phase === 'idle' || phase === 'done') ? '' : 'none';
  if (running) running.style.display = (phase === 'running') ? '' : 'none';
  // : done +
  if (result && phase === 'done') result.style.display = '';
}
