// ============ FEMTO SHAPER App v0.9 ============
// UI + 遺꾩꽍 + 珥덇린??(filter.js, measure.js?먯꽌 遺꾨━)

// ?? ?붾? PSD (DEMO_MODE ?먮뒗 蹂듭썝 ?ㅽ뙣 ??fallback) ??
// ADXL ?ㅼ륫 ?섍꼍?먯꽌???ъ슜?섏? ?딆쓬
const xPsdData   = genPSD(42.2, 1800, 50, 85);
const yPsdData   = genPSD(37.5, 2200, 60, 72);
const beltAData  = genPSD(48.1, 1600, 40, null);
const beltBData  = genPSD(46.9, 1500, 45, null);

// ?? ?꾩뿭 ?곹깭 ????????????????????????????????????????????
let lastShaperResult = null;
let xAnalysis = null, yAnalysis = null;
let adxlConnected = false; // ADXL345 connection state

// ?ㅼ륫 PSD ???(ESP32?먯꽌 諛쏆븘???곗씠??
let realPsdX = null, realPsdY = null;
let peakFreqXGlobal = 0, peakFreqYGlobal = 0;
let psdPeakXGlobal = 0, psdPeakYGlobal = 0;  // v0.9: 李⑦듃 留덉빱??(PSD ?ㅼ젣 ?쇳겕)

const TAB_IDS = ['shaper', 'diag', 'live', 'settings'];

