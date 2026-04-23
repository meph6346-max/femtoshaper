// ============ FEMTO SHAPER Diagnostic Engine v0.8 ============
// Stage 1: IS PSD (Belt/Carriage/Frame/Symmetry)
// Stage 2: G
// Overview:
//

//
let _diagAbort = false;  //
let _diagForceNext = false;  // v0.9:
const diagState = {
  // : null( ), {status, message, value}
  belt: null,
  carriage: null,
  frame: null,
  symmetry: null,
  // IS Stage 1
  isAnalysis: null,
  //
  complexity: 0,
};


// Stage 1: IS PSD
/* *
* PSD
* IS Stage 1
 *
* @param {Array} psdX - X PSD [{f, v}]
* @param {Array} psdY - Y PSD [{f, v}]
* @param {number} peakX - X
* @param {number} peakY - Y
* @returns {object}
  */
// (prominence + )
// v1.0: findPeaksDiag filter.js detectPeaks()

function extractFeatures(psdX, psdY, peakX, peakY) {
  // (diagState ) detectPeaks
  var peaksX = (typeof diagState !== 'undefined' && diagState._unifiedPeaksX) ? diagState._unifiedPeaksX : [];
  var peaksY = (typeof diagState !== 'undefined' && diagState._unifiedPeaksY) ? diagState._unifiedPeaksY : [];
  // : detectPeaks
  if (peaksX.length === 0 && typeof detectPeaks === 'function' && psdX && psdX.length > 0) {
    var kin = (typeof getCfgKin === 'function') ? getCfgKin() : 'corexy';
    peaksX = detectPeaks(psdX, { kin: kin, axis: 'x' });
    peaksY = detectPeaks(psdY, { kin: kin, axis: 'y' });
  }

  const peakFreqX = peakX || (peaksX[0] ? peaksX[0].f : 0);
  const peakFreqY = peakY || (peaksY[0] ? peaksY[0].f : 0);

  const xyAsym = Math.max(peakFreqX, peakFreqY) > 0
    ? Math.abs(peakFreqX - peakFreqY) / Math.max(peakFreqX, peakFreqY) : 0;

  const hfPeaksX = peaksX.filter(p => p.f > Math.max(peakFreqX * 1.8, peakFreqX + 30) && p.f > 75);
  const hfPeaksY = peaksY.filter(p => p.f > Math.max(peakFreqY * 1.8, peakFreqY + 30) && p.f > 75);

  const _kin = (typeof getCfgKin === 'function') ? getCfgKin() : 'corexy';
  return {
    xyAsym, peakSpread: Math.abs(peakFreqX - peakFreqY),
    hfCount: hfPeaksX.length + hfPeaksY.length,
    hfRel: Math.max(...hfPeaksX.map(p => p.rel || 0), ...hfPeaksY.map(p => p.rel || 0), 0),
    hfPeaksX: hfPeaksX.map(p => p.f), hfPeaksY: hfPeaksY.map(p => p.f),
    nPeaksX: peaksX.length, nPeaksY: peaksY.length,
    peakFreqX, peakFreqY,
    peakZonesX: peaksX.map(p => ({ f: p.f, rel: p.rel || 0, zone: p.zone || '', ko: p.zone_ko || '', en: p.zone_en || '' })),
    peakZonesY: peaksY.map(p => ({ f: p.f, rel: p.rel || 0, zone: p.zone || '', ko: p.zone_ko || '', en: p.zone_en || '' })),
    allPeaksX: peaksX.map(p => ({ f: p.f, rel: p.rel || 0 })),
    allPeaksY: peaksY.map(p => ({ f: p.f, rel: p.rel || 0 })),
  };
}


// v1.0: getZoneMap/classifyPeakZones kinematics.js classifyKinPeakZones
// detectPeaks() zone

/* *
*


// Stage 1:
/**
*
 *
* "suspected/possible" "confirmed"
* (xyAsym>0.15, hfRel>0.15 )
 *
* @param {object} features - extractFeatures()
* @returns {object}
  */
