// ============================================================
// FEMTO SHAPER Kinematics Module v1.0
// / /
//
// : corexy, cartesian, corexz, delta
// :
// - ( , )
// - ( , )
// - ( )
// - ( , )
// -
// ============================================================

//
const KIN_PROFILES = {
  // CoreXY
  // X/Y
  // A/B X/Y
  corexy: {
    name: 'CoreXY',
    axes: {
      x: {
        sensing: 'direct',     //
        signalStrength: 1.0,   //
        minActiveSegs: 200,     //
        convergenceHz: 1.0,    // (Hz)
        desc_ko: 'X축 (캐리지 직접 측정)',
        desc_en: 'X-axis (direct carriage sensing)',
      },
      y: {
        sensing: 'direct',
        signalStrength: 1.0,
        minActiveSegs: 200,
        convergenceHz: 1.0,
        desc_ko: 'Y축 (캐리지 직접 측정)',
        desc_en: 'Y-axis (direct carriage sensing)',
      },
    },
    //
    zoneMap: [
      { max: 40,  zone: 'belt',     ko: '벨트/갠트리 공진',        en: 'Belt/gantry resonance',          act_ko: 'A/B 벨트 텐션 확인', act_en: 'Check A/B belt tension' },
      { max: 70,  zone: 'frame',    ko: '프레임 구조 공진',        en: 'Frame structural resonance',     act_ko: '프레임 코너 브라켓 체결', act_en: 'Tighten frame corners' },
      { max: 100, zone: 'endmass',  ko: '핫엔드/캐리지 질량 공진', en: 'Hotend/carriage mass resonance', act_ko: '핫엔드 마운트 볼트 점검', act_en: 'Check hotend mount bolts' },
      { max: 999, zone: 'hardware', ko: '베어링/볼트/팬 진동',     en: 'Bearing/bolt/fan vibration',     act_ko: '베어링 점검, 전체 볼트 재체결', act_en: 'Inspect bearings, retighten all bolts' },
    ],
    // : X/Y ( )
    beltCompare: true,
    beltThreshold: { warning: 5, alert: 10 },  // Hz
    // X/Y : CoreXY
    symmetryRelevant: true,
    // : CoreXY
    expectedCorrelation: { min: 0.3, max: 0.8 },
    //
    guide_ko: '출력 중 X/Y 모두 직접 측정됩니다. 대각선 움직임이 많을수록 양축 데이터가 풍부합니다.',
    guide_en: 'Both X/Y are directly measured during printing. Diagonal movements provide rich data for both axes.',
  },

  // Cartesian (Bed Slinger)
  // (X) , (Y)
  // X: , Y:
  cartesian: {
    name: 'Cartesian (Bed Slinger)',
    axes: {
      x: {
        sensing: 'direct',
        signalStrength: 1.0,
        minActiveSegs: 200,
        convergenceHz: 1.0,
        desc_ko: 'X축 (캐리지 직접 측정)',
        desc_en: 'X-axis (direct carriage sensing)',
      },
      y: {
        sensing: 'indirect',   //
        signalStrength: 0.3,   // ~30% ( )
        minActiveSegs: 500,    // 3
        convergenceHz: 1.5,    //
        desc_ko: 'Y축 (베드 간접 측정 — 시간이 더 필요합니다)',
        desc_en: 'Y-axis (indirect bed sensing — requires more time)',
      },
    },
    zoneMap: {  //
      x: [
        { max: 50,  zone: 'belt',     ko: 'X캐리지/벨트 공진',     en: 'X carriage/belt resonance',  act_ko: 'X축 벨트 텐션 확인', act_en: 'Check X belt tension' },
        { max: 70,  zone: 'frame',    ko: '프레임 공진',           en: 'Frame resonance',            act_ko: '프레임 코너 체결', act_en: 'Tighten frame corners' },
        { max: 100, zone: 'endmass',  ko: '핫엔드/캐리지 공진',    en: 'Hotend/carriage resonance',  act_ko: '핫엔드 마운트 점검', act_en: 'Check hotend mount bolts' },
        { max: 999, zone: 'hardware', ko: '베어링/볼트 진동',      en: 'Bearing/bolt vibration',     act_ko: '베어링 및 볼트 점검', act_en: 'Inspect bearings and bolts' },
      ],
      y: [
        { max: 30,  zone: 'bed',      ko: 'Y베드 질량 공진 (정상)', en: 'Bed mass resonance (normal)', act_ko: '베드 슬링어 정상 — 베드 경량화 검토', act_en: 'Normal for bed-slinger — reduce bed mass if possible' },
        { max: 50,  zone: 'belt',     ko: 'Y축 벨트/레일',         en: 'Y-axis belt/rail',           act_ko: 'Y축 벨트 텐션 및 레일 확인', act_en: 'Check Y belt tension and rail' },
        { max: 70,  zone: 'frame',    ko: '프레임 공진',           en: 'Frame resonance',            act_ko: '프레임 체결', act_en: 'Tighten frame' },
        { max: 100, zone: 'endmass',  ko: '핫엔드 공진',           en: 'Hotend resonance',           act_ko: '핫엔드 마운트 점검', act_en: 'Check hotend mount' },
        { max: 999, zone: 'hardware', ko: '베어링/볼트 진동',      en: 'Bearing/bolt vibration',     act_ko: '베어링 점검', act_en: 'Inspect bearings' },
      ],
    },
    // : Cartesian X/Y
    beltCompare: false,
    symmetryRelevant: false,
    expectedCorrelation: { min: 0.0, max: 0.4 },  //
    guide_ko: 'X축은 직접 측정, Y축은 베드를 통한 간접 측정입니다. Y축 수렴에 시간이 더 걸립니다.',
    guide_en: 'X-axis is directly measured. Y-axis is indirect via bed — requires more time for convergence.',
  },

  // CoreXZ
  // X+Z , Y
  corexz: {
    name: 'CoreXZ',
    axes: {
      x: {
        sensing: 'direct',
        signalStrength: 1.0,
        minActiveSegs: 200,
        convergenceHz: 1.0,
        desc_ko: 'X축 (갠트리 직접 측정)',
        desc_en: 'X-axis (direct gantry sensing)',
      },
      y: {
        sensing: 'indirect',
        signalStrength: 0.3,
        minActiveSegs: 500,
        convergenceHz: 1.5,
        desc_ko: 'Y축 (베드 간접 측정)',
        desc_en: 'Y-axis (indirect bed sensing)',
      },
    },
    zoneMap: {
      x: [
        { max: 45,  zone: 'belt',     ko: 'X갠트리/벨트 공진',     en: 'X-gantry/belt resonance',    act_ko: 'XZ 벨트 텐션 확인', act_en: 'Check XZ belt tension' },
        { max: 70,  zone: 'frame',    ko: '프레임+Z갠트리 공진',   en: 'Frame + Z-gantry resonance', act_ko: '프레임 및 Z축 체결', act_en: 'Tighten frame and Z-axis' },
        { max: 100, zone: 'endmass',  ko: '핫엔드/캐리지 공진',    en: 'Hotend/carriage resonance',  act_ko: '핫엔드 마운트 점검', act_en: 'Check hotend mount bolts' },
        { max: 999, zone: 'hardware', ko: '베어링/볼트 진동',      en: 'Bearing/bolt vibration',     act_ko: '베어링 및 볼트 점검', act_en: 'Inspect bearings and bolts' },
      ],
      y: [
        { max: 30,  zone: 'bed',      ko: 'Y베드 질량 공진',       en: 'Bed mass resonance',         act_ko: '베드 슬링어 정상 — 베드 경량화 검토', act_en: 'Normal for bed-slinger' },
        { max: 50,  zone: 'belt',     ko: 'Y축 벨트/레일',         en: 'Y-axis belt/rail',           act_ko: 'Y축 벨트 텐션 및 레일 확인', act_en: 'Check Y belt tension and rail' },
        { max: 70,  zone: 'frame',    ko: '프레임 공진',           en: 'Frame resonance',            act_ko: '프레임 체결', act_en: 'Tighten frame' },
        { max: 100, zone: 'endmass',  ko: '핫엔드 공진',           en: 'Hotend resonance',           act_ko: '핫엔드 마운트 점검', act_en: 'Check hotend mount' },
        { max: 999, zone: 'hardware', ko: '베어링/볼트 진동',      en: 'Bearing/bolt vibration',     act_ko: '베어링 점검', act_en: 'Inspect bearings' },
      ],
    },
    beltCompare: false,
    symmetryRelevant: false,
    expectedCorrelation: { min: 0.0, max: 0.4 },
    guide_ko: 'X축은 직접 측정, Y축은 베드를 통한 간접 측정입니다.',
    guide_en: 'X-axis is directly measured. Y-axis is indirect via bed.',
  },

  // Delta
  // X/Y/Z
  delta: {
    name: 'Delta',
    axes: {
      x: {
        sensing: 'coupled',    // X/Y
        signalStrength: 0.7,
        minActiveSegs: 300,
        convergenceHz: 1.5,
        desc_ko: 'X축 (델타 커플링 — 참고용)',
        desc_en: 'X-axis (delta coupling — reference only)',
      },
      y: {
        sensing: 'coupled',
        signalStrength: 0.7,
        minActiveSegs: 300,
        convergenceHz: 1.5,
        desc_ko: 'Y축 (델타 커플링 — 참고용)',
        desc_en: 'Y-axis (delta coupling — reference only)',
      },
    },
    zoneMap: [
      { max: 40,  zone: 'arm',      ko: '델타 암 공진',           en: 'Delta arm resonance',        act_ko: '암 연결부 점검', act_en: 'Check arm joints' },
      { max: 70,  zone: 'frame',    ko: '프레임 공진',           en: 'Frame resonance',            act_ko: '프레임 체결', act_en: 'Tighten frame' },
      { max: 100, zone: 'endmass',  ko: '이펙터 공진',           en: 'Effector resonance',         act_ko: '이펙터 마운트 점검', act_en: 'Check effector mount' },
      { max: 999, zone: 'hardware', ko: '베어링/볼트 진동',      en: 'Bearing/bolt vibration',     act_ko: '베어링 점검', act_en: 'Inspect bearings' },
    ],
    beltCompare: false,
    symmetryRelevant: false,
    expectedCorrelation: { min: 0.5, max: 0.9 },  //
    guide_ko: '델타 프린터는 X/Y 커플링이 강합니다. 결과는 참고용입니다.',
    guide_en: 'Delta printers have strong X/Y coupling. Results are for reference.',
  },
};

