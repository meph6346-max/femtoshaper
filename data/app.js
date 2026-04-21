// ============ FEMTO SHAPER App v0.9 ============
// UI + 분석 + 초기화 (filter.js, measure.js에서 분리)

// ── 더미 PSD (DEMO_MODE 또는 복원 실패 시 fallback) ──
// ADXL 실측 환경에서는 사용하지 않음
const xPsdData   = genPSD(42.2, 1800, 50, 85);
const yPsdData   = genPSD(37.5, 2200, 60, 72);
const beltAData  = genPSD(48.1, 1600, 40, null);
const beltBData  = genPSD(46.9, 1500, 45, null);

// ── 전역 상태 ────────────────────────────────────────────
let lastShaperResult = null;
let xAnalysis = null, yAnalysis = null;
let adxlConnected = false; // ADXL345 connection state

// 실측 PSD 저장 (ESP32에서 받아온 데이터)
let realPsdX = null, realPsdY = null;
let peakFreqXGlobal = 0, peakFreqYGlobal = 0;
let psdPeakXGlobal = 0, psdPeakYGlobal = 0;  // v0.9: 차트 마커용 (PSD 실제 피크)

const TAB_IDS = ['shaper', 'diag', 'live', 'settings'];

function switchTab(id) {
  document.querySelectorAll('.tb .tab').forEach((tab, i) =>
    tab.classList.toggle('active', TAB_IDS[i] === id));
  document.querySelectorAll('.pg').forEach(p =>
    p.classList.toggle('active', p.id === 'pg-' + id));
  // 설정 하위 섹션 숨김 (탭 전환 시 잔류 방지)
  if (id !== 'settings') {
    const sl = document.getElementById('settingsLog');
    const ss = document.getElementById('settingsSystem');
    if (sl) sl.style.display = 'none';
    if (ss) ss.style.display = 'none';
  }
  if (id === 'live') initLive();
  if (id === 'diag') updateDiagOverview();
  // 쉐이퍼 탭 전환 시 PSD 그래프 redraw
  if (id === 'shaper') {
    setTimeout(() => {
      // rawPSD 표시 + 추천 freq 마커
      if (typeof realPsdX !== 'undefined' && realPsdX) {
        drawPSD('cX', realPsdX, peakFreqXGlobal || 0, '#2196F3');
      }
      if (typeof realPsdY !== 'undefined' && realPsdY) {
        drawPSD('cY', realPsdY, peakFreqYGlobal || 0, '#4CAF50');
      }
    }, 100);
  }
}

const SUBTAB_IDS = ['overview'];
function switchSubTab(id) {
  // v1.0: 서브탭 제거 — 단일 개요 페이지
}

