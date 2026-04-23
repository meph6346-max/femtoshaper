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
        desc: 'X-axis (direct carriage sensing)',
      },
      y: {
        sensing: 'direct',
        signalStrength: 1.0,
        minActiveSegs: 200,
        convergenceHz: 1.0,
        desc: 'Y-axis (direct carriage sensing)',
      },
    },
    //
    zoneMap: [
      { max: 40,  zone: 'belt',     en: 'Belt/gantry resonance',          act: 'Check A/B belt tension' },
      { max: 70,  zone: 'frame',    en: 'Frame structural resonance',     act: 'Tighten frame corners' },
      { max: 100, zone: 'endmass',  en: 'Hotend/carriage mass resonance', act: 'Check hotend mount bolts' },
      { max: 999, zone: 'hardware', en: 'Bearing/bolt/fan vibration',     act: 'Inspect bearings, retighten all bolts' },
    ],
    // : X/Y ( )
    beltCompare: true,
    beltThreshold: { warning: 5, alert: 10 },  // Hz
    // X/Y : CoreXY
    symmetryRelevant: true,
    // : CoreXY
    expectedCorrelation: { min: 0.3, max: 0.8 },
    //
    guide: 'Both X/Y are directly measured during printing. Diagonal movements provide rich data for both axes.',
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
        desc: 'X-axis (direct carriage sensing)',
      },
      y: {
        sensing: 'indirect',   //
        signalStrength: 0.3,   // ~30% ( )
        minActiveSegs: 500,    // 3
        convergenceHz: 1.5,    //
        desc: 'Y-axis (indirect bed sensing — requires more time)',
      },
    },
    zoneMap: {  //
      x: [
        { max: 50,  zone: 'belt',     en: 'X carriage/belt resonance',  act: 'Check X belt tension' },
        { max: 70,  zone: 'frame',    en: 'Frame resonance',            act: 'Tighten frame corners' },
        { max: 100, zone: 'endmass',  en: 'Hotend/carriage resonance',  act: 'Check hotend mount bolts' },
        { max: 999, zone: 'hardware', en: 'Bearing/bolt vibration',     act: 'Inspect bearings and bolts' },
      ],
      y: [
        { max: 30,  zone: 'bed',      en: 'Bed mass resonance (normal)', act: 'Normal for bed-slinger — reduce bed mass if possible' },
        { max: 50,  zone: 'belt',     en: 'Y-axis belt/rail',           act: 'Check Y belt tension and rail' },
        { max: 70,  zone: 'frame',    en: 'Frame resonance',            act: 'Tighten frame' },
        { max: 100, zone: 'endmass',  en: 'Hotend resonance',           act: 'Check hotend mount' },
        { max: 999, zone: 'hardware', en: 'Bearing/bolt vibration',     act: 'Inspect bearings' },
      ],
    },
    // : Cartesian X/Y
    beltCompare: false,
    symmetryRelevant: false,
    expectedCorrelation: { min: 0.0, max: 0.4 },  //
    guide: 'X-axis is directly measured. Y-axis is indirect via bed — requires more time for convergence.',
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
        desc: 'X-axis (direct gantry sensing)',
      },
      y: {
        sensing: 'indirect',
        signalStrength: 0.3,
        minActiveSegs: 500,
        convergenceHz: 1.5,
        desc: 'Y-axis (indirect bed sensing)',
      },
    },
    zoneMap: {
      x: [
        { max: 45,  zone: 'belt',     en: 'X-gantry/belt resonance',    act: 'Check XZ belt tension' },
        { max: 70,  zone: 'frame',    en: 'Frame + Z-gantry resonance', act: 'Tighten frame and Z-axis' },
        { max: 100, zone: 'endmass',  en: 'Hotend/carriage resonance',  act: 'Check hotend mount bolts' },
        { max: 999, zone: 'hardware', en: 'Bearing/bolt vibration',     act: 'Inspect bearings and bolts' },
      ],
      y: [
        { max: 30,  zone: 'bed',      en: 'Bed mass resonance',         act: 'Normal for bed-slinger' },
        { max: 50,  zone: 'belt',     en: 'Y-axis belt/rail',           act: 'Check Y belt tension and rail' },
        { max: 70,  zone: 'frame',    en: 'Frame resonance',            act: 'Tighten frame' },
        { max: 100, zone: 'endmass',  en: 'Hotend resonance',           act: 'Check hotend mount' },
        { max: 999, zone: 'hardware', en: 'Bearing/bolt vibration',     act: 'Inspect bearings' },
      ],
    },
    beltCompare: false,
    symmetryRelevant: false,
    expectedCorrelation: { min: 0.0, max: 0.4 },
    guide: 'X-axis is directly measured. Y-axis is indirect via bed.',
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
        desc: 'X-axis (delta coupling — reference only)',
      },
      y: {
        sensing: 'coupled',
        signalStrength: 0.7,
        minActiveSegs: 300,
        convergenceHz: 1.5,
        desc: 'Y-axis (delta coupling — reference only)',
      },
    },
    zoneMap: [
      { max: 40,  zone: 'arm',      en: 'Delta arm resonance',        act: 'Check arm joints' },
      { max: 70,  zone: 'frame',    en: 'Frame resonance',            act: 'Tighten frame' },
      { max: 100, zone: 'endmass',  en: 'Effector resonance',         act: 'Check effector mount' },
      { max: 999, zone: 'hardware', en: 'Bearing/bolt vibration',     act: 'Inspect bearings' },
    ],
    beltCompare: false,
    symmetryRelevant: false,
    expectedCorrelation: { min: 0.5, max: 0.9 },  //
    guide: 'Delta printers have strong X/Y coupling. Results are for reference.',
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
    return { f: p.f, rel: p.rel || 0, zone: zone.zone, label: zone.en, act: zone.act };
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
          if (diff < 3)  return { status:'good', en:`A/B belt tension balanced (Δ${diff.toFixed(1)}Hz)` };
          if (diff < 8)  return { status:'warn', en:`A/B belt imbalance possible (Δ${diff.toFixed(1)}Hz) → tighten lower belt` };
          return { status:'alert', en:`Severe A/B belt imbalance (Δ${diff.toFixed(1)}Hz) → retension both belts` };
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
          if (shared > 0) return { status:'info', en:`${shared} shared X/Y peak(s) — normal CoreXY belt coupling` };
          return null;
        },
      },
      {
        id: 'low_freq_frame',
        test: (ctx) => {
          const lowPeaks = (ctx.peaksX||[]).filter(p => p.f < 30);
          if (lowPeaks.length > 0) return { status:'warn', en:`Low-freq peak ${lowPeaks[0].f.toFixed(0)}Hz — check frame rigidity or floor vibration` };
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
          if (ctx.peakY < 30) return { status:'info', en:`Y-axis ${ctx.peakY.toFixed(0)}Hz — bed mass resonance (normal for bed-slinger). May need speed limit` };
          if (ctx.peakY < 50) return { status:'good', en:`Y-axis ${ctx.peakY.toFixed(0)}Hz — good bed resonance` };
          return { status:'good', en:`Y-axis ${ctx.peakY.toFixed(0)}Hz — light bed or high rigidity` };
        },
      },
      {
        id: 'xy_independence',
        test: (ctx) => {
          if (!ctx.peakX || !ctx.peakY) return null;
          // Cartesian X >> Y ( vs )
          if (ctx.peakX > ctx.peakY * 1.3) return { status:'info', en:`X(${ctx.peakX.toFixed(0)}Hz) > Y(${ctx.peakY.toFixed(0)}Hz) — normal bed-slinger pattern` };
          if (ctx.peakX < ctx.peakY * 0.7) return { status:'warn', en:`X(${ctx.peakX.toFixed(0)}Hz) < Y(${ctx.peakY.toFixed(0)}Hz) — unusual. Check X belt/rail` };
          return null;
        },
      },
      {
        id: 'y_signal_quality',
        test: (ctx) => {
          // Y
          if (ctx.correlation > 0.5) return { status:'warn', en:`High X/Y correlation (${(ctx.correlation*100).toFixed(0)}%) — Y separation uncertain. Longer measurement recommended` };
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
          if (ctx.peakY < 30) return { status:'info', en:`Y-axis ${ctx.peakY.toFixed(0)}Hz — bed mass resonance (normal)` };
          return null;
        },
      },
      {
        id: 'xz_coupling',
        test: (ctx) => {
          // X+Z X Z
          if (ctx.peakX && ctx.peakX < 35) return { status:'warn', en:`X-axis ${ctx.peakX.toFixed(0)}Hz low — Z-gantry sag or XZ belt tension` };
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
          if (diff < 3) return { status:'good', en:`X/Y symmetric (Δ${diff.toFixed(1)}Hz) — 3-axis balanced` };
          if (diff < 8) return { status:'warn', en:`X/Y asymmetric (Δ${diff.toFixed(1)}Hz) — arm length or carriage tension imbalance` };
          return { status:'alert', en:`Severe X/Y asymmetry (Δ${diff.toFixed(1)}Hz) — mechanical inspection needed` };
        },
      },
      {
        id: 'arm_resonance',
        test: (ctx) => {
          const armPeaks = (ctx.peaksX||[]).filter(p => p.f < 40);
          if (armPeaks.length > 0) return { status:'info', en:`Low-freq ${armPeaks[0].f.toFixed(0)}Hz — delta arm resonance. Check arm joints/magnetic balls` };
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
    if (ctx.peakX < range.x[0]) results.push({ id:'freq_range_x', status:'warn', en:`X-axis ${ctx.peakX.toFixed(0)}Hz — below normal range (${range.x[0]}~${range.x[1]}Hz)` });
    if (ctx.peakX > range.x[1]) results.push({ id:'freq_range_x', status:'info', en:`X-axis ${ctx.peakX.toFixed(0)}Hz — above normal range (high rigidity)` });
  }
  if (ctx.peakY && range) {
    if (ctx.peakY < range.y[0]) results.push({ id:'freq_range_y', status:'warn', en:`Y-axis ${ctx.peakY.toFixed(0)}Hz — below normal range (${range.y[0]}~${range.y[1]}Hz)` });
  }

  // :
  if (ctx.gateRatio !== undefined && ctx.gateRatio < 0.05 && ctx.gateRatio > 0) {
    results.push({ id:'low_gate', status:'warn', en:`Active segment ratio ${(ctx.gateRatio*100).toFixed(0)}% — mostly constant speed. Increase speed/accel settings` });
  }

  // :
  const totalPeaks = (ctx.peaksX||[]).length + (ctx.peaksY||[]).length;
  if (totalPeaks >= 8) {
    results.push({ id:'complex', status:'alert', en:`${totalPeaks} total peaks — comprehensive mechanical inspection recommended` });
  }

  return results;
}