// API

//
function getKinProfile(kin) {
  return KIN_PROFILES[kin] || KIN_PROFILES.corexy;
}

//
function getKinZoneMap(kin, axis) {
  const p = getKinProfile(kin);
  // ,
  if (p.zoneMap && !Array.isArray(p.zoneMap)) {
    return p.zoneMap[axis] || p.zoneMap.x || [];
  }
  return p.zoneMap || [];
}

// (diagnostic.js classifyPeakZones )
function classifyKinPeakZones(peaks, kin, axis) {
  const zones = getKinZoneMap(kin, axis);
  return peaks.map(p => {
    // R47: zone (40.0Hz belt(max=40) )
    const zone = zones.find(z => p.f <= z.max) || zones[zones.length - 1];
    return { f: p.f, rel: p.rel || 0, zone: zone.zone, ko: zone.ko, en: zone.en, act_ko: zone.act_ko, act_en: zone.act_en };
  });
}


//
// v1.0
//

//
const KIN_DIAG_RULES = {
  // CoreXY
  // : A/B X/Y
  corexy: {
    rules: [
      {
        id: 'belt_symmetry',
        test: (ctx) => {
          if (!ctx.peakX || !ctx.peakY) return null;
          const diff = Math.abs(ctx.peakX - ctx.peakY);
          if (diff < 3)  return { status:'good', ko:`A/B 벨트 텐션 균형 양호 (차이 ${diff.toFixed(1)}Hz)`, en:`A/B belt tension balanced (Δ${diff.toFixed(1)}Hz)` };
          if (diff < 8)  return { status:'warn', ko:`A/B 벨트 텐션 불균형 가능 (차이 ${diff.toFixed(1)}Hz) → 낮은 쪽 벨트 텐션 올리기`, en:`A/B belt imbalance possible (Δ${diff.toFixed(1)}Hz) → tighten lower belt` };
          return { status:'alert', ko:`A/B 벨트 텐션 심각한 불균형 (차이 ${diff.toFixed(1)}Hz) → 양쪽 벨트 텐션 재조정`, en:`Severe A/B belt imbalance (Δ${diff.toFixed(1)}Hz) → retension both belts` };
        },
      },
      {
        id: 'coupled_peaks',
        test: (ctx) => {
          // CoreXY X/Y ( )
          if (!ctx.peaksX || !ctx.peaksY) return null;
          let shared = 0;
          for (const px of ctx.peaksX) {
            for (const py of ctx.peaksY) {
              if (Math.abs(px.f - py.f) < 5) shared++;
            }
          }
          if (shared > 0) return { status:'info', ko:`X/Y 공유 피크 ${shared}개 — CoreXY 벨트 커플링 정상`, en:`${shared} shared X/Y peak(s) — normal CoreXY belt coupling` };
          return null;
        },
      },
      {
        id: 'low_freq_frame',
        test: (ctx) => {
          const lowPeaks = (ctx.peaksX||[]).filter(p => p.f < 30);
          if (lowPeaks.length > 0) return { status:'warn', ko:`저주파 피크 ${lowPeaks[0].f.toFixed(0)}Hz — 프레임 강성 부족 또는 바닥 진동 가능`, en:`Low-freq peak ${lowPeaks[0].f.toFixed(0)}Hz — check frame rigidity or floor vibration` };
          return null;
        },
      },
    ],
    // CoreXY
    normalFreqRange: { x: [30, 80], y: [30, 80] },
    freqRelation: 'similar',  // X Y
  },

  // Cartesian (Bed Slinger)
  // : X/Y . Y . .
  cartesian: {
    rules: [
      {
        id: 'bed_resonance',
        test: (ctx) => {
          if (!ctx.peakY) return null;
          if (ctx.peakY < 30) return { status:'info', ko:`Y축 ${ctx.peakY.toFixed(0)}Hz — 베드 질량 공진 (Bed Slinger 정상). 속도 제한 필요할 수 있음`, en:`Y-axis ${ctx.peakY.toFixed(0)}Hz — bed mass resonance (normal for bed-slinger). May need speed limit` };
          if (ctx.peakY < 50) return { status:'good', ko:`Y축 ${ctx.peakY.toFixed(0)}Hz — 양호한 베드 공진`, en:`Y-axis ${ctx.peakY.toFixed(0)}Hz — good bed resonance` };
          return { status:'good', ko:`Y축 ${ctx.peakY.toFixed(0)}Hz — 가벼운 베드 또는 높은 강성`, en:`Y-axis ${ctx.peakY.toFixed(0)}Hz — light bed or high rigidity` };
        },
      },
      {
        id: 'xy_independence',
        test: (ctx) => {
          if (!ctx.peakX || !ctx.peakY) return null;
          // Cartesian X >> Y ( vs )
          if (ctx.peakX > ctx.peakY * 1.3) return { status:'info', ko:`X(${ctx.peakX.toFixed(0)}Hz) > Y(${ctx.peakY.toFixed(0)}Hz) — Bed Slinger 정상 패턴`, en:`X(${ctx.peakX.toFixed(0)}Hz) > Y(${ctx.peakY.toFixed(0)}Hz) — normal bed-slinger pattern` };
          if (ctx.peakX < ctx.peakY * 0.7) return { status:'warn', ko:`X(${ctx.peakX.toFixed(0)}Hz) < Y(${ctx.peakY.toFixed(0)}Hz) — 비정상. X축 벨트/가이드 확인`, en:`X(${ctx.peakX.toFixed(0)}Hz) < Y(${ctx.peakY.toFixed(0)}Hz) — unusual. Check X belt/rail` };
          return null;
        },
      },
      {
        id: 'y_signal_quality',
        test: (ctx) => {
          // Y
          if (ctx.correlation > 0.5) return { status:'warn', ko:`X/Y 상관도 높음 (${(ctx.correlation*100).toFixed(0)}%) — Y축 분리 불확실. 더 긴 측정 권장`, en:`High X/Y correlation (${(ctx.correlation*100).toFixed(0)}%) — Y separation uncertain. Longer measurement recommended` };
          return null;
        },
      },
    ],
    normalFreqRange: { x: [35, 80], y: [20, 50] },
    freqRelation: 'x_higher',  // X > Y
  },

  // CoreXZ
  corexz: {
    rules: [
      {
        id: 'bed_resonance',
        test: (ctx) => {
          if (!ctx.peakY) return null;
          if (ctx.peakY < 30) return { status:'info', ko:`Y축 ${ctx.peakY.toFixed(0)}Hz — 베드 질량 공진 (정상)`, en:`Y-axis ${ctx.peakY.toFixed(0)}Hz — bed mass resonance (normal)` };
          return null;
        },
      },
      {
        id: 'xz_coupling',
        test: (ctx) => {
          // X+Z X Z
          if (ctx.peakX && ctx.peakX < 35) return { status:'warn', ko:`X축 ${ctx.peakX.toFixed(0)}Hz 저주파 — Z갠트리 처짐 또는 XZ벨트 텐션 부족`, en:`X-axis ${ctx.peakX.toFixed(0)}Hz low — Z-gantry sag or XZ belt tension` };
          return null;
        },
      },
    ],
    normalFreqRange: { x: [30, 70], y: [20, 50] },
    freqRelation: 'x_higher',
  },

  // Delta
  delta: {
    rules: [
      {
        id: 'symmetry_check',
        test: (ctx) => {
          if (!ctx.peakX || !ctx.peakY) return null;
          const diff = Math.abs(ctx.peakX - ctx.peakY);
          // Delta
          if (diff < 3) return { status:'good', ko:`X/Y 대칭 양호 (차이 ${diff.toFixed(1)}Hz) — 3축 균형`, en:`X/Y symmetric (Δ${diff.toFixed(1)}Hz) — 3-axis balanced` };
          if (diff < 8) return { status:'warn', ko:`X/Y 비대칭 (차이 ${diff.toFixed(1)}Hz) — 암 길이 또는 캐리지 텐션 불균형`, en:`X/Y asymmetric (Δ${diff.toFixed(1)}Hz) — arm length or carriage tension imbalance` };
          return { status:'alert', ko:`X/Y 심각한 비대칭 (차이 ${diff.toFixed(1)}Hz) — 기계적 점검 필요`, en:`Severe X/Y asymmetry (Δ${diff.toFixed(1)}Hz) — mechanical inspection needed` };
        },
      },
      {
        id: 'arm_resonance',
        test: (ctx) => {
          const armPeaks = (ctx.peaksX||[]).filter(p => p.f < 40);
          if (armPeaks.length > 0) return { status:'info', ko:`저주파 ${armPeaks[0].f.toFixed(0)}Hz — 델타 암 공진. 암 연결부/마그네틱 볼 점검`, en:`Low-freq ${armPeaks[0].f.toFixed(0)}Hz — delta arm resonance. Check arm joints/magnetic balls` };
          return null;
        },
      },
    ],
    normalFreqRange: { x: [30, 70], y: [30, 70] },
    freqRelation: 'similar',  // X Y
  },
};