function analyzeISFeatures(features) {
  // [ Round 3 ] Stage 1: belt + carriage only
  // frame/symmetry Stage 2 G
  const results = {
    belt:     { status: 'normal', message: t('diag_ok') },
    carriage: { status: 'normal', message: t('diag_ok') },
    frame:    { status: 'normal', message: 'Needs Stage 2 test' },
    symmetry: { status: 'normal', message: 'Needs Stage 2 test' },
    findings: [],
  };

  // 1:
  // CoreXY/CoreXZ: X/Y 2 / 15%
  // Cartesian: X/Y +
  // Delta:
  const kin = (typeof getCfgKin === 'function') ? getCfgKin() : 'corexy';

  if (kin === 'cartesian') {
    // Cartesian:
    results.belt = { status: 'normal',
      message: `X/Y Δ${(features.xyAsym*100).toFixed(0)}% (Cartesian — independent axes, normal)` };
  } else if (kin === 'delta') {
    // Delta:
    results.belt = { status: 'normal', message: 'N/A (delta)' };
  } else {
    // CoreXY/CoreXZ:
    if (features.xyAsym > 0.15) {
      const diff = features.peakSpread.toFixed(1);
      results.belt = { status: 'warning',
        message: `Belt asymmetry suspected (Δ${diff}Hz, ${(features.xyAsym*100).toFixed(0)}%)` };
      results.findings.push(results.belt.message);
    }
  }

  // 2:
  if (features.hfCount >= 2 && features.hfRel > 0.25) {
    const hfList = [...features.hfPeaksX, ...features.hfPeaksY]
      .map(f => f.toFixed(0)+'Hz').join(', ');
    results.carriage = { status: 'warning',
      message: `Carriage looseness possible (HF peaks: ${hfList})` };
    results.findings.push(results.carriage.message);
  }

  // NextAction
  // warning
  results.nextActions = [];
  if (results.belt.status === 'warning') {
    results.nextActions.push({
      target: 'belt',
      title: 'Belt Tension Adjustment',
      steps: [
        'Identify the lower-frequency belt (looser)',
        'Tighten it 1/4 turn and re-measure',
        'Target: frequency difference < 5%',
      ],
      priority: 'high',
    });
  }
  if (results.carriage.status === 'warning') {
    results.nextActions.push({
      target: 'carriage',
      title: 'Carriage / Bearing Check',
      steps: [
        'Power off and check toolhead for play by hand',
        'Tighten eccentric nuts or replace worn bearings',
        'Check belt tooth engagement on pulleys',
        'Re-measure after adjustment',
      ],
      priority: 'high',
    });
  }
  if (results.frame.status === 'warning') {
    results.nextActions.push({
      target: 'frame',
      title: 'Frame Stiffness Check',
      steps: [
        'Check all frame bolts for tightness',
        'Verify corner brackets are secure',
        'Check for rubber feet dampening (may help)',
      ],
      priority: 'medium',
    });
  }

  return results;
}


//
/* *
* 0~100
* ( )
 *
*
  */
function computeComplexity(features) {
  // [Phase 3] extractFeatures v3
  let score = 0;

  // X/Y (0~30): 15%
  score += Math.min(30, features.xyAsym * 200);

  // (0~30)
  score += Math.min(20, features.hfCount * 5 + features.hfRel * 15);

  // (0~25): =2, =3+
  const totalPeaks = (features.nPeaksX || 0) + (features.nPeaksY || 0);
  score += Math.min(25, Math.max(0, totalPeaks - 2) * 8);

  // Belt Compare (0~15)
  if (diagState.belt && diagState.belt.delta) {
    score += Math.min(15, diagState.belt.delta * 0.8);
  }

  return Math.min(100, Math.round(score));
}


