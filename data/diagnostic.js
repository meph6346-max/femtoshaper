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
  const ko = typeof curLang !== 'undefined' && curLang === 'ko';
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
      title = ko ? f+'Hz 벨트 영역 공진 ('+ax+'축)' : f+'Hz Belt zone resonance ('+ax+'-axis)';
      if (kin === 'corexy') {
        desc = ko ? '이 주파수는 벨트 장력에 의해 결정됩니다. X/Y 두 축에 비슷한 주파수가 나오면 정상입니다.'
                  : 'This frequency is determined by belt tension. Similar frequencies on both axes is normal for CoreXY.';
        action = ko ? '벨트 장력이 균일한지 확인하세요. 손으로 튕겨서 같은 음이 나면 OK.' : 'Check belt tension is even. Pluck both belts — same pitch = OK.';
      } else {
        desc = ko ? '벨트 장력에 의한 공진입니다.' : 'Resonance from belt tension.';
        action = ko ? '벨트 장력을 확인하세요.' : 'Check belt tension.';
      }
    } else if (zone === 'carriage' || zone === 'endmass') {
      icon = '🛷'; severity = snrLevel==='strong' ? 'warn' : 'info';
      title = ko ? f+'Hz 캐리지/핫엔드 공진 ('+ax+'축)' : f+'Hz Carriage/hotend resonance ('+ax+'-axis)';
      desc = ko ? '프린트 헤드(핫엔드)와 캐리지의 질량에 의한 공진입니다. 볼트가 느슨하면 이 피크가 강하게 나타납니다.'
                : 'Resonance from printhead and carriage mass. Loose bolts make this peak stronger.';
      action = ko ? '핫엔드 마운트 볼트를 확인하세요. 캐리지 바퀴/레일 상태도 점검하세요.' : 'Check hotend mount bolts. Also inspect carriage wheels/rails.';
    } else if (zone === 'frame') {
      icon = '🏗️'; severity = snrLevel==='strong' ? 'warn' : 'info';
      title = ko ? f+'Hz 프레임 공진 ('+ax+'축)' : f+'Hz Frame resonance ('+ax+'-axis)';
      desc = ko ? '프레임 구조의 강성에 의한 공진입니다. 프레임이 약하거나 볼트가 느슨하면 나타납니다.'
                : 'Resonance from frame rigidity. Appears when frame is weak or bolts are loose.';
      action = ko ? '프레임 코너 볼트를 모두 조이세요. 프린터가 단단한 표면 위에 있는지 확인하세요.' : 'Tighten all frame corner bolts. Ensure printer is on a solid surface.';
    } else {
      icon = '📍'; severity = 'info';
      title = ko ? f+'Hz 공진 감지 ('+ax+'축)' : f+'Hz Resonance detected ('+ax+'-axis)';
      desc = ko ? '인풋 쉐이퍼가 이 주파수의 진동을 자동으로 억제합니다.' : 'Input shaper will automatically suppress vibration at this frequency.';
      action = ko ? '쉐이퍼 결과를 프린터에 적용하세요.' : 'Apply the shaper result to your printer.';
    }

    // Cartesian Y
    if (kin === 'cartesian' && ax === 'Y') {
      desc = ko ? '베드(Y축)가 무겁기 때문에 공진 주파수가 낮습니다. 이것은 Cartesian 프린터의 정상적인 특성입니다.'
                : 'The bed (Y-axis) is heavy, so resonance frequency is low. This is normal for Cartesian printers.';
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
        title: ko ? (r.ko || r.en) : (r.en || r.ko),
        desc: '', action: '',
      });
    }
  }

  // 3. ( )
  if (harmPeaks.length > 0) {
    const harmList = harmPeaks.map(p => p.f.toFixed(0)+'Hz('+p.axis+')='+((p.harmonicOf||0).toFixed(0))+'Hz×'+p.harmonicOrder).join(', ');
    findings.push({
      icon: '🎵', severity: 'ok',
      title: ko ? '하모닉 '+harmPeaks.length+'개 감지 — 자동 처리됨' : harmPeaks.length+' harmonic(s) detected — auto-handled',
      desc: ko ? '기본 주파수의 배수 진동입니다. 인풋 쉐이퍼가 자동으로 처리하므로 걱정하지 않아도 됩니다. ('+harmList+')'
              : 'Integer multiples of fundamental frequency. Input shaper handles these automatically. ('+harmList+')',
      action: '',
    });
  }

  // 4.
  if (fanPeaks.length > 0) {
    findings.push({
      icon: '🌀', severity: 'ok',
      title: ko ? '팬 진동 '+fanPeaks.length+'개 감지 — 쉐이퍼 대상 아님' : fanPeaks.length+' fan vibration(s) — not shaper target',
      desc: ko ? '냉각 팬에 의한 진동입니다. 인풋 쉐이퍼로는 해결되지 않습니다. 방진마운트 사용을 권장합니다.'
              : 'Vibration from cooling fans. Cannot be fixed by input shaper. Anti-vibration mounts recommended.',
      action: ko ? '팬 방진마운트를 설치하세요.' : 'Install fan anti-vibration mounts.',
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
    if (overallTitle) overallTitle.textContent = ko ? '주의 사항이 있습니다' : 'Attention needed';
    if (overallTitle) overallTitle.style.color = '#EBCB8B';
    if (overallDesc) overallDesc.textContent = ko ? warnCount+'개 항목을 확인해 주세요' : 'Please check '+warnCount+' item(s)';
    if (overallCard) overallCard.style.borderLeft = '4px solid #EBCB8B';
  } else if (realPeaks.length > 0) {
    if (overallIcon) overallIcon.textContent = '🟢';
    if (overallTitle) overallTitle.textContent = ko ? '프린터 상태 양호' : 'Printer looks good';
    if (overallTitle) overallTitle.style.color = '#A3BE8C';
    if (overallDesc) overallDesc.textContent = ko ? '인풋 쉐이퍼 결과를 적용하면 출력 품질이 향상됩니다' : 'Apply input shaper results to improve print quality';
    if (overallCard) overallCard.style.borderLeft = '4px solid #A3BE8C';
  } else {
    if (overallIcon) overallIcon.textContent = '🔵';
    if (overallTitle) overallTitle.textContent = ko ? '뚜렷한 공진 없음' : 'No clear resonance';
    if (overallTitle) overallTitle.style.color = '#88C0D0';
    if (overallDesc) overallDesc.textContent = ko ? '센서 부착 상태를 확인하거나 더 오래 측정해 보세요' : 'Check sensor attachment or measure longer';
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
      + (ko ? '이상 없음 — 정상 상태입니다' : 'All clear — everything looks normal') + '</div>';
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