//
// ctx: { peakX, peakY, peaksX[], peaksY[], correlation, gateRatio, convergenceX, convergenceY }
function runKinDiagnostics(kin, ctx) {
  const rules = (KIN_DIAG_RULES[kin] || KIN_DIAG_RULES.corexy).rules;
  const results = [];
  for (const rule of rules) {
    try {
      const r = rule.test(ctx);
      if (r) results.push({ id: rule.id, ...r });
    } catch(e) { /*  */ }
  }

  // :
  const range = (KIN_DIAG_RULES[kin] || KIN_DIAG_RULES.corexy).normalFreqRange;
  if (ctx.peakX && range) {
    if (ctx.peakX < range.x[0]) results.push({ id:'freq_range_x', status:'warn', ko:`X축 ${ctx.peakX.toFixed(0)}Hz — 정상 범위(${range.x[0]}~${range.x[1]}Hz) 미만`, en:`X-axis ${ctx.peakX.toFixed(0)}Hz — below normal range (${range.x[0]}~${range.x[1]}Hz)` });
    if (ctx.peakX > range.x[1]) results.push({ id:'freq_range_x', status:'info', ko:`X축 ${ctx.peakX.toFixed(0)}Hz — 정상 범위 초과 (높은 강성)`, en:`X-axis ${ctx.peakX.toFixed(0)}Hz — above normal range (high rigidity)` });
  }
  if (ctx.peakY && range) {
    if (ctx.peakY < range.y[0]) results.push({ id:'freq_range_y', status:'warn', ko:`Y축 ${ctx.peakY.toFixed(0)}Hz — 정상 범위(${range.y[0]}~${range.y[1]}Hz) 미만`, en:`Y-axis ${ctx.peakY.toFixed(0)}Hz — below normal range (${range.y[0]}~${range.y[1]}Hz)` });
  }

  // :
  if (ctx.gateRatio !== undefined && ctx.gateRatio < 0.05 && ctx.gateRatio > 0) {
    results.push({ id:'low_gate', status:'warn', ko:`유효 세그먼트 비율 ${(ctx.gateRatio*100).toFixed(0)}% — 등속 구간이 많음. 속도↑ 또는 가속↑ 설정 권장`, en:`Active segment ratio ${(ctx.gateRatio*100).toFixed(0)}% — mostly constant speed. Increase speed/accel settings` });
  }

  // :
  const totalPeaks = (ctx.peaksX||[]).length + (ctx.peaksY||[]).length;
  if (totalPeaks >= 8) {
    results.push({ id:'complex', status:'alert', ko:`총 ${totalPeaks}개 피크 — 기계적 상태 전반 점검 필요`, en:`${totalPeaks} total peaks — comprehensive mechanical inspection recommended` });
  }

  return results;
}

