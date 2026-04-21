// ============ FEMTO SHAPER Diagnostic Engine v0.8 ============
// Stage 1: IS PSD 기반 자동 분석 (Belt/Carriage/Frame/Symmetry)
// Stage 2: 전용 G코드 측정 결과 분석
// Overview: 대시보드 통합
// 모든 주석 한국어

// ── 진단 상태 저장소 ─────────────────────────────────
let _diagAbort = false;  // 진단 중지 플래그
let _diagForceNext = false;  // v0.9: 수동 다음 단계 플래그
const diagState = {
  // 각 테스트 결과: null(미실행), {status, message, value}
  belt: null,
  carriage: null,
  frame: null,
  symmetry: null,
  // IS 기반 Stage 1 분석 결과
  isAnalysis: null,
  // 복잡도 점수
  complexity: 0,
};


// ── Stage 1: IS PSD 기반 특징 추출 ────────────────────
/**
 * PSD 데이터에서 진단 특징 추출
 * IS 측정 데이터가 있으면 자동으로 Stage 1 분석 수행
 *
 * @param {Array} psdX - X축 PSD [{f, v}]
 * @param {Array} psdY - Y축 PSD [{f, v}]
 * @param {number} peakX - X축 주 피크 주파수
 * @param {number} peakY - Y축 주 피크 주파수
 * @returns {object} 특징 추출 결과
 */
// 멀티피크 검출 (prominence + 절대 임계값) — 모듈 레벨
// v1.0: findPeaksDiag 삭제 — filter.js detectPeaks()로 통합