// Overview UI
function updateDiagOverview() {
  const kin = typeof getCfgKin === 'function' ? getCfgKin() : 'corexy';
  const peakX = typeof peakFreqXGlobal !== 'undefined' ? peakFreqXGlobal : 0;
  const peakY = typeof peakFreqYGlobal !== 'undefined' ? peakFreqYGlobal : 0;

  const emptyEl = document.getElementById('diagEmpty');
  const resultsEl = document.getElementById('diagResults');
  if (!emptyEl || !resultsEl) return;

  //
  const peaksX = (typeof xAnalysis !== 'undefined' && xAnalysis?._peaks) ? xAnalysis._peaks : [];
  const peaksY = (typeof yAnalysis !== 'undefined' && yAnalysis?._peaks) ? yAnalysis._peaks : [];
  const allPeaks = [
    ...peaksX.map(p => ({...p, axis:'X'})),
    ...peaksY.map(p => ({...p, axis:'Y'})),
  ].filter(p => p.f > 0);

  //
  if (allPeaks.length === 0 && peakX === 0 && peakY === 0) {
    emptyEl.style.display = '';
    resultsEl.style.display = 'none';
    return;
  }
  emptyEl.style.display = 'none';
  resultsEl.style.display = '';

  //
  const kinResults = typeof runKinDiagnostics === 'function'
    ? runKinDiagnostics(kin, {
        peakX, peakY,
        peaksX: peaksX.length > 0 ? peaksX : [{f:peakX,rel:1}],
        peaksY: peaksY.length > 0 ? peaksY : [{f:peakY,rel:1}],
        correlation: typeof _lastCorrelation !== 'undefined' ? _lastCorrelation : 0,
        gateRatio: typeof _lastGateRatio !== 'undefined' ? _lastGateRatio : 0,
      }) : [];

  //
  const findings = [];
  const realPeaks = allPeaks.filter(p => !p.isHarmonic && !p.isFan);
  const harmPeaks = allPeaks.filter(p => p.isHarmonic);
  const fanPeaks = allPeaks.filter(p => p.isFan);
  const hasWarn = kinResults.some(r => r.status === 'warn' || r.status === 'alert');
  const kinName = typeof getKinProfile === 'function' ? (getKinProfile(kin)?.name || kin) : kin;

  // 1.
  for (const p of realPeaks) {
    const snrLevel = p.snr > 10 ? 'strong' : p.snr > 3 ? 'medium' : 'weak';
    const f = p.f.toFixed(1);
    const ax = p.axis;

    //
    let title, desc, action, icon, severity;
    const zone = p.zone || 'unknown';

    if (zone === 'belt') {
      icon = '🔗'; severity = 'info';
      title = tp('diag_belt_zone_title', {f, ax});
      if (kin === 'corexy') {
        desc = t('diag_corexy_belt_desc');
        action = t('diag_corexy_belt_action');
      } else {
        desc = t('diag_belt_desc');
        action = t('diag_belt_action');
      }
    } else if (zone === 'carriage' || zone === 'endmass') {
      icon = '🛷'; severity = snrLevel==='strong' ? 'warn' : 'info';
      title = tp('diag_carriage_zone_title', {f, ax});
      desc = t('diag_carriage_zone_desc');
      action = t('diag_carriage_zone_action');
    } else if (zone === 'frame') {
      icon = '🏗️'; severity = snrLevel==='strong' ? 'warn' : 'info';
      title = tp('diag_frame_zone_title', {f, ax});
      desc = t('diag_frame_zone_desc');
      action = t('diag_frame_zone_action');
    } else {
      icon = '📍'; severity = 'info';
      title = tp('diag_generic_zone_title', {f, ax});
      desc = t('diag_generic_zone_desc');
      action = t('diag_generic_zone_action');
    }

    // Cartesian Y
    if (kin === 'cartesian' && ax === 'Y') {
      desc = t('diag_cart_y_desc');
      severity = 'info';
    }

    findings.push({icon, severity, title, desc, action, snrLevel, freq:p.f});
  }

  // 2.
  for (const r of kinResults) {
    if (r.status === 'warn' || r.status === 'alert') {
      findings.push({
        icon: r.status === 'alert' ? '❌' : '⚠️',
        severity: r.status === 'alert' ? 'error' : 'warn',
        title: r.en || r.message || '',
        desc: '', action: '',
      });
    }
  }

  // 3. ( )
  if (harmPeaks.length > 0) {
    const harmList = harmPeaks.map(p => p.f.toFixed(0)+'Hz('+p.axis+')='+((p.harmonicOf||0).toFixed(0))+'Hz×'+p.harmonicOrder).join(', ');
    findings.push({
      icon: '🎵', severity: 'ok',
      title: tp('diag_harmonic_title', {n: harmPeaks.length}),
      desc: tp('diag_harmonic_desc', {list: harmList}),
      action: '',
    });
  }

  // 4.
  if (fanPeaks.length > 0) {
    findings.push({
      icon: '🌀', severity: 'ok',
      title: tp('diag_fan_title', {n: fanPeaks.length}),
      desc: t('diag_fan_desc'),
      action: t('diag_fan_action'),
    });
  }

  //
  const overallIcon = document.getElementById('diagOverallIcon');
  const overallTitle = document.getElementById('diagOverallTitle');
  const overallDesc = document.getElementById('diagOverallDesc');
  const overallCard = document.getElementById('diagOverallCard');

  const warnCount = findings.filter(f => f.severity === 'warn' || f.severity === 'error').length;
  const infoCount = findings.filter(f => f.severity === 'info').length;

  if (warnCount > 0) {
    if (overallIcon) overallIcon.textContent = '🟡';
    if (overallTitle) overallTitle.textContent = t('diag_warn_attention');
    if (overallTitle) overallTitle.style.color = '#EBCB8B';
    if (overallDesc) overallDesc.textContent = tp('diag_warn_check_n', {n: warnCount});
    if (overallCard) overallCard.style.borderLeft = '4px solid #EBCB8B';
  } else if (realPeaks.length > 0) {
    if (overallIcon) overallIcon.textContent = '🟢';
    if (overallTitle) overallTitle.textContent = t('diag_printer_good');
    if (overallTitle) overallTitle.style.color = '#A3BE8C';
    if (overallDesc) overallDesc.textContent = t('diag_printer_good_desc');
    if (overallCard) overallCard.style.borderLeft = '4px solid #A3BE8C';
  } else {
    if (overallIcon) overallIcon.textContent = '🔵';
    if (overallTitle) overallTitle.textContent = t('diag_no_resonance');
    if (overallTitle) overallTitle.style.color = '#88C0D0';
    if (overallDesc) overallDesc.textContent = t('diag_no_resonance_desc');
    if (overallCard) overallCard.style.borderLeft = '4px solid #88C0D0';
  }

  //
  const findingsEl = document.getElementById('diagFindings');
  if (!findingsEl) return;

  let html = '';
  // ,
  const sorted = findings.sort((a,b) => {
    const order = {error:0, warn:1, info:2, ok:3};
    return (order[a.severity]||9) - (order[b.severity]||9);
  });

  for (const f of sorted) {
    const borderColor = f.severity === 'error' ? '#BF616A' : f.severity === 'warn' ? '#EBCB8B' : f.severity === 'ok' ? '#A3BE8C' : 'var(--bg3)';
    html += '<div class="card" style="padding:12px;border-left:3px solid '+borderColor+';margin-bottom:8px">';
    html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">';
    html += '<span style="font-size:20px">'+f.icon+'</span>';
    html += '<div style="font-size:13px;font-weight:600;color:var(--tx1)">'+f.title+'</div>';
    html += '</div>';
    if (f.desc) html += '<div style="font-size:12px;color:var(--tx2);line-height:1.6;margin-bottom:6px">'+f.desc+'</div>';
    if (f.action) html += '<div style="font-size:12px;color:var(--pri);line-height:1.5">💡 '+f.action+'</div>';
    html += '</div>';
  }

  if (sorted.length === 0 && realPeaks.length === 0) {
    html = '<div class="card" style="padding:16px;text-align:center;color:var(--tx3)"><div style="font-size:24px;margin-bottom:8px">✨</div>'
      + t('diag_all_clear') + '</div>';
  }

  findingsEl.innerHTML = html;
}

