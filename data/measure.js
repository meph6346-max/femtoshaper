// ============ FEMTO SHAPER Measure Engine v0.9 ============
// 측정 상태머신 + 폴링 — app.js에서 분리

// 측정 상태
let measPollTimer = null;
let measPhase = 'idle';

// ── ADXL345 상태 체크 → 상단 인디케이터 + 데모 모드 ──────
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
    // ESP32 자체 미연결 (오프라인 모드)
    adxlConnected = false;
    if (dot) dot.style.color = '#FF5252';
    if (label) label.textContent = t('adxl_esp_fail');
    if (statusEl) statusEl.className = 'ab-st adxl-fail';
    if (banner) { banner.style.display = 'block'; banner.textContent = '⚠ '+t('adxl_demo_msg'); }
  }
}


const APP_LOG_MAX = 100;

function appLog(id, html) {
  const el = document.getElementById(id);
  if (!el) return;
  const now = new Date();
  const ts = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}`;
  el.innerHTML += `<div><span style="color:var(--c-t3)">[${ts}]</span> ${html}</div>`;
  // 오래된 로그 제거 (메모리 관리)
  const divs = el.querySelectorAll ? el.querySelectorAll('div') : [];
  if (divs.length > APP_LOG_MAX) {
    const lines = el.innerHTML.split('</div>');
    el.innerHTML = lines.slice(-APP_LOG_MAX).join('</div>');
  }
  el.scrollTop = el.scrollHeight;
}

// ── 측정 버튼 상태 관리 ──────────────────────────────────


// v0.9: 수동 시작/전환 — 시그니처/스윕 대기 건너뛰기


// ── 메인 측정 함수 ───────────────────────────────────────


// ── X축 측정 시작 ────────────────────────────────────────


// ── Y축 측정 시작 ────────────────────────────────────────


// ── 측정 완료 ────────────────────────────────────────────


// ── 스윕 자동 종료 시 다음 단계 진행 ──


// ── 폴링: 수집 진행 상황 실시간 표시 ────────────────────






// ══════════════════════════════════════════════════════
// v1.0 Print Measure — 듀얼 DSP 기반
// "출력하면서 측정" = X/Y 동시 수집 + 자동 분석
// ══════════════════════════════════════════════════════

let printPollTimer = null;

async function startPrintMeasure() {
  // 캘리브레이션 체크
  try {
    const cfgRes = await fetch('/api/config');
    const cfg = await cfgRes.json();
    if (!cfg.useCalWeights) {
      appLog('logShaper', `<span class="log-err">✗</span> ${t('pm_cal_required') || '축 캘리브레이션이 필요합니다. 설정에서 캘리브레이션을 실행하세요.'}`);
      return;
    }
  } catch(e) {
    appLog('logShaper', `<span class="log-err">✗</span> ${t('log_conn_err')}${e.message}`);
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
        appLog('logShaper', `<span class="log-err">✗</span> ${t('pm_cal_required') || '캘리브레이션 필요'}`);
      } else {
        appLog('logShaper', `<span class="log-err">✗</span> ${d.error}`);
      }
      return;
    }

    measPhase = 'print';
    ledBlink();
    setPrintMeasBtn('running');
    appLog('logShaper', `<span class="log-ok">✓</span> ${t('pm_collecting') || '듀얼 수집 중... 출력을 계속하세요'}`);
    startPrintPolling();
  } catch(e) {
    appLog('logShaper', `<span class="log-err">✗</span> ${e.message}`);
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

    // 듀얼 PSD 분석
    await fetchAndRenderPsdDual(d);

    measPhase = 'done';
    setPrintMeasBtn('done');
    ledOn();

    // 결과 저장
    const savedFreqX = xAnalysis?.recommended?.performance?.freq || d.peakX;
    const savedFreqY = yAnalysis?.recommended?.performance?.freq || d.peakY;
    showSaveResultBtn(savedFreqX, savedFreqY);

  } catch(e) {
    appLog('logShaper', `<span class="log-err">✗</span> ${e.message}`);
    measPhase = 'idle';
    setPrintMeasBtn('idle');
    ledOn();
  }
}

function startPrintPolling() {
  stopPrintPolling();
  let lastLog = Date.now();
  let autoNotified = false;
  let phase = 'init';  // init → collecting → converging → ready

  printPollTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/measure/status');
      const d = await res.json();

      const segX = d.segCountX || 0;
      const segTotal = d.segTotal || 0;
      const cvX = d.convergenceX || 999;
      const cvY = d.convergenceY || 999;
      const corr = d.correlation || 0;
      const gr = d.gateRatio || 0;
      const cvMax = Math.max(cvX, cvY);

      // 진행바 — 수렴 기반
      const pct = cvMax >= 999 ? Math.min(20, Math.round(segX / 5))
                : cvMax > 3 ? 30 : cvMax > 1 ? 60 : 90;
      const progBar = document.getElementById('pmProgressBar');
      const progEl = document.getElementById('pmProgress');
      const segEl = document.getElementById('pmSegs');
      if (progBar) progBar.style.width = `${pct}%`;
      if (progEl) progEl.textContent = `${pct}%`;
      if (segEl) segEl.textContent = `${segX} / ${segTotal}`;

      // 5초마다 상태 로그
      if (Date.now() - lastLog > 5000) {
        lastLog = Date.now();

        // 상태 전환
        const newPhase = segX < 10 ? 'init'
                       : cvMax >= 999 ? 'collecting'
                       : cvMax > 1 ? 'converging' : 'ready';
        const phaseChanged = newPhase !== phase;
        phase = newPhase;

        // 키네마틱 프로파일
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
          // 축별 독립 수렴 상태
          const xConv = cvX < (kinP?.axes?.x?.convergenceHz || 1.0);
          const yConv = cvY < (kinP?.axes?.y?.convergenceHz || 1.5);
          const xIcon = xConv ? '✅' : '🔍';
          const yIcon = yConv ? '✅' : '🔍';
          appLog('logShaper', `<span class="log-ok">🔍</span> 수렴 중 — X${xIcon}±${cvX.toFixed(1)}Hz  Y${yIcon}±${cvY.toFixed(1)}Hz (gate:${(gr*100).toFixed(0)}%)`);

          // 간접 측정 축 안내 (한 번만)
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

      // 자동 완료 알림
      if (d.autoReady && !autoNotified) {
        autoNotified = true;
        appLog('logShaper', `<span class="log-ok">✅</span> 측정 품질 충분! [완료] 버튼을 눌러 결과를 확인하세요.`);
        const doneBtn = document.getElementById('btnPmDone');
        if (doneBtn) doneBtn.classList.add('btn-pulse');
      }
    } catch(e) {
      // R8.2: 폴링 오류를 사일런트로 무시하지 않고 5회 연속 실패 시 중단
      if (typeof _pollFailCount === 'undefined') window._pollFailCount = 0;
      window._pollFailCount = (window._pollFailCount || 0) + 1;
      if (window._pollFailCount > 5) {
        appLog('logShaper', `<span class="log-err">\u26A0</span> 상태 폴링 실패 반복 — 네트워크 확인: ${e.message}`);
        stopPrintPolling();
      }
    }
  }, 1000);
}

function stopPrintPolling() {
  if (printPollTimer) { clearInterval(printPollTimer); printPollTimer = null; }
  if (typeof window !== 'undefined') window._pollFailCount = 0;
}

// R20.29: 페이지 로드 시 ESP32가 MEAS_PRINT 상태면 폴링 자동 복원
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
  } catch (e) { /* device offline */ }
}

function setPrintMeasBtn(phase) {
  const idle = document.getElementById('pmIdle');
  const running = document.getElementById('pmRunning');
  const result = document.getElementById('resultSection');

  if (idle) idle.style.display = (phase === 'idle' || phase === 'done') ? '' : 'none';
  if (running) running.style.display = (phase === 'running') ? '' : 'none';
  // 결과 표시: done일 때 + 이미 데이터가 있으면
  if (result && phase === 'done') result.style.display = '';
}