function switchTab(id) {
  document.querySelectorAll('.tb .tab').forEach((tab, i) =>
    tab.classList.toggle('active', TAB_IDS[i] === id));
  document.querySelectorAll('.pg').forEach(p =>
    p.classList.toggle('active', p.id === 'pg-' + id));
  // ?ㅼ젙 ?섏쐞 ?뱀뀡 ?④? (???꾪솚 ???붾쪟 諛⑹?)
  if (id !== 'settings') {
    const sl = document.getElementById('settingsLog');
    const ss = document.getElementById('settingsSystem');
    if (sl) sl.style.display = 'none';
    if (ss) ss.style.display = 'none';
  }
  if (id === 'live') initLive();
  if (id === 'diag') updateDiagOverview();
  // ?먯씠?????꾪솚 ??PSD 洹몃옒??redraw
  if (id === 'shaper') {
    setTimeout(() => {
      // rawPSD ?쒖떆 + 異붿쿇 freq 留덉빱
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
  // v1.0: ?쒕툕???쒓굅 ???⑥씪 媛쒖슂 ?섏씠吏
}

// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧
// v1.0 Print Measure ???PSD 遺꾩꽍
// /api/psd?mode=print ??binsX + binsY ?숈떆 泥섎━
// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧
async function fetchAndRenderPsdDual(measureMetrics) {
  try {
    const res = await fetch('/api/psd?mode=print');
    const d = await res.json();
    if (!d.binsX || !d.binsY || d.binsX.length === 0) {
      appLog('logShaper', `<span class="log-err">X</span> ${t('pm_no_data') || 'PSD data unavailable'}`);
      return;
    }

    realPsdX = d.binsX.map(b => ({ f: b.f, v: b.v, var: b.var || 0 }));
    realPsdY = d.binsY.map(b => ({ f: b.f, v: b.v, var: b.var || 0 }));

    const bgPsd = d.bgPsd || _bgPsdCache || null;
    if (d.bgPsd) _bgPsdCache = d.bgPsd;

    const filteredX = filterByBackground(realPsdX, bgPsd);
    const filteredY = filterByBackground(realPsdY, bgPsd);
    const cleanX = typeof filterFanPeaks === 'function' ? filterFanPeaks(filteredX) : filteredX;
    const cleanY = typeof filterFanPeaks === 'function' ? filterFanPeaks(filteredY) : filteredY;

    if ((_fanHotendPsd && _fanHotendPsd.length > 0) || (_fanPartsPsd && _fanPartsPsd.length > 0)) {
      const parts = [];
      if (_fanHotendPsd) parts.push('hotend fan');
      if (_fanPartsPsd) parts.push(`part fan (${_fanPartsSpeed}%)`);
      appLog('logShaper', `<span class="log-ok">OK</span> Fan compensation: ${parts.join(' + ')}`);
    }

    const kin = typeof getCfgKin === 'function' ? getCfgKin() : 'corexy';
    const peaksX = typeof detectPeaks === 'function' ? detectPeaks(cleanX, { kin, axis: 'x' }) : [];
    const peaksY = typeof detectPeaks === 'function' ? detectPeaks(cleanY, { kin, axis: 'y' }) : [];

    let filtPeakX = (peaksX.length > 0 && !peaksX[0].isHarmonic && !peaksX[0].isFan) ? peaksX[0].f : (d.peakFreqX || 0);
    let filtPeakY = (peaksY.length > 0 && !peaksY[0].isHarmonic && !peaksY[0].isFan) ? peaksY[0].f : (d.peakFreqY || 0);
    for (const p of peaksX) {
      if (!p.isHarmonic && !p.isFan) {
        filtPeakX = p.f;
        break;
      }
    }
    for (const p of peaksY) {
      if (!p.isHarmonic && !p.isFan) {
        filtPeakY = p.f;
        break;
      }
    }

    appLog('logShaper', `<span class="log-ok">OK</span> X: ${filtPeakX.toFixed(1)}Hz (${peaksX.length} peaks) Y: ${filtPeakY.toFixed(1)}Hz (${peaksY.length} peaks)`);

    for (const p of [...peaksX, ...peaksY]) {
      if (p.isHarmonic) {
        appLog('logShaper', `<span class="log-ok">H</span> ${p.f.toFixed(0)}Hz = ${p.harmonicOf.toFixed(0)}Hz x${p.harmonicOrder}`);
      }
    }
    for (const p of peaksX) {
      if (p.adjacentPeak && p.secondPeak) {
        appLog('logShaper', `<span class="log-ok">N</span> X adjacent peak: ${p.f.toFixed(1)}Hz + ${p.secondPeak.freq.toFixed(1)}Hz`);
      }
    }

    const quality = measureMetrics || d || {};
    const fanDom = [...peaksX, ...peaksY].filter(p => p.isFan);
    if (fanDom.length > 0) {
      appLog('logShaper', `<span class="log-ok">F</span> Fan-dominant peaks: ${fanDom.map(p => `${p.f.toFixed(0)}Hz`).join(', ')} (excluded from axis picks)`);
    }
    if (quality.gateRatio !== undefined) {
      const gr = (quality.gateRatio * 100).toFixed(0);
      const icon = quality.gateRatio > 0.3 ? 'OK' : quality.gateRatio > 0.1 ? 'W' : '!';
      appLog('logShaper', `<span class="log-ok">${icon}</span> ${t('pm_gate') || 'Effective segments'}: ${(quality.segCountX ?? quality.segsX ?? 0)}/${quality.segTotal ?? 0} (${gr}%)`);
    }
    if (quality.convergenceX !== undefined && quality.convergenceX < 999) {
      const cvOk = quality.convergenceX < 1.0 && quality.convergenceY < 1.0;
      appLog('logShaper', `<span class="log-ok">${cvOk ? 'OK' : 'W'}</span> ${t('pm_conv') || 'Peak convergence'}: X ±${quality.convergenceX.toFixed(1)}Hz, Y ±${quality.convergenceY.toFixed(1)}Hz`);
    }
    if (quality.correlation !== undefined) {
      const corr = quality.correlation;
      const sep = corr < 0.5 ? 'OK' : corr < 0.8 ? 'W' : '!';
      appLog('logShaper', `<span class="log-ok">${sep}</span> ${t('pm_corr') || 'X/Y separation'}: ${(100 - corr * 100).toFixed(0)}% (corr=${(corr * 100).toFixed(0)}%)`);
    }

    _lastCorrelation = quality.correlation || 0;
    _lastGateRatio = quality.gateRatio || 0;
    _lastConvergenceX = quality.convergenceX || 0;
    _lastConvergenceY = quality.convergenceY || 0;
    _lastSegTotal = quality.segTotal || 0;
    _lastSegActive = (quality.segCountX ?? quality.segsX) || 0;

    xAnalysis = analyzeShaper(cleanX, filtPeakX, null, peaksX);
    yAnalysis = analyzeShaper(cleanY, filtPeakY, null, peaksY);
    xAnalysis._peaks = peaksX;
    yAnalysis._peaks = peaksY;
    xAnalysis._harmonics = peaksX.filter(p => p.isHarmonic);
    yAnalysis._harmonics = peaksY.filter(p => p.isHarmonic);

    peakFreqXGlobal = filtPeakX;
    peakFreqYGlobal = filtPeakY;
    updateShaperUI(filtPeakX, filtPeakY, xAnalysis, yAnalysis, realPsdX, realPsdY);

    if (typeof runDiagStage1 === 'function') {
      runDiagStage1(cleanX, cleanY, filtPeakX, filtPeakY);
      if (typeof diagState !== 'undefined') {
        diagState._unifiedPeaksX = peaksX;
        diagState._unifiedPeaksY = peaksY;
      }
    }

    lastShaperResult = {
      x: { primary: { freq: filtPeakX, power: d.peakPowerX || 0 } },
      y: { primary: { freq: filtPeakY, power: d.peakPowerY || 0 } },
      snrDb: xAnalysis.snrDb || 0,
      confidence: Math.min(xAnalysis.confidence || 0, yAnalysis.confidence || 0),
      psdBins: realPsdX,
      psdBinsY: realPsdY,
      mode: 'print',
      segsX: (quality.segCountX ?? quality.segsX) || 0,
      segsY: (quality.segCountY ?? quality.segsY) || 0,
    };

    let verdict = null;
    if (typeof validateResult === 'function') {
      verdict = validateResult({
        calibrated: true,
        gateRatio: quality.gateRatio || 0,
        correlation: quality.correlation || 0,
        convergenceX: quality.convergenceX || 99,
        convergenceY: quality.convergenceY || 99,
        activeSegs: (quality.segCountX ?? quality.segsX) || 0,
        segTotal: quality.segTotal || 0,
        xAnalysis,
        yAnalysis,
        peaksX,
        peaksY
      });
      lastShaperResult.verdict = verdict;

      const vl = typeof verdictLabel === 'function' ? verdictLabel(verdict.verdict) : { icon: '?', text: '?' };
      const mqPct = (verdict.mq.score * 100).toFixed(0);
      const rcPct = (verdict.rc.score * 100).toFixed(0);
      appLog('logShaper', `<span class="log-ok">${vl.icon}</span> Verdict: <b>${vl.text}</b> (measurement ${mqPct}% / confidence ${rcPct}%)`);

      const allIssues = [].concat(verdict.mq.issues || [], verdict.rc.issues || []);
      for (const iss of allIssues) {
        if (iss.severity === 'warn' || iss.severity === 'critical') {
          const icon = iss.severity === 'critical' ? '!' : 'W';
          appLog('logShaper', `<span class="log-ok">${icon}</span> ${iss.ko || iss.en || iss.text || ''}`);
        }
      }

      const applyBtn = document.getElementById('btnApply');
      if (applyBtn) {
        if (verdict.verdict === 'retry') {
          applyBtn.disabled = true;
          applyBtn.title = verdict.reason_ko || verdict.reason_en || '';
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
    appLog('logShaper', `<span class="log-ok">OK</span> ${t('log_recommend')} X:${xAnalysis.recommended?.performance?.name || '?'}@${(xAnalysis.recommended?.performance?.freq || 0).toFixed(1)}Hz Y:${yAnalysis.recommended?.performance?.name || '?'}@${(yAnalysis.recommended?.performance?.freq || 0).toFixed(1)}Hz maxAccel:${maxAccel.toLocaleString()}`);

    _lastResultForSave = {
      freqX: filtPeakX,
      freqY: filtPeakY,
      shaperTypeX: (xAnalysis.recommended?.performance?.name || 'mzv').toLowerCase(),
      shaperTypeY: (yAnalysis.recommended?.performance?.name || 'mzv').toLowerCase(),
      shaperType: (xAnalysis.recommended?.performance?.name || 'mzv').toLowerCase(),
      confidence: Math.min(xAnalysis.confidence || 0, yAnalysis.confidence || 0),
    };
    showSaveResultBtn(true);
  } catch (e) {
    appLog('logShaper', `<span class="log-err">X</span> ${t('pm_analysis_err') || 'Analysis failed'}: ${e.message}`);
  }
}
function updateShaperUI(peakX, peakY, xAn, yAn, psdX, psdY) {
  peakX = peakX || 0;
  peakY = peakY || 0;
  if (!xAn) return;
  if (!yAn) yAn = xAn;

  const rs = document.getElementById('resultSection');
  if (rs) rs.style.display = '';

  const emX = document.getElementById('cXEmpty');
  const emY = document.getElementById('cYEmpty');
  if (emX) emX.style.display = 'none';
  if (emY) emY.style.display = 'none';

  const xRec = xAn.recommended?.performance || { name: '?', freq: 0, maxAccel: 0 };
  const yRec = yAn?.recommended?.performance || { name: '?', freq: 0, maxAccel: 0 };
  const xCI = xAn.freqCI;
  const yCI = yAn?.freqCI;
  document.getElementById('vPeakX').textContent = xCI
    ? `${peakX.toFixed(1)} ±${xCI.sigma.toFixed(1)} Hz`
    : `${peakX.toFixed(1)} Hz`;
  document.getElementById('vPeakY').textContent = yCI
    ? `${peakY.toFixed(1)} ±${yCI.sigma.toFixed(1)} Hz`
    : `${peakY.toFixed(1)} Hz`;

  const xShaperName = xRec.name;
  const yShaperName = yRec.name;
  document.getElementById('vShaper').textContent = xShaperName === yShaperName
    ? xShaperName
    : `X:${xShaperName} Y:${yShaperName}`;

  const safeMaxAccel = Math.min(xRec.maxAccel, yRec.maxAccel);
  document.getElementById('vMaxAccel').textContent = safeMaxAccel > 0
    ? safeMaxAccel.toLocaleString() + ' mm/s²'
    : '?';

  const rcX = document.getElementById('rcX');
  const rcY = document.getElementById('rcY');
  const xFitTag = xAn.fitQuality > 0.8 ? ' good' : xAn.fitQuality > 0.5 ? ' fair' : '';
  const yFitTag = yAn.fitQuality > 0.8 ? ' good' : yAn.fitQuality > 0.5 ? ' fair' : '';
  if (rcX) {
    const xPeaks = (xAn.multiPeak?.peaks || []).slice(1).map(p => p.freq.toFixed(0) + 'Hz').join('+');
    rcX.textContent = `Peak: ${peakX.toFixed(1)}Hz${xPeaks ? ' +' + xPeaks : ''} -> ${xShaperName}${xFitTag}`;
  }
  if (rcY) {
    const yPeaks = (yAn?.multiPeak?.peaks || []).slice(1).map(p => p.freq.toFixed(0) + 'Hz').join('+');
    rcY.textContent = `Peak: ${peakY.toFixed(1)}Hz${yPeaks ? ' +' + yPeaks : ''} -> ${yShaperName}${yFitTag}`;
  }

  const confEl = document.getElementById('vConf');
  const warnEl = document.getElementById('lowConfWarn');
  const vd = lastShaperResult?.verdict;
  if (confEl && vd) {
    const vl = typeof verdictLabel === 'function' ? verdictLabel(vd.verdict) : { icon: '', text: '?', color: '#888' };
    const pct = (vd.overallScore * 100).toFixed(0);
    confEl.textContent = `${vl.icon} ${vl.text} (${pct}%)`;
    confEl.style.color = vl.color;
    confEl.className = vd.verdict === 'apply' ? 'c-suc' : vd.verdict === 'review' ? 'c-wrn' : 'c-err';

    if (warnEl) {
      if (vd.verdict === 'retry') {
        warnEl.style.display = 'block';
        warnEl.textContent = 'Retry: ' + (vd.reason_ko || vd.reason_en || 'Needs a new measurement');
        warnEl.className = 'chip chip-err';
      } else if (vd.verdict === 'review') {
        warnEl.style.display = 'block';
        warnEl.textContent = 'Review: ' + (vd.reason_ko || vd.reason_en || 'Manual review recommended');
        warnEl.className = 'chip chip-wrn';
      } else {
        warnEl.style.display = 'none';
      }
    }
  } else if (confEl && xAn.confidence !== undefined) {
    const c = Math.min(xAn.confidence, yAn.confidence ?? xAn.confidence);
    confEl.textContent = `${(c * 100).toFixed(0)}%`;
    confEl.className = c >= 0.8 ? 'c-suc' : c >= 0.5 ? 'c-wrn' : 'c-err';
    if (warnEl) warnEl.style.display = 'none';
  }

  const pd = psdX || xPsdData;
  const yd = psdY || yPsdData;

  const practEl = document.getElementById('practicalInfo');
  const prac = xAn.practical;
  if (practEl && prac && prac.userAccel > 0 && prac.rec) {
    const ko = typeof curLang !== 'undefined' && curLang === 'ko';
    const r = prac.rec;
    let html = '';

    if (r.status === 'retry') {
      html += `<span style="color:#BF616A">!</span> <b>${ko ? '재측정 권장' : 'Re-measurement recommended'}</b><br>`;
      html += `${ko ? 'maxAccel이 너무 낮습니다. 센서 부착 상태를 확인하고 다시 측정하세요.' : 'maxAccel too low. Check sensor mounting and re-measure.'}`;
    } else {
      html += `<b>${ko ? '권장 설정' : 'Recommended Settings'}</b><br>`;
      html += `${ko ? '가속도' : 'Accel'}: <b>${r.accelMin.toLocaleString()} ~ ${r.accelMax.toLocaleString()}</b> mm/s²`;
      html += ` / ${ko ? '속도' : 'Speed'}: <b>${r.speedMin} ~ ${r.speedMax}</b> mm/s<br>`;

      if (r.status === 'headroom') {
        html += `<span style="color:#A3BE8C">OK</span> ${ko ? '현재' : 'Current'} ${prac.userAccel.toLocaleString()}mm/s² / ${prac.userFeed}mm/s ${ko ? '여유 있음, 가속도를 올릴 수 있습니다.' : 'Headroom available, accel can be increased.'}`;
      } else if (r.status === 'over') {
        html += `<span style="color:#EBCB8B">W</span> ${ko ? '현재 가속도' : 'Current accel'} ${prac.userAccel.toLocaleString()} > ${ko ? '권장 최대' : 'rec max'} ${r.accelMax.toLocaleString()} <b>${ko ? '가속도를 낮추세요' : 'Reduce accel'}</b>`;
      } else {
        html += `<span style="color:#88C0D0">OK</span> ${ko ? '현재' : 'Current'} ${prac.userAccel.toLocaleString()}mm/s² / ${prac.userFeed}mm/s ${ko ? '정상 범위지만 여유는 적습니다.' : 'OK but with limited margin.'}`;
      }
    }

    practEl.innerHTML = html;
    practEl.style.display = '';
  } else if (practEl) {
    practEl.style.display = 'none';
  }

  const xExtra = (xAn.multiPeak?.peaks || []).slice(1).map(p => p.freq);
  const yExtra = (yAn?.multiPeak?.peaks || []).slice(1).map(p => p.freq);
  drawPSD('cX', pd, peakX, '#2196F3', xExtra);
  drawPSD('cY', yd, peakY, '#4CAF50', yExtra);

  shaperTable('slX', xAn);
  shaperTable('slY', yAn);
  renderRecommendation('recX', xAn);
  renderRecommendation('recY', yAn);

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
  if (!panel) return;
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
  appLog('logShaper', `<span class="log-ok">\u2713</span> ${t('log_applied')}`);
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
    if (st) { st.textContent = '\u2713 '+t('result_save_ok'); st.className = 'save-msg save-ok'; }
    appLog('logShaper', `<span class="log-ok">\u2713</span> ${t('log_nvs_ok')}`);
  } catch(e) {
    if (st) { st.textContent = '\u2717 '+t('result_save_fail')+e.message; st.className = 'save-msg save-err'; }
    appLog('logShaper', `<span class="log-err">\u2717</span> ${t('log_nvs_fail')}${e.message}`);
  }
  setTimeout(() => { if (st) st.style.display = 'none'; }, 4000);
}

// saveResultToESP: ?쒓굅??(dead code)

function loadResultFromESP() {
  fetch('/api/result')
    .then(r => r.json())
    .then(async (data) => {
      if (!data.hasResult) return;
      const peakX = data.freqX, peakY = data.freqY;
      peakFreqXGlobal = peakX; peakFreqYGlobal = peakY;

      // ESP32?먯꽌 ???PSD 蹂듭썝 ?쒕룄
      let liveBgPsd = null;
      try {
        const res = await fetch('/api/psd?mode=print');
        const d = await res.json();
        if (d.binsX && d.binsX.length > 0) {
          realPsdX = d.binsX.map(b => typeof b === 'object' ? b : null).filter(Boolean);
          if (realPsdX.length === 0) {
            const binMin = Number.isFinite(d.binMin) ? d.binMin : 6;
            realPsdX = d.binsX.map((v, i) => ({f: (i + binMin) * (d.freqRes || 3.125), v: typeof v === 'number' ? v : v.v || 0}));
          }
        }
        if (d.binsY && d.binsY.length > 0) {
          realPsdY = d.binsY.map(b => typeof b === 'object' ? b : null).filter(Boolean);
          if (realPsdY.length === 0) {
            const binMin = Number.isFinite(d.binMin) ? d.binMin : 6;
            realPsdY = d.binsY.map((v, i) => ({f: (i + binMin) * (d.freqRes || 3.125), v: typeof v === 'number' ? v : v.v || 0}));
          }
        }
        if (d.bgPsd && d.bgPsd.length > 0) { liveBgPsd = d.bgPsd; _bgPsdCache = d.bgPsd; }
      } catch(e) {
        // ????ㅽ뙣 ???⑥텞 ?쒕룄
        try {
          const yRes = await fetch('/api/psd');
          const yD = await yRes.json();
          if (yD.bins && yD.bins.length > 0) realPsdY = yD.bins.map(b => ({f:b.f, v:b.v}));
          if (yD.bgPsd && yD.bgPsd.length > 0) { liveBgPsd = yD.bgPsd; _bgPsdCache = yD.bgPsd; }
        } catch(e2) {}
      }

      const pX = realPsdX || xPsdData;
      const pY = realPsdY || yPsdData;

      // ?꾪꽣 + ?듯빀 ?쇳겕
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
        `<span class="log-ok">\u2713</span> ${t('log_restored')}` +
        `X:<span class="log-val">${peakX.toFixed(1)}Hz</span> ` +
        `Y:<span class="log-val">${peakY.toFixed(1)}Hz</span>${srcNote}`
      );
    }).catch(e => console.warn('API:', e.message));
}



// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧
// ??珥덇린??// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧

function initApp() {
  setLang(curLang);
  loadSettings();  // ?대??먯꽌 /api/config 1??fetch ???⑤낫?⑸룄 ?ш린??泥섎━

  // 遺??罹≪쿂??諛곌꼍 PSD 濡쒕뱶 (?꾪꽣???ъ슜)
  function loadBgPsd(retryCount) {
    fetch('/api/noise').then(r=>r.json()).then(d=>{
      if(d.valid && d.bins && d.bins.length>0){
        _bgPsdCache = d.bins.map(b=>b.v);
      } else if (retryCount < 3) {
        // 遺??罹≪쿂 誘몄셿猷???3珥????ъ떆??        setTimeout(() => loadBgPsd(retryCount + 1), 3000);
      }
    }).catch(()=>{
      if (retryCount < 3) setTimeout(() => loadBgPsd(retryCount + 1), 3000);
    }).finally(()=>{
      if (retryCount === 0) loadResultFromESP();  // 泥??쒕룄 ??利됱떆 寃곌낵 蹂듭썝
    });
  }
  loadBgPsd(0);


  // ADXL345 ?곹깭 ?뺤씤 ???곷떒 ?몃뵒耳?댄꽣 + ?곕え 紐⑤뱶 ?먮룞 ?꾪솚
  checkAdxlStatus();

  // 珥덇린 李⑦듃
  setTimeout(() => {
    // loadResultFromESP媛 ?대? 寃곌낵瑜?蹂듭썝?덉쑝硫???뼱?곗? ?딆쓬
    if (peakFreqXGlobal > 0 || peakFreqYGlobal > 0) return;

    if (!adxlConnected) {
      // ADXL 誘몄뿰寃????곕え ?곗씠???먮룞 ?쒖떆
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
    document.getElementById('vPeakX').textContent    = '? Hz';
    document.getElementById('vPeakY').textContent    = '? Hz';
    document.getElementById('vShaper').textContent   = '?';
    document.getElementById('vMaxAccel').textContent = '?';
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