// ══════════════════════════════════════════════════════
// v1.0 Print Measure 듀얼 PSD 분석
// /api/psd?mode=print → binsX + binsY 동시 처리
// ══════════════════════════════════════════════════════
async function fetchAndRenderPsdDual(measureMetrics) {
  try {
    const res = await fetch('/api/psd?mode=print');
    const d = await res.json();
    if (!d.binsX || !d.binsY || d.binsX.length === 0) {
      appLog('logShaper', `<span class="log-err">✗</span> ${t('pm_no_data') || 'PSD 데이터 없음'}`);
      return;
    }

    // rawPSD 저장
    realPsdX = d.binsX.map(b => ({ f: b.f, v: b.v, var: b.var || 0 }));
    realPsdX = d.binsX.map(b => ({ f: b.f, v: b.v, var: b.var || 0 }));
    realPsdY = d.binsY.map(b => ({ f: b.f, v: b.v, var: b.var || 0 }));

    // 배경 PSD
    const bgPsd = d.bgPsd || _bgPsdCache || null;
    if (d.bgPsd) _bgPsdCache = d.bgPsd;

    // 필터
    const filteredX = filterByBackground(realPsdX, bgPsd);
    const filteredY = filterByBackground(realPsdY, bgPsd);

    // v1.0 Phase 1: 팬 기여분 차감
    const cleanX = typeof filterFanPeaks === 'function' ? filterFanPeaks(filteredX) : filteredX;
    const cleanY = typeof filterFanPeaks === 'function' ? filterFanPeaks(filteredY) : filteredY;
    if ((_fanHotendPsd && _fanHotendPsd.length > 0) || (_fanPartsPsd && _fanPartsPsd.length > 0)) {
      const parts = [];
      if (_fanHotendPsd) parts.push('핫엔드팬');
      if (_fanPartsPsd) parts.push('파츠팬(' + _fanPartsSpeed + '%)');
      appLog('logShaper', `<span class="log-ok">🌀</span> 팬 차감: ${parts.join(' + ')}`);
    }

    // v1.0 통합 피크 검출 — 1번 실행, 모든 곳에서 사용
    const kin = typeof getCfgKin === 'function' ? getCfgKin() : 'corexy';
    const peaksX = typeof detectPeaks === 'function'
      ? detectPeaks(cleanX, { kin, axis: 'x' })
      : [];
    const peaksY = typeof detectPeaks === 'function'
      ? detectPeaks(cleanY, { kin, axis: 'y' })
      : [];

    let filtPeakX = (peaksX.length > 0 && !peaksX[0].isHarmonic && !peaksX[0].isFan)
      ? peaksX[0].f : (d.peakFreqX || 0);
    let filtPeakY = (peaksY.length > 0 && !peaksY[0].isHarmonic && !peaksY[0].isFan)
      ? peaksY[0].f : (d.peakFreqY || 0);

    // 가장 강한 비하모닉+비팬 피크를 1차 피크로
    for (const p of peaksX) { if (!p.isHarmonic && !p.isFan) { filtPeakX = p.f; break; } }
    for (const p of peaksY) { if (!p.isHarmonic && !p.isFan) { filtPeakY = p.f; break; } }

    // 피크 정보 로그
    appLog('logShaper', `<span class="log-ok">✓</span> X: ${filtPeakX.toFixed(1)}Hz (${peaksX.length}피크) Y: ${filtPeakY.toFixed(1)}Hz (${peaksY.length}피크)`);

    // 하모닉 로그
    for (const p of [...peaksX, ...peaksY]) {
      if (p.isHarmonic) {
        appLog('logShaper', `<span class="log-ok">🎵</span> ${p.f.toFixed(0)}Hz = ${p.harmonicOf.toFixed(0)}Hz의 ${p.harmonicOrder}차 하모닉`);
      }
    }
    // 인접 피크 로그
    for (const p of peaksX) {
      if (p.adjacentPeak && p.secondPeak) {
        appLog('logShaper', `<span class="log-ok">🔍</span> X 인접피크: ${p.f.toFixed(1)}Hz + ${p.secondPeak.freq.toFixed(1)}Hz`);
      }
    }
    // 팬 지배 빈 로그
    const fanDom = [...peaksX, ...peaksY].filter(p => p.isFan);
    const quality = measureMetrics || {};
    if (fanDom.length > 0) {
      appLog('logShaper', `<span class="log-ok">🌀</span> 팬 지배 피크: ${fanDom.map(p => p.f.toFixed(0)+'Hz').join(', ')} (쉐이퍼 제외)`);
    }
    // 에너지 게이팅 품질
    if (d.gateRatio !== undefined) {
      const gr = (d.gateRatio * 100).toFixed(0);
      const icon = d.gateRatio > 0.3 ? '✅' : d.gateRatio > 0.1 ? '🟡' : '⚠';
      appLog('logShaper', `<span class="log-ok">${icon}</span> ${t('pm_gate') || '유효 세그먼트'}: ${d.segCountX}/${d.segTotal} (${gr}%)`);
    }
    // 피크 수렴도
    if (d.convergenceX !== undefined && d.convergenceX < 999) {
      const cvOk = d.convergenceX < 1.0 && d.convergenceY < 1.0;
      appLog('logShaper', `<span class="log-ok">${cvOk?'✅':'🟡'}</span> ${t('pm_conv') || '피크 수렴'}: X ±${d.convergenceX.toFixed(1)}Hz, Y ±${d.convergenceY.toFixed(1)}Hz`);
    }
    // X/Y 분리 품질 (ESP32 교차 상관)
    if (d.correlation !== undefined) {
      const corr = d.correlation;
      const sep = corr < 0.5 ? '✅' : corr < 0.8 ? '🟡' : '⚠';
      appLog('logShaper', `<span class="log-ok">${sep}</span> ${t('pm_corr') || 'X/Y 분리도'}: ${(100-corr*100).toFixed(0)}% (corr=${(corr*100).toFixed(0)}%)`);
    }

    // v1.0: 리포트용 메트릭 캐시
    _lastCorrelation = (measureMetrics && measureMetrics.correlation) || 0;
    _lastGateRatio = (measureMetrics && measureMetrics.gateRatio) || 0;
    _lastConvergenceX = (measureMetrics && measureMetrics.convergenceX) || 0;
    _lastConvergenceY = (measureMetrics && measureMetrics.convergenceY) || 0;
    _lastSegTotal = (measureMetrics && measureMetrics.segTotal) || 0;
    _lastSegActive = (measureMetrics && (measureMetrics.segCountX || measureMetrics.segsX)) || 0;

    // 쉐이퍼 분석 (통합 피크 전달)
    xAnalysis = analyzeShaper(cleanX, filtPeakX, null, peaksX);
    yAnalysis = analyzeShaper(cleanY, filtPeakY, null, peaksY);

    // 통합 피크 결과를 분석에 첨부
    xAnalysis._peaks = peaksX;
    yAnalysis._peaks = peaksY;
    xAnalysis._harmonics = peaksX.filter(p => p.isHarmonic);
    yAnalysis._harmonics = peaksY.filter(p => p.isHarmonic);

    // X/Y 분리 검증: ESP32 상관계수 사용 (위에서 이미 표시)

    // UI 업데이트
    peakFreqXGlobal = filtPeakX;
    peakFreqYGlobal = filtPeakY;
    updateShaperUI(filtPeakX, filtPeakY, xAnalysis, yAnalysis, realPsdX, realPsdY);

    // 진단 (팬 차감된 PSD + 통합 피크 사용)
    if (typeof runDiagStage1 === 'function') {
      runDiagStage1(cleanX, cleanY, filtPeakX, filtPeakY);
      // 통합 피크를 diagState에 첨부
      if (typeof diagState !== 'undefined') {
        diagState._unifiedPeaksX = peaksX;
        diagState._unifiedPeaksY = peaksY;
      }
    }

    // 결과 캐시
    lastShaperResult = {
      x: { primary: { freq: filtPeakX, power: d.peakPowerX || 0 } },
      y: { primary: { freq: filtPeakY, power: d.peakPowerY || 0 } },
      snrDb: xAnalysis.snrDb || 0,
      confidence: Math.min(xAnalysis.confidence||0, yAnalysis.confidence||0),
      psdBins: realPsdX,
      psdBinsY: realPsdY,
      mode: 'print',
      segsX: (measureMetrics && (measureMetrics.segCountX ?? measureMetrics.segsX)) || 0,
      segsY: (measureMetrics && (measureMetrics.segCountY ?? measureMetrics.segsY)) || 0,
    };

    // v1.0: 최종 판정 엔진
    let verdict = null;
    if (typeof validateResult === 'function') {
      verdict = validateResult({
        calibrated: true,  // PM 시작 시 이미 체크됨
        gateRatio: d.gateRatio || 0,
        correlation: d.correlation || 0,
        convergenceX: d.convergenceX || 99,
        convergenceY: d.convergenceY || 99,
        activeSegs: d.segCountX || 0,
        segTotal: d.segTotal || 0,
        gateRatio: (measureMetrics && measureMetrics.gateRatio) || 0,
        correlation: (measureMetrics && measureMetrics.correlation) || 0,
        convergenceX: (measureMetrics && measureMetrics.convergenceX) || 99,
        convergenceY: (measureMetrics && measureMetrics.convergenceY) || 99,
        activeSegs: (measureMetrics && (measureMetrics.segCountX ?? measureMetrics.segsX)) || 0,
        segTotal: (measureMetrics && measureMetrics.segTotal) || 0,
        xAnalysis, yAnalysis,
        peaksX, peaksY
      });
      lastShaperResult.verdict = verdict;

      // 판정 로그
      const vl = typeof verdictLabel === 'function' ? verdictLabel(verdict.verdict) : { icon:'?', text:'?' };
      const mqPct = (verdict.mq.score * 100).toFixed(0);
      const rcPct = (verdict.rc.score * 100).toFixed(0);
      appLog('logShaper', `<span class="log-ok">${vl.icon}</span> 판정: <b>${vl.text}</b> (측정품질 ${mqPct}% / 결과신뢰 ${rcPct}%)`);

      // 이슈 로그 (warn 이상만)
      const allIssues = [].concat(verdict.mq.issues || [], verdict.rc.issues || []);
      for (const iss of allIssues) {
        if (iss.severity === 'warn' || iss.severity === 'critical') {
          const icon = iss.severity === 'critical' ? '❌' : '⚠';
          appLog('logShaper', `<span class="log-ok">${icon}</span> ${iss.ko}`);
        }
      }

      // Apply 버튼 상태
      const applyBtn = document.getElementById('btnApply');
      if (applyBtn) {
        if (verdict.verdict === 'retry') {
          applyBtn.disabled = true;
          applyBtn.title = verdict.reason_ko;
        } else {
          applyBtn.disabled = false;
          applyBtn.title = '';
        }
      }
    }

    const maxAccel = Math.min(
      xAnalysis.recommended?.performance?.maxAccel || 0,
      yAnalysis.recommended?.performance?.maxAccel || 0
    );
    appLog('logShaper', `<span class="log-ok">✓</span> ${t('log_recommend')} X:${xAnalysis.recommended?.performance?.name||'?'}@${(xAnalysis.recommended?.performance?.freq||0).toFixed(1)}Hz Y:${yAnalysis.recommended?.performance?.name||'?'}@${(yAnalysis.recommended?.performance?.freq||0).toFixed(1)}Hz maxAccel:${maxAccel.toLocaleString()}`);

    // NVS 저장 데이터 준비
    _lastResultForSave = {
      freqX: filtPeakX,
      freqY: filtPeakY,
      shaperTypeX: (xAnalysis.recommended?.performance?.name || 'mzv').toLowerCase(),
      shaperTypeY: (yAnalysis.recommended?.performance?.name || 'mzv').toLowerCase(),
      shaperType: (xAnalysis.recommended?.performance?.name || 'mzv').toLowerCase(),
      confidence: Math.min(xAnalysis.confidence || 0, yAnalysis.confidence || 0),
    };
    showSaveResultBtn(true);

  } catch(e) {
    appLog('logShaper', `<span class="log-err">✗</span> ${t('pm_analysis_err') || '분석 실패'}: ${e.message}`);
  }
}