// ( vs )
function compareKinResults(kin, prev, curr) {
  if (!prev || !curr) return [];
  const results = [];
  const lang = (typeof getLang === 'function') ? getLang() : 'ko';
  const profile = KIN_DIAG_RULES[kin] || KIN_DIAG_RULES.corexy;

  // X
  if (prev.peakX > 0 && curr.peakX > 0) {
    const dX = curr.peakX - prev.peakX;
    if (Math.abs(dX) >= 2) {
      const dir = dX > 0 ? 'up' : 'down';
      if (dir === 'down') {
        results.push({ id:'drift_x', status:'warn',
          ko:`X축 ${prev.peakX.toFixed(1)}→${curr.peakX.toFixed(1)}Hz (${dX.toFixed(1)}Hz 하락) — 벨트 텐션 감소 또는 볼트 느슨`,
          en:`X-axis ${prev.peakX.toFixed(1)}→${curr.peakX.toFixed(1)}Hz (${dX.toFixed(1)}Hz drop) — belt tension decrease or loose bolts` });
      } else {
        results.push({ id:'drift_x', status:'info',
          ko:`X축 ${prev.peakX.toFixed(1)}→${curr.peakX.toFixed(1)}Hz (${dX.toFixed(1)}Hz 상승)`,
          en:`X-axis ${prev.peakX.toFixed(1)}→${curr.peakX.toFixed(1)}Hz (+${dX.toFixed(1)}Hz)` });
      }
    } else {
      results.push({ id:'stable_x', status:'good',
        ko:`X축 안정 (${prev.peakX.toFixed(1)}→${curr.peakX.toFixed(1)}Hz)`,
        en:`X-axis stable (${prev.peakX.toFixed(1)}→${curr.peakX.toFixed(1)}Hz)` });
    }
  }

  // Y
  if (prev.peakY > 0 && curr.peakY > 0) {
    const dY = curr.peakY - prev.peakY;
    if (Math.abs(dY) >= 2) {
      const dir = dY > 0 ? 'up' : 'down';
      if (dir === 'down') {
        // Cartesian Y
        const yMsg = (kin === 'cartesian' || kin === 'corexz')
          ? '베드 마운트/스프링 확인' : '벨트 텐션 감소 가능';
        results.push({ id:'drift_y', status:'warn',
          ko:`Y축 ${prev.peakY.toFixed(1)}→${curr.peakY.toFixed(1)}Hz (${dY.toFixed(1)}Hz 하락) — ${yMsg}`,
          en:`Y-axis ${prev.peakY.toFixed(1)}→${curr.peakY.toFixed(1)}Hz (${dY.toFixed(1)}Hz drop)` });
      } else {
        results.push({ id:'drift_y', status:'info',
          ko:`Y축 ${prev.peakY.toFixed(1)}→${curr.peakY.toFixed(1)}Hz (+${dY.toFixed(1)}Hz)`,
          en:`Y-axis ${prev.peakY.toFixed(1)}→${curr.peakY.toFixed(1)}Hz (+${dY.toFixed(1)}Hz)` });
      }
    }
  }

  //
  const prevPeaks = (prev.nPeaksX||0) + (prev.nPeaksY||0);
  const currPeaks = (curr.nPeaksX||0) + (curr.nPeaksY||0);
  if (currPeaks > prevPeaks + 2) {
    results.push({ id:'new_peaks', status:'warn',
      ko:`새로운 피크 출현 (${prevPeaks}→${currPeaks}개) — 기계적 변화 발생`,
      en:`New peaks appeared (${prevPeaks}→${currPeaks}) — mechanical change detected` });
  } else if (currPeaks < prevPeaks - 1) {
    results.push({ id:'fewer_peaks', status:'good',
      ko:`피크 감소 (${prevPeaks}→${currPeaks}개) — 상태 개선`,
      en:`Fewer peaks (${prevPeaks}→${currPeaks}) — condition improved` });
  }

  return results;
}