// ( vs )
function compareKinResults(kin, prev, curr) {
  if (!prev || !curr) return [];
  const results = [];
  const lang = (typeof getLang === 'function') ? getLang() : 'en';
  const profile = KIN_DIAG_RULES[kin] || KIN_DIAG_RULES.corexy;

  // X
  if (prev.peakX > 0 && curr.peakX > 0) {
    const dX = curr.peakX - prev.peakX;
    if (Math.abs(dX) >= 2) {
      const dir = dX > 0 ? 'up' : 'down';
      if (dir === 'down') {
        results.push({ id:'drift_x', status:'warn',
          en:`X-axis ${prev.peakX.toFixed(1)}→${curr.peakX.toFixed(1)}Hz (${dX.toFixed(1)}Hz drop) — belt tension decrease or loose bolts` });
      } else {
        results.push({ id:'drift_x', status:'info',
          en:`X-axis ${prev.peakX.toFixed(1)}→${curr.peakX.toFixed(1)}Hz (+${dX.toFixed(1)}Hz)` });
      }
    } else {
      results.push({ id:'stable_x', status:'good',
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
          ? 'check bed mount/springs' : 'consider reducing belt tension';
        results.push({ id:'drift_y', status:'warn',
          en:`Y-axis ${prev.peakY.toFixed(1)}→${curr.peakY.toFixed(1)}Hz (${dY.toFixed(1)}Hz drop)` });
      } else {
        results.push({ id:'drift_y', status:'info',
          en:`Y-axis ${prev.peakY.toFixed(1)}→${curr.peakY.toFixed(1)}Hz (+${dY.toFixed(1)}Hz)` });
      }
    }
  }

  //
  const prevPeaks = (prev.nPeaksX||0) + (prev.nPeaksY||0);
  const currPeaks = (curr.nPeaksX||0) + (curr.nPeaksY||0);
  if (currPeaks > prevPeaks + 2) {
    results.push({ id:'new_peaks', status:'warn',
      en:`New peaks appeared (${prevPeaks}→${currPeaks}) — mechanical change detected` });
  } else if (currPeaks < prevPeaks - 1) {
    results.push({ id:'fewer_peaks', status:'good',
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
  if (corr < ec.min) return { status: 'low', message: 'Very low correlation' };
  if (corr <= ec.max) return { status: 'normal', message: 'Correlation within expected range' };
  return { status: 'high', message: 'High correlation — check calibration' };
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
  lang = lang || 'en'; var p = KIN_PROFILES[kin] || KIN_PROFILES.corexy;
  var axCfg = p.axes[axis] || {};
  if (phase === 'start') {
    if (kin === 'corexy') return 'Diagonal measurement (A/B belts)';
    if (kin === 'cartesian') return 'Bed slinger — Y-axis indirect, longer print recommended';
    if (axCfg.sensing === 'indirect') return axis.toUpperCase() + '-axis indirect';
    return axis.toUpperCase() + '-axis direct';
  }
  if (phase === 'slow_axis' && axCfg.sensing === 'indirect') {
    return axis.toUpperCase() + '-axis uses indirect sensing. Convergence takes longer (current: ±' + (convergence || 0).toFixed(1) + 'Hz)';
  }
  if (phase === 'converged') {
    return tp ? tp('kin_guide_converged', {ax: axis.toUpperCase(), c: (convergence||0).toFixed(1)}) : axis.toUpperCase() + '-axis converged (±' + (convergence||0).toFixed(1) + 'Hz)';
  }
  return '';
}