function updateShaperUI(peakX, peakY, xAn, yAn, psdX, psdY) {
  // null/undefined 방어
  peakX = peakX || 0;
  peakY = peakY || 0;
  if (!xAn) return;
  if (!yAn) yAn = xAn;
  // 결과 섹션 표시
  const rs = document.getElementById('resultSection');
  if (rs) rs.style.display = '';
  // 빈 그래프 안내 숨기기
  const emX = document.getElementById('cXEmpty');
  const emY = document.getElementById('cYEmpty');
  if (emX) emX.style.display = 'none';
  if (emY) emY.style.display = 'none';

  // 요약 그리드 — 피크 위치 + 추천 결과
  const xRec = xAn.recommended?.performance || { name: '—', freq: 0, maxAccel: 0 };
  const yRec = yAn?.recommended?.performance || { name: '—', freq: 0, maxAccel: 0 };
  const xCI = xAn.freqCI;
  const yCI = yAn?.freqCI;
  document.getElementById('vPeakX').textContent = xCI
    ? `${peakX.toFixed(1)} ±${xCI.sigma.toFixed(1)} Hz` : `${peakX.toFixed(1)} Hz`;
  document.getElementById('vPeakY').textContent = yCI
    ? `${peakY.toFixed(1)} ±${yCI.sigma.toFixed(1)} Hz` : `${peakY.toFixed(1)} Hz`;
  const xShaperName = xRec.name;
  const yShaperName = yRec.name;
  document.getElementById('vShaper').textContent   = xShaperName === yShaperName
    ? xShaperName : `X:${xShaperName} Y:${yShaperName}`;
  const safeMaxAccel = Math.min(xRec.maxAccel, yRec.maxAccel);
  document.getElementById('vMaxAccel').textContent = safeMaxAccel > 0 ? safeMaxAccel.toLocaleString() + ' mm/s²' : '—';

  // 결과 칩
  const rcX = document.getElementById('rcX');
  const rcY = document.getElementById('rcY');
  const xFitTag = xAn.fitQuality > 0.8 ? ' ●' : xAn.fitQuality > 0.5 ? ' ◐' : '';
  const yFitTag = yAn.fitQuality > 0.8 ? ' ●' : yAn.fitQuality > 0.5 ? ' ◐' : '';
  if (rcX) {
    const xPeaks = (xAn.multiPeak?.peaks || []).slice(1).map(p => p.freq.toFixed(0)+'Hz').join('+');
    rcX.textContent = `Peak: ${peakX.toFixed(1)}Hz${xPeaks ? ' +'+xPeaks : ''} → ${xShaperName}${xFitTag}`;
  }
  if (rcY) {
    const yPeaks = (yAn?.multiPeak?.peaks || []).slice(1).map(p => p.freq.toFixed(0)+'Hz').join('+');
    rcY.textContent = `Peak: ${peakY.toFixed(1)}Hz${yPeaks ? ' +'+yPeaks : ''} → ${yShaperName}${yFitTag}`;
  }

  // v1.0: 판정 기반 표시
  const confEl = document.getElementById('vConf');
  const warnEl = document.getElementById('lowConfWarn');
  const vd = lastShaperResult?.verdict;
  if (confEl && vd) {
    const vl = typeof verdictLabel === 'function' ? verdictLabel(vd.verdict) : { icon:'', text:'?', color:'#888' };
    const pct = (vd.overallScore * 100).toFixed(0);
    confEl.textContent = `${vl.icon} ${vl.text} (${pct}%)`;
    confEl.style.color = vl.color;
    confEl.className = vd.verdict === 'apply' ? 'c-suc' : vd.verdict === 'review' ? 'c-wrn' : 'c-err';

    if (warnEl) {
      if (vd.verdict === 'retry') {
        warnEl.style.display = 'block';
        warnEl.textContent = '❌ ' + vd.reason_ko;
        warnEl.className = 'chip chip-err';
      } else if (vd.verdict === 'review') {
        warnEl.style.display = 'block';
        warnEl.textContent = '⚠ ' + vd.reason_ko;
        warnEl.className = 'chip chip-wrn';
      } else {
        warnEl.style.display = 'none';
      }
    }
  } else if (confEl && xAn.confidence !== undefined) {
    // 폴백: 판정 없으면 기존 confidence 표시
    const c = Math.min(xAn.confidence, yAn.confidence ?? xAn.confidence);
    confEl.textContent = `${(c * 100).toFixed(0)}%`;
    confEl.className = c >= 0.8 ? 'c-suc' : c >= 0.5 ? 'c-wrn' : 'c-err';
    if (warnEl) warnEl.style.display = 'none';
  }

  // PSD 차트 — rawPSD 표시, 마커 = 피크 위치
  const pd = psdX || xPsdData;
  const yd = psdY || yPsdData;

  // v1.0: 사용자 accel 기반 실용 정보
  const practEl = document.getElementById('practicalInfo');
  const prac = xAn.practical;
  if (practEl && prac && prac.userAccel > 0 && prac.rec) {
    const ko = typeof curLang !== 'undefined' && curLang === 'ko';
    const r = prac.rec;
    let html = '';

    // 추천 범위
    if (r.status === 'retry') {
      html += `<span style="color:#BF616A">🔄</span> <b>${ko?'재측정 권장':'Re-measurement recommended'}</b><br>`;
      html += `${ko?'maxAccel이 너무 낮습니다. 센서 부착 상태를 확인하고 다시 측정하세요.':'maxAccel too low. Check sensor and re-measure.'}`;
    } else {
      html += `<b>${ko?'📊 추천 설정':'📊 Recommended Settings'}</b><br>`;
      html += `${ko?'가속도':'Accel'}: <b>${r.accelMin.toLocaleString()} ~ ${r.accelMax.toLocaleString()}</b> mm/s²`;
      html += ` · ${ko?'속도':'Speed'}: <b>${r.speedMin} ~ ${r.speedMax}</b> mm/s<br>`;

      // 현재 설정과 비교
      if (r.status === 'headroom') {
        html += `<span style="color:#A3BE8C">✅</span> ${ko?'현재':'Current'} ${prac.userAccel.toLocaleString()}mm/s² / ${prac.userFeed}mm/s — ${ko?'여유 있음, 가속도를 올려도 됩니다':'Headroom available, can increase accel'}`;
      } else if (r.status === 'over') {
        html += `<span style="color:#EBCB8B">⚠</span> ${ko?'현재 가속도':'Current accel'} ${prac.userAccel.toLocaleString()} > ${ko?'추천 최대':'rec max'} ${r.accelMax.toLocaleString()} — <b>${ko?'가속도를 낮추세요':'Reduce accel'}</b>`;
      } else {
        html += `<span style="color:#88C0D0">ℹ</span> ${ko?'현재':'Current'} ${prac.userAccel.toLocaleString()}mm/s² / ${prac.userFeed}mm/s — ${ko?'적절하지만 여유 적음':'OK but tight margin'}`;
      }
    }

    practEl.innerHTML = html;
    practEl.style.display = '';
  } else if (practEl) {
    practEl.style.display = 'none';
  }
  // 멀티피크 마커 (최대 5개: 🔴🟠🟡🟢🟣)
  const xExtra = (xAn.multiPeak?.peaks || []).slice(1).map(p => p.freq);
  const yExtra = (yAn?.multiPeak?.peaks || []).slice(1).map(p => p.freq);
  drawPSD('cX', pd, peakX, '#2196F3', xExtra);
  drawPSD('cY', yd, peakY, '#4CAF50', yExtra);

  // 쉐이퍼 테이블
  shaperTable('slX', xAn);
  shaperTable('slY', yAn);

  // 추천 요약 (safe 포함)
  renderRecommendation('recX', xAn);
  renderRecommendation('recY', yAn);

  // Apply 다이얼로그 필드 — X/Y 독립 쉐이퍼
  const apFx = document.getElementById('apFreqX');
  const apFy = document.getElementById('apFreqY');
  const apShX = document.getElementById('apShaperX');
  const apShY = document.getElementById('apShaperY');
  if (apFx) apFx.value = xAn.recommended.performance.freq.toFixed(1);
  if (apFy) apFy.value = yAn.recommended.performance.freq.toFixed(1);
  if (apShX) apShX.value = xShaperName.toLowerCase();
  if (apShY) apShY.value = yShaperName.toLowerCase();
  updateApplyPreview();
}