//
// " "
function estimateShaperEffect(shaperResult, axis) {
  if (!shaperResult || !shaperResult.recommended) return null;
  const perf = shaperResult.recommended.performance;
  const safe = shaperResult.recommended.safe;
  return {
    perf: {
      name: perf.name, freq: perf.freq,
      suppression: (100 - perf.vibrPct).toFixed(0),
      maxAccel: perf.maxAccel,
    },
    safe: safe ? {
      name: safe.name, freq: safe.freq,
      suppression: (100 - safe.vibrPct).toFixed(0),
      maxAccel: safe.maxAccel,
    } : null,
  };
}


// ( /measure )

function evaluateKinCorrelation(kin, corr) {
  var p = KIN_PROFILES[kin] || KIN_PROFILES.corexy;
  var ec = p.expectedCorrelation || { min: 0.3, max: 0.8 };
  if (corr < ec.min) return { status: 'low', message_ko: '상관도 매우 낮음', message_en: 'Very low correlation' };
  if (corr <= ec.max) return { status: 'normal', message_ko: '상관도 정상 범위', message_en: 'Correlation within expected range' };
  return { status: 'high', message_ko: '상관도 높음 — 캘리브레이션 확인 권장', message_en: 'High correlation — check calibration' };
}

function isKinAutoReady(kin, cvX, cvY, segs) {
  var p = KIN_PROFILES[kin] || KIN_PROFILES.corexy;
  return cvX < (p.axes.x.convergenceHz || 1) && cvY < (p.axes.y.convergenceHz || 1.5) && segs >= (p.minActiveSegs || 200);
}