function extractFeatures(psdX, psdY, peakX, peakY) {
  // 통합 피크 사용 (diagState에 있으면) 또는 detectPeaks 호출
  var peaksX = (typeof diagState !== 'undefined' && diagState._unifiedPeaksX) ? diagState._unifiedPeaksX : [];
  var peaksY = (typeof diagState !== 'undefined' && diagState._unifiedPeaksY) ? diagState._unifiedPeaksY : [];
  // 폴백: detectPeaks 직접 호출
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


// v1.0: getZoneMap/classifyPeakZones 삭제 — kinematics.js classifyKinPeakZones로 통합
// detectPeaks()가 이미 zone 정보를 피크에 첨부

/**
 * 특정 주파수 대역의 에너지 합산


// ── Stage 1: 패턴 매칭 규칙 ──────────────────────────
/**
 * 추출된 특징으로 진단 규칙 적용
 *
 * 규칙은 항상 "suspected/possible" 톤 — 절대 "confirmed" 안 됨
 * 실측 후 임계값 조정 예정 (xyAsym>0.15, hfRel>0.15 시뮬 검증값)
 *
 * @param {object} features - extractFeatures() 반환값
 * @returns {object} 진단 결과
 */
function analyzeISFeatures(features) {
  // [시뮬 Round 3 확정] Stage 1: belt + carriage only
  // frame/symmetry는 Stage 2 전용 G코드에서 전담
  const results = {
    belt:     { status: 'normal', message: t('diag_ok') },
    carriage: { status: 'normal', message: t('diag_ok') },
    frame:    { status: 'normal', message: 'Needs Stage 2 test' },
    symmetry: { status: 'normal', message: 'Needs Stage 2 test' },
    findings: [],
  };

  // 규칙 1: 벨트 비대칭 — 키네마틱스별 차별화
  // CoreXY/CoreXZ: X/Y가 같은 벨트 2개의 합/차 → 15% 이상이면 의심
  // Cartesian: X/Y는 독립 벨트+독립 질량 → 비대칭 비교 무의미 → 항상 정보 표시
  // Delta: 해당 없음
  const kin = (typeof getCfgKin === 'function') ? getCfgKin() : 'corexy';

  if (kin === 'cartesian') {
    // Cartesian: 비대칭은 구조적 특성 — 경고 아님
    results.belt = { status: 'normal',
      message: `X/Y Δ${(features.xyAsym*100).toFixed(0)}% (Cartesian — independent axes, normal)` };
  } else if (kin === 'delta') {
    // Delta: 해당 없음
    results.belt = { status: 'normal', message: 'N/A (delta)' };
  } else {
    // CoreXY/CoreXZ: 실제 벨트 비교
    if (features.xyAsym > 0.15) {
      const diff = features.peakSpread.toFixed(1);
      results.belt = { status: 'warning',
        message: `Belt asymmetry suspected (Δ${diff}Hz, ${(features.xyAsym*100).toFixed(0)}%)` };
      results.findings.push(results.belt.message);
    }
  }

  // 규칙 2: 캐리지 느슨함 — 비하모닉 고주파 피크 존재
  if (features.hfCount >= 2 && features.hfRel > 0.25) {
    const hfList = [...features.hfPeaksX, ...features.hfPeaksY]
      .map(f => f.toFixed(0)+'Hz').join(', ');
    results.carriage = { status: 'warning',
      message: `Carriage looseness possible (HF peaks: ${hfList})` };
    results.findings.push(results.carriage.message);
  }

  // ── NextAction 카드 생성 ───────────────────────────
  // 각 warning에 대해 사용자가 실제로 할 수 있는 조치를 안내
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


// ── 복잡도 점수 계산 ─────────────────────────────────
/**
 * 0~100 복잡도 점수
 * 높을수록 기계 상태가 복잡 (문제 많음)
 *
 * 실측 후 복잡도 가중치 조정 예정
 */
function computeComplexity(features) {
  // [Phase 3] extractFeatures v3 필드 기반
  let score = 0;

  // X/Y 비대칭 기여 (0~30): 15% 이상이면 만점
  score += Math.min(30, features.xyAsym * 200);

  // 비하모닉 고주파 피크 기여 (0~30)
  score += Math.min(20, features.hfCount * 5 + features.hfRel * 15);

  // 피크 수 기여 (0~25): 정상=2, 이상=3+
  const totalPeaks = (features.nPeaksX || 0) + (features.nPeaksY || 0);
  score += Math.min(25, Math.max(0, totalPeaks - 2) * 8);

  // Belt Compare 데이터 연동 (0~15)
  if (diagState.belt && diagState.belt.delta) {
    score += Math.min(15, diagState.belt.delta * 0.8);
  }

  return Math.min(100, Math.round(score));
}


// ── Overview 대시보드 UI 업데이트 ─────────────────────
function updateDiagOverview() {
  const kin = typeof getCfgKin === 'function' ? getCfgKin() : 'corexy';
  const ko = typeof curLang !== 'undefined' && curLang === 'ko';
  const peakX = typeof peakFreqXGlobal !== 'undefined' ? peakFreqXGlobal : 0;
  const peakY = typeof peakFreqYGlobal !== 'undefined' ? peakFreqYGlobal : 0;

  const emptyEl = document.getElementById('diagEmpty');
  const resultsEl = document.getElementById('diagResults');
  if (!emptyEl || !resultsEl) return;

  // 피크 데이터
  const peaksX = (typeof xAnalysis !== 'undefined' && xAnalysis?._peaks) ? xAnalysis._peaks : [];
  const peaksY = (typeof yAnalysis !== 'undefined' && yAnalysis?._peaks) ? yAnalysis._peaks : [];
  const allPeaks = [
    ...peaksX.map(p => ({...p, axis:'X'})),
    ...peaksY.map(p => ({...p, axis:'Y'})),
  ].filter(p => p.f > 0);

  // 측정 전
  if (allPeaks.length === 0 && peakX === 0 && peakY === 0) {
    emptyEl.style.display = '';
    resultsEl.style.display = 'none';
    return;
  }
  emptyEl.style.display = 'none';
  resultsEl.style.display = '';

  // ── 키네마틱 진단 ──
  const kinResults = typeof runKinDiagnostics === 'function'
    ? runKinDiagnostics(kin, {
        peakX, peakY,
        peaksX: peaksX.length > 0 ? peaksX : [{f:peakX,rel:1}],
        peaksY: peaksY.length > 0 ? peaksY : [{f:peakY,rel:1}],
        correlation: typeof _lastCorrelation !== 'undefined' ? _lastCorrelation : 0,
        gateRatio: typeof _lastGateRatio !== 'undefined' ? _lastGateRatio : 0,
      }) : [];

  // ── 발견 항목 수집 ──
  const findings = [];
  const realPeaks = allPeaks.filter(p => !p.isHarmonic && !p.isFan);
  const harmPeaks = allPeaks.filter(p => p.isHarmonic);
  const fanPeaks = allPeaks.filter(p => p.isFan);
  const hasWarn = kinResults.some(r => r.status === 'warn' || r.status === 'alert');
  const kinName = typeof getKinProfile === 'function' ? (getKinProfile(kin)?.name || kin) : kin;

  // 1. 공진 피크 설명
  for (const p of realPeaks) {
    const snrLevel = p.snr > 10 ? 'strong' : p.snr > 3 ? 'medium' : 'weak';
    const f = p.f.toFixed(1);
    const ax = p.axis;

    // 키네마틱별 사용자 친화 설명
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

    // Cartesian Y축 특별 설명
    if (kin === 'cartesian' && ax === 'Y') {
      desc = ko ? '베드(Y축)가 무겁기 때문에 공진 주파수가 낮습니다. 이것은 Cartesian 프린터의 정상적인 특성입니다.'
                : 'The bed (Y-axis) is heavy, so resonance frequency is low. This is normal for Cartesian printers.';
      severity = 'info';
    }

    findings.push({icon, severity, title, desc, action, snrLevel, freq:p.f});
  }

  // 2. 키네마틱 진단 결과
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

  // 3. 하모닉 (접이식)
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

  // 4. 팬 피크
  if (fanPeaks.length > 0) {
    findings.push({
      icon: '🌀', severity: 'ok',
      title: ko ? '팬 진동 '+fanPeaks.length+'개 감지 — 쉐이퍼 대상 아님' : fanPeaks.length+' fan vibration(s) — not shaper target',
      desc: ko ? '냉각 팬에 의한 진동입니다. 인풋 쉐이퍼로는 해결되지 않습니다. 방진마운트 사용을 권장합니다.'
              : 'Vibration from cooling fans. Cannot be fixed by input shaper. Anti-vibration mounts recommended.',
      action: ko ? '팬 방진마운트를 설치하세요.' : 'Install fan anti-vibration mounts.',
    });
  }

  // ── 종합 상태 ──
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

  // ── 발견 항목 카드 생성 ──
  const findingsEl = document.getElementById('diagFindings');
  if (!findingsEl) return;

  let html = '';
  // 경고 먼저, 정보 나중
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

// ── 피크 건강도 진단 ─────────────────────────────────
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

  // 부위별 진단 — 키네마틱스 적용된 zone 사용
  const findings = zones.map(z => ({
    zone: z.zone, freq: z.f,
    desc: z.en, desc_ko: z.ko,
    action: z.act_en, action_ko: z.act_ko,
  }));

  return { grade, icon, color, maxPeaks, axis, findings };
}


// ── Stage 1 실행 (IS 데이터 기반) ────────────────────
/**
 * Input Shaper 측정 완료 후 호출
 * PSD 데이터로 자동 Stage 1 분석 수행
 */
function runDiagStage1(psdX, psdY, peakX, peakY) {
  const features = extractFeatures(psdX, psdY, peakX, peakY);
  const analysis = analyzeISFeatures(features);
  diagState.isAnalysis = analysis;
  diagState.complexity = computeComplexity(features);
  // v0.9: 피크 건강도 진단
  diagState.peakHealth = assessPeakHealth(features);

  // Stage 1 결과를 각 서브탭에도 반영
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


// ── Stage 2: 개별 테스트 결과 처리 ──────────────────
/**
 * Belt 측정 완료 후 호출
 * Stage 1: extractFeatures v3 (멀티피크 prominence 방식)
 */
// ── Belt Compare 실제 측정 흐름 (Phase 3 구현) ─────────
/**
 * Belt Compare 탭에서 [측정] 버튼 클릭 시 호출
 * 흐름: start_x(A벨트 대각선) → 수집 → start_y(B벨트) → 수집 → stop → 분석
 */





// ── Diagnostic 측정 시뮬레이션 ───────────────────────
// Stage 2: ESP32 /api/measure + /api/psd 실제 연동 완료 (Phase 5)
// Diagnostic Stage 2 — 전용 G코드 측정 흐름
// 흐름: G코드 다운로드 → SD카드 실행 → ESP32 자동 수집 → 결과 분석


// ── Diagnostic Stage 2 결과 분석 (Phase 5 멀티피크 기반) ──
//
// 시뮬레이션 Round 1~3 결과:
//   carriage: 비하모닉 고주파 피크(75Hz+) 존재 여부 → prominence 기반 감지
//   frame:    저주파(20Hz 이하) 전용 G코드에서 세그먼트 에너지 분산 확인
//   symmetry: X/Y 각각 수집 후 피크 주파수 차이 비교
//