function toggleApplyPanel() {
  const panel = document.getElementById('applyPanel');
  panel.classList.toggle('open');
  if (panel.classList.contains('open')) updateApplyPreview();
}

function updateApplyPreview() {
  const freqX    = parseFloat(document.getElementById('apFreqX')?.value) || 0;
  const freqY    = parseFloat(document.getElementById('apFreqY')?.value) || 0;
  const shaperX  = document.getElementById('apShaperX')?.value || 'mzv';
  const shaperY  = document.getElementById('apShaperY')?.value || 'mzv';
  const damping  = parseFloat(document.getElementById('apDamping')?.value) || 0.1;
  const firmware = document.getElementById('s_firmware')?.value || 'marlin_is';
  const eeprom   = document.getElementById('s_eepromSave')?.value === 'yes';

  const gcode = generateApplyGcode({ firmware, freqX, freqY, shaperTypeX: shaperX, shaperTypeY: shaperY, damping, saveToEeprom: eeprom, confidence: lastShaperResult?.confidence || 0 });
  const pre = document.getElementById('apPreview');
  if (pre) pre.textContent = gcode;
}


function downloadApply() {
  const freqX    = parseFloat(document.getElementById('apFreqX')?.value) || 0;
  const freqY    = parseFloat(document.getElementById('apFreqY')?.value) || 0;
  const shaperX  = document.getElementById('apShaperX')?.value || 'mzv';
  const shaperY  = document.getElementById('apShaperY')?.value || 'mzv';
  const damping  = parseFloat(document.getElementById('apDamping')?.value) || 0.1;
  const firmware = document.getElementById('s_firmware')?.value || 'marlin_is';
  const eeprom   = document.getElementById('s_eepromSave')?.value === 'yes';
  const gcode    = generateApplyGcode({ firmware, freqX, freqY, shaperTypeX: shaperX, shaperTypeY: shaperY, damping, saveToEeprom: eeprom, confidence: 0 });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([gcode], { type: 'text/plain' }));
  a.download = `femto_apply_X${shaperX}_Y${shaperY}.gcode`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function copyApply() {
  navigator.clipboard.writeText(document.getElementById('apPreview')?.textContent || '').catch(e => console.warn('API:', e.message));
  appLog('logShaper', `<span class="log-ok">✓</span> ${t('log_applied')}`);
}