function isKinBeltComparable(kin) { return kin === 'corexy'; }

function getKinConvergence(kin, axis) {
  var p = KIN_PROFILES[kin] || KIN_PROFILES.corexy;
  if (axis) {
    var ax = p.axes[axis] || p.axes.x;
    return { convergenceHz: ax.convergenceHz || 1, minActiveSegs: ax.minActiveSegs || 200 };
  }
  return { x: p.axes.x.convergenceHz || 1, y: p.axes.y.convergenceHz || 1.5 };
}

function getKinMeasureGuide(kin, phase, axis, convergence, lang) {
  lang = lang || 'ko'; var p = KIN_PROFILES[kin] || KIN_PROFILES.corexy;
  var axCfg = p.axes[axis] || {};
  if (phase === 'start') {
    if (kin === 'corexy') return lang === 'ko' ? '대각선 방향 측정 (A/B 벨트)' : 'Diagonal measurement (A/B belts)';
    if (kin === 'cartesian') return lang === 'ko' ? '베드 슬링어 — Y축 간접 측정, 더 긴 출력 권장' : 'Bed slinger — Y-axis indirect, longer print recommended';
    if (axCfg.sensing === 'indirect') return lang === 'ko' ? axis.toUpperCase() + '축 간접 측정' : axis.toUpperCase() + '-axis indirect';
    return lang === 'ko' ? axis.toUpperCase() + '축 직접 측정' : axis.toUpperCase() + '-axis direct';
  }
  if (phase === 'slow_axis' && axCfg.sensing === 'indirect') {
    return lang === 'ko' ? axis.toUpperCase() + '축은 간접 측정입니다. 수렴에 시간이 더 필요합니다 (현재: ±' + (convergence || 0).toFixed(1) + 'Hz)'
      : axis.toUpperCase() + '-axis uses indirect sensing. Convergence takes longer (current: ±' + (convergence || 0).toFixed(1) + 'Hz)';
  }
  if (phase === 'converged') {
    return lang === 'ko' ? axis.toUpperCase() + '축 수렴 완료 (±' + (convergence || 0).toFixed(1) + 'Hz)'
      : axis.toUpperCase() + '-axis converged (±' + (convergence || 0).toFixed(1) + 'Hz)';
  }
  return '';
}