//
function assessPeakHealth(features) {
  const nX = features.nPeaksX || 0;
  const nY = features.nPeaksY || 0;
  const maxPeaks = Math.max(nX, nY);
  const axis = nX >= nY ? 'X' : 'Y';
  const zones = (axis === 'X' ? features.peakZonesX : features.peakZonesY) || [];

  let grade, icon, color;
  if (maxPeaks <= 1)      { grade = 'excellent'; icon = '🟢'; color = 'suc'; }
  else if (maxPeaks <= 2) { grade = 'normal';    icon = '🟡'; color = 'wrn'; }
  else if (maxPeaks <= 3) { grade = 'caution';   icon = '🟠'; color = 'wrn'; }
  else if (maxPeaks <= 4) { grade = 'warning';   icon = '🔴'; color = 'err'; }
  else                    { grade = 'critical';  icon = '⛔'; color = 'err'; }

  // zone
  const findings = zones.map(z => ({
    zone: z.zone, freq: z.f,
    desc: z.en, desc_ko: z.ko,
    action: z.act_en, action_ko: z.act_ko,
  }));

  return { grade, icon, color, maxPeaks, axis, findings };
}


// Stage 1 (IS )
/* *
* Input Shaper
* PSD Stage 1
  */
function runDiagStage1(psdX, psdY, peakX, peakY) {
  const features = extractFeatures(psdX, psdY, peakX, peakY);
  const analysis = analyzeISFeatures(features);
  diagState.isAnalysis = analysis;
  diagState.complexity = computeComplexity(features);
  // v0.9:
  diagState.peakHealth = assessPeakHealth(features);

  // Stage 1
  ['belt', 'carriage', 'frame', 'symmetry'].forEach(key => {
    const statusEl = document.getElementById(`${key}S1Status`);
    const msgEl = document.getElementById(`${key}S1Msg`);
    if (statusEl && msgEl) {
      const r = analysis[key];
      if (r.status === 'normal') {
        statusEl.textContent = t('diag_normal');
        statusEl.className = 'chip chip-suc';
      } else {
        statusEl.textContent = t('diag_warning');
        statusEl.className = 'chip chip-wrn';
      }
      msgEl.textContent = r.message;
      msgEl.className = r.status === 'warning' ? 'diag-msg warn' : 'diag-msg';
    }
  });

  updateDiagOverview();
}


// Stage 2:
/* *
* Belt
* Stage 1: extractFeatures v3 ( prominence )
  */
// Belt Compare (Phase 3 )
/* *
* Belt Compare [ ]
* : start_x(A ) start_y(B ) stop
  */





// Diagnostic
// Stage 2: ESP32 /api/measure + /api/psd (Phase 5)
// Diagnostic Stage 2 G
// : G SD ESP32


// Diagnostic Stage 2 (Phase 5 )
//
// Round 1~3 :
// carriage: (75Hz+) prominence
// frame: (20Hz ) G
// symmetry: X/Y
//