let _lastResultForSave = null;

function showSaveResultBtn(show) {
  const el = document.getElementById('btnSaveResult');
  if (el) el.style.display = show ? 'inline-flex' : 'none';
  const st = document.getElementById('resultSaveStatus');
  if (st) st.style.display = 'none';
}

async function doSaveResult() {
  if (!_lastResultForSave) return;
  const st = document.getElementById('resultSaveStatus');
  if (st) { st.textContent = t('result_saving'); st.className = 'save-msg save-pending'; st.style.display = 'block'; }
  try {
    const r = await fetch('/api/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(_lastResultForSave)
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (st) { st.textContent = '✓ '+t('result_save_ok'); st.className = 'save-msg save-ok'; }
    appLog('logShaper', `<span class="log-ok">✓</span> ${t('log_nvs_ok')}`);
  } catch(e) {
    if (st) { st.textContent = '✗ '+t('result_save_fail')+e.message; st.className = 'save-msg save-err'; }
    appLog('logShaper', `<span class="log-err">✗</span> ${t('log_nvs_fail')}${e.message}`);
  }
  setTimeout(() => { if (st) st.style.display = 'none'; }, 4000);
}

// saveResultToESP: 제거됨 (dead code)

function loadResultFromESP() {
  fetch('/api/result')
    .then(r => r.json())
    .then(async (data) => {
      if (!data.hasResult) return;
      const peakX = data.freqX, peakY = data.freqY;
      peakFreqXGlobal = peakX; peakFreqYGlobal = peakY;

      // ESP32에서 듀얼 PSD 복원 시도
      let liveBgPsd = null;
      try {
        const res = await fetch('/api/psd?mode=print');
        const d = await res.json();
        if (d.binsX && d.binsX.length > 0) {
          realPsdX = d.binsX.map(b => typeof b === 'object' ? b : null).filter(Boolean);
          if (realPsdX.length === 0) {
            // flat array 형식 → {f,v} 변환
            realPsdX = d.binsX.map((v, i) => ({f: (i + 6) * (d.freqRes || 3.125), v: typeof v === 'number' ? v : v.v || 0}));
          }
        }
        if (d.binsY && d.binsY.length > 0) {
          realPsdY = d.binsY.map(b => typeof b === 'object' ? b : null).filter(Boolean);
          if (realPsdY.length === 0) {
            realPsdY = d.binsY.map((v, i) => ({f: (i + 6) * (d.freqRes || 3.125), v: typeof v === 'number' ? v : v.v || 0}));
          }
        }
        if (d.bgPsd && d.bgPsd.length > 0) { liveBgPsd = d.bgPsd; _bgPsdCache = d.bgPsd; }
      } catch(e) {
        // 듀얼 실패 시 단축 시도
        try {
          const yRes = await fetch('/api/psd');
          const yD = await yRes.json();
          if (yD.bins && yD.bins.length > 0) realPsdY = yD.bins.map(b => ({f:b.f, v:b.v}));
          if (yD.bgPsd && yD.bgPsd.length > 0) { liveBgPsd = yD.bgPsd; _bgPsdCache = yD.bgPsd; }
        } catch(e2) {}
      }

      const pX = realPsdX || xPsdData;
      const pY = realPsdY || yPsdData;

      // 필터 + 통합 피크
      const bgPsd = liveBgPsd || _bgPsdCache || null;
      const fX = filterFanPeaks(filterByBackground(pX, bgPsd));
      const fY = filterFanPeaks(filterByBackground(pY, bgPsd));
      const kin = typeof getCfgKin === 'function' ? getCfgKin() : 'corexy';
      const peaksX = detectPeaks(fX, {kin, axis:'x'});
      const peaksY = detectPeaks(fY, {kin, axis:'y'});

      xAnalysis = analyzeShaper(fX, peakX, null, peaksX);
      yAnalysis = analyzeShaper(fY, peakY, null, peaksY);
      xAnalysis._peaks = peaksX; yAnalysis._peaks = peaksY;
      updateShaperUI(peakX, peakY, xAnalysis, yAnalysis, pX, pY);
      const xSec2 = xAnalysis?.multiPeak?.peaks?.[1] || null;
      const ySec2 = yAnalysis?.multiPeak?.peaks?.[1] || null;
      lastShaperResult = {
        x: { primary: { freq: peakX }, secondary: xSec2 ? { freq: xSec2.freq } : null },
        y: { primary: { freq: peakY }, secondary: ySec2 ? { freq: ySec2.freq } : null },
        primary:   { freq: peakX },
        secondary: xSec2 ? { freq: xSec2.freq } : null,
        confidence: Math.min(xAnalysis.confidence, yAnalysis.confidence),
        restored:  true,
        phasePeaks: {},
      };
      runDiagStage1(fX, fY, peakX, peakY);
      const srcNote = realPsdX ? '' : t('log_psd_note');      appLog('logShaper',
        `<span class="log-ok">✓</span> ${t('log_restored')}` +
        `X:<span class="log-val">${peakX.toFixed(1)}Hz</span> ` +
        `Y:<span class="log-val">${peakY.toFixed(1)}Hz</span>${srcNote}`
      );
    }).catch(e => console.warn('API:', e.message));
}



// ══════════════════════════════════════════════════════════
// 앱 초기화
// ══════════════════════════════════════════════════════════

function initApp() {
  setLang(curLang);
  loadSettings();  // 내부에서 /api/config 1회 fetch → 온보딩도 여기서 처리

  // 부팅 캡처된 배경 PSD 로드 (필터에 사용)
  function loadBgPsd(retryCount) {
    fetch('/api/noise').then(r=>r.json()).then(d=>{
      if(d.valid && d.bins && d.bins.length>0){
        _bgPsdCache = d.bins.map(b=>b.v);
      } else if (retryCount < 3) {
        // 부팅 캡처 미완료 → 3초 후 재시도
        setTimeout(() => loadBgPsd(retryCount + 1), 3000);
      }
    }).catch(()=>{
      if (retryCount < 3) setTimeout(() => loadBgPsd(retryCount + 1), 3000);
    }).finally(()=>{
      if (retryCount === 0) loadResultFromESP();  // 첫 시도 후 즉시 결과 복원
    });
  }
  loadBgPsd(0);


  // ADXL345 상태 확인 → 상단 인디케이터 + 데모 모드 자동 전환
  checkAdxlStatus();

  // 초기 차트
  setTimeout(() => {
    // loadResultFromESP가 이미 결과를 복원했으면 덮어쓰지 않음
    if (peakFreqXGlobal > 0 || peakFreqYGlobal > 0) return;

    if (!adxlConnected) {
      // ADXL 미연결 → 데모 데이터 자동 표시
      xAnalysis = analyzeShaper(xPsdData, 42.2, null);
      yAnalysis = analyzeShaper(yPsdData, 37.5, null);
      drawPSD('cX', xPsdData, 42.2, '#2196F3');
      drawPSD('cY', yPsdData, 37.5, '#4CAF50');
      updateShaperUI(42.2, 37.5, xAnalysis, yAnalysis, xPsdData, yPsdData);
    } else {
      drawPSD('cX', [], 0, '#2196F3');
      drawPSD('cY', [], 0, '#4CAF50');
    }
    shaperTable('slX', xAnalysis);
    shaperTable('slY', yAnalysis);
    renderRecommendation('recX', xAnalysis);
    renderRecommendation('recY', yAnalysis);
    document.getElementById('vPeakX').textContent    = '— Hz';
    document.getElementById('vPeakY').textContent    = '— Hz';
    document.getElementById('vShaper').textContent   = '—';
    document.getElementById('vMaxAccel').textContent = '—';
    updateAllPcb?.();
    if(typeof setPrintMeasBtn==='function')setPrintMeasBtn('idle');
  }, 500);

  window.addEventListener('resize', () => {
    const pX = realPsdX || xPsdData;
    const pY = realPsdY || yPsdData;
    const pkX = peakFreqXGlobal || 42.2;
    const pkY = peakFreqYGlobal || 37.5;
    drawPSD('cX', pX, pkX, '#2196F3');
    drawPSD('cY', pY, pkY, '#4CAF50');
  });
}

document.addEventListener('DOMContentLoaded', initApp);
