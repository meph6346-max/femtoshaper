// ============ FEMTO SHAPER v1.0 Final Judgment Engine ============
// 2계층 품질 평가 + 3단계 판정 + Apply G-code 생성
//
// 계층:
//   measurement_quality — 이번 측정 세션을 믿을 수 있는가
//   result_confidence   — 이 피크/쉐이퍼 추천을 믿을 수 있는가
// 판정:
//   APPLY  — 적용 가능
//   REVIEW — 결과 확인 후 적용 (경고)
//   RETRY  — 재측정 필요 (Apply 비활성)

// ══════════════════════════════════════════════════════
// Layer 1: 측정 품질 (measurement_quality)
// ══════════════════════════════════════════════════════

function calcMeasurementQuality(metrics) {
  // metrics: { calibrated, gateRatio, correlation, convergenceX, convergenceY, activeSegs, segTotal }
  var score = 0;
  var maxScore = 0;
  var issues = [];

  // 1. 캘리브레이션 (필수)
  maxScore += 20;
  if (metrics.calibrated) {
    score += 20;
  } else {
    issues.push({ id: 'no_cal', severity: 'critical', ko: '캘리브레이션 미완료', en: 'Calibration not done' });
  }

  // 2. 게이트 비율 (유효 세그먼트 %)
  maxScore += 25;
  var gr = metrics.gateRatio || 0;
  if (gr >= 0.2) score += 25;
  else if (gr >= 0.1) { score += 15; issues.push({ id: 'low_gate', severity: 'warn', ko: '유효 세그먼트 ' + (gr*100).toFixed(0) + '% — 가감속이 적음', en: 'Active segments ' + (gr*100).toFixed(0) + '% — few accelerations' }); }
  else if (gr >= 0.03) { score += 5; issues.push({ id: 'very_low_gate', severity: 'warn', ko: '유효 세그먼트 ' + (gr*100).toFixed(0) + '% — 속도/가속도↑ 권장', en: 'Active segments ' + (gr*100).toFixed(0) + '% — increase speed/accel' }); }
  else { issues.push({ id: 'no_gate', severity: 'critical', ko: '유효 세그먼트 부족 (' + (gr*100).toFixed(0) + '%) — 등속 출력만 감지됨', en: 'Insufficient active segments (' + (gr*100).toFixed(0) + '%)' }); }

  // 3. X/Y 분리도
  maxScore += 20;
  var corr = metrics.correlation || 0;
  if (corr < 0.5) score += 20;
  else if (corr < 0.7) { score += 12; issues.push({ id: 'mod_corr', severity: 'info', ko: 'X/Y 분리도 보통 (' + (100-corr*100).toFixed(0) + '%)', en: 'Moderate X/Y separation (' + (100-corr*100).toFixed(0) + '%)' }); }
  else { score += 4; issues.push({ id: 'high_corr', severity: 'warn', ko: 'X/Y 분리 불량 (' + (100-corr*100).toFixed(0) + '%) — 더 긴 측정 또는 캘리브레이션 재실행', en: 'Poor X/Y separation (' + (100-corr*100).toFixed(0) + '%)' }); }

  // 4. 수렴도
  maxScore += 20;
  var cvMax = Math.max(metrics.convergenceX || 99, metrics.convergenceY || 99);
  if (cvMax < 1.0) score += 20;
  else if (cvMax < 2.0) { score += 12; issues.push({ id: 'mod_conv', severity: 'info', ko: '수렴 ±' + cvMax.toFixed(1) + 'Hz — 더 긴 출력 권장', en: 'Convergence ±' + cvMax.toFixed(1) + 'Hz — longer print recommended' }); }
  else if (cvMax < 3.0) { score += 5; issues.push({ id: 'low_conv', severity: 'warn', ko: '수렴 부족 ±' + cvMax.toFixed(1) + 'Hz', en: 'Poor convergence ±' + cvMax.toFixed(1) + 'Hz' }); }
  else { issues.push({ id: 'no_conv', severity: 'critical', ko: '미수렴 ±' + cvMax.toFixed(1) + 'Hz — 재측정 필요', en: 'Not converged ±' + cvMax.toFixed(1) + 'Hz — retry needed' }); }

  // 5. 유효 세그먼트 절대 수
  maxScore += 15;
  var segs = metrics.activeSegs || 0;
  if (segs >= 200) score += 15;
  else if (segs >= 100) { score += 10; }
  else if (segs >= 50) { score += 5; issues.push({ id: 'few_segs', severity: 'info', ko: '세그먼트 ' + segs + '개 — 더 긴 출력 권장', en: segs + ' segments — longer print recommended' }); }
  else { issues.push({ id: 'too_few_segs', severity: 'critical', ko: '세그먼트 ' + segs + '개 — 최소 50 필요', en: segs + ' segments — minimum 50 needed' }); }

  return {
    score: maxScore > 0 ? score / maxScore : 0,
    issues: issues,
    details: { calibrated: metrics.calibrated, gateRatio: gr, correlation: corr, convergence: cvMax, activeSegs: segs }
  };
}


// ══════════════════════════════════════════════════════
// Layer 2: 결과 신뢰도 (result_confidence)
// ══════════════════════════════════════════════════════

function calcResultConfidence(analysis, peaks) {
  // analysis: analyzeShaper 결과, peaks: detectPeaks 결과
  var score = 0;
  var maxScore = 0;
  var issues = [];

  if (!analysis || !analysis.recommended) {
    return { score: 0, issues: [{ id: 'no_analysis', severity: 'critical', ko: '분석 결과 없음', en: 'No analysis result' }], details: {} };
  }

  var perf = analysis.recommended.performance;

  // 1. 피크 존재 + SNR
  maxScore += 25;
  if (peaks && peaks.length > 0) {
    var mainPeak = peaks[0];
    if (mainPeak.snr > 10) score += 25;
    else if (mainPeak.snr > 5) { score += 15; issues.push({ id: 'mod_snr', severity: 'info', ko: '피크 SNR 보통 (' + mainPeak.snr.toFixed(1) + '×)', en: 'Moderate peak SNR (' + mainPeak.snr.toFixed(1) + '×)' }); }
    else { score += 5; issues.push({ id: 'low_snr', severity: 'warn', ko: '피크 SNR 낮음 (' + mainPeak.snr.toFixed(1) + '×)', en: 'Low peak SNR (' + mainPeak.snr.toFixed(1) + '×)' }); }
  } else {
    issues.push({ id: 'no_peak', severity: 'critical', ko: '피크 미검출', en: 'No peak detected' });
  }

  // 2. 멀티피크 상태
  maxScore += 20;
  var mp = analysis.multiPeak;
  if (!mp || !mp.detected) {
    score += 20; // 단일 피크 = 최고
  } else if (mp.count <= 2 && mp.level === 'suspected') {
    score += 12; issues.push({ id: 'dual_suspect', severity: 'info', ko: '2차 피크 의심', en: 'Secondary peak suspected' });
  } else if (mp.count <= 2 && mp.level === 'confirmed') {
    score += 8; issues.push({ id: 'dual_confirm', severity: 'warn', ko: '2피크 확인 — safe 쉐이퍼 권장', en: 'Dual peaks confirmed — safe shaper recommended' });
  } else {
    score += 3; issues.push({ id: 'multi_peak', severity: 'warn', ko: mp.count + '피크 — 복잡한 공진', en: mp.count + ' peaks — complex resonance' });
  }

  // 3. 브로드 피크 / Q factor
  maxScore += 20;
  var zoom = analysis._zoom;
  if (zoom && zoom.Q > 0) {
    if (zoom.Q >= 3) score += 20;
    else if (zoom.Q >= 1.5) { score += 10; issues.push({ id: 'broad_peak', severity: 'warn', ko: '넓은 피크 (Q=' + zoom.Q.toFixed(1) + ') — 센서 마운트 확인', en: 'Broad peak (Q=' + zoom.Q.toFixed(1) + ') — check sensor mount' }); }
    else { score += 3; issues.push({ id: 'very_broad', severity: 'warn', ko: '매우 넓은 피크 (Q=' + zoom.Q.toFixed(1) + ') — 센서 장착 불량 가능', en: 'Very broad peak (Q=' + zoom.Q.toFixed(1) + ') — possible mount issue' }); }
  } else {
    score += 15; // 줌 정보 없으면 중립
  }

  // 4. 쉐이퍼 품질
  maxScore += 20;
  if (perf.vibrPct < 5) score += 20;
  else if (perf.vibrPct < 15) { score += 15; }
  else if (perf.vibrPct < 30) { score += 8; issues.push({ id: 'high_vibr', severity: 'info', ko: '잔여 진동 ' + perf.vibrPct.toFixed(0) + '% — 높은 편', en: 'Residual vibration ' + perf.vibrPct.toFixed(0) + '% — somewhat high' }); }
  else { score += 3; issues.push({ id: 'very_high_vibr', severity: 'warn', ko: '잔여 진동 ' + perf.vibrPct.toFixed(0) + '% — 기계적 점검 권장', en: 'Residual vibration ' + perf.vibrPct.toFixed(0) + '% — mechanical check recommended' }); }

  // 5. 팬 지배 여부
  maxScore += 15;
  var fanDom = (peaks || []).filter(function(p) { return p.isFan && !p.isHarmonic; });
  if (fanDom.length === 0) {
    score += 15;
  } else {
    // 1차 피크가 팬 지배인지
    var mainIsFan = peaks && peaks.length > 0 && peaks[0].isFan;
    if (mainIsFan) {
      issues.push({ id: 'fan_dominant', severity: 'warn', ko: '1차 피크가 팬 지배적 — 팬 캘리브레이션 권장', en: 'Primary peak is fan-dominated — fan calibration recommended' });
    } else {
      score += 10;
    }
  }

  return {
    score: maxScore > 0 ? score / maxScore : 0,
    issues: issues,
    details: { peakCount: (peaks||[]).length, multiPeak: !!(mp&&mp.detected), vibrPct: perf.vibrPct }
  };
}


// ══════════════════════════════════════════════════════
// 최종 판정: APPLY / REVIEW / RETRY
// ══════════════════════════════════════════════════════

var VERDICT_APPLY  = 'apply';
var VERDICT_REVIEW = 'review';
var VERDICT_RETRY  = 'retry';

function finalVerdict(mq, rc) {
  // mq: calcMeasurementQuality 결과
  // rc: calcResultConfidence 결과

  // RETRY 조건: 크리티컬 이슈가 있으면
  var hasCriticalMQ = mq.issues.some(function(i) { return i.severity === 'critical'; });
  var hasCriticalRC = rc.issues.some(function(i) { return i.severity === 'critical'; });
  if (hasCriticalMQ || hasCriticalRC) {
    return {
      verdict: VERDICT_RETRY,
      overallScore: Math.min(mq.score, rc.score),
      reason_ko: '재측정 필요: ' + [].concat(mq.issues, rc.issues).filter(function(i){return i.severity==='critical'}).map(function(i){return i.ko}).join(', '),
      reason_en: 'Re-measurement needed: ' + [].concat(mq.issues, rc.issues).filter(function(i){return i.severity==='critical'}).map(function(i){return i.en}).join(', '),
      mq: mq, rc: rc
    };
  }

  // REVIEW 조건: 경고가 2개 이상이거나 스코어가 낮으면
  var warnCount = [].concat(mq.issues, rc.issues).filter(function(i) { return i.severity === 'warn'; }).length;
  var combined = Math.min(mq.score, rc.score);

  if (warnCount >= 2 || combined < 0.6) {
    return {
      verdict: VERDICT_REVIEW,
      overallScore: combined,
      reason_ko: '결과 확인 권장: ' + [].concat(mq.issues, rc.issues).filter(function(i){return i.severity==='warn'}).map(function(i){return i.ko}).join(', '),
      reason_en: 'Review recommended: ' + [].concat(mq.issues, rc.issues).filter(function(i){return i.severity==='warn'}).map(function(i){return i.en}).join(', '),
      mq: mq, rc: rc
    };
  }

  // APPLY
  return {
    verdict: VERDICT_APPLY,
    overallScore: combined,
    reason_ko: '적용 가능',
    reason_en: 'Ready to apply',
    mq: mq, rc: rc
  };
}

// ── 종합 판정 함수 (app.js에서 호출) ──────────────────
function validateResult(opts) {
  // R13.9: 상위 분석 실패 시 전체 판정이 크래시하지 않도록 안전 반환
  if (!opts || !opts.xAnalysis || !opts.yAnalysis) {
    return {
      verdict: VERDICT_RETRY,
      overallScore: 0,
      reason_ko: '분석 데이터 부족 — 재측정 필요',
      reason_en: 'Incomplete analysis data — please re-measure',
      mq: { score: 0, issues: [] },
      rc: { score: 0, issues: [] }
    };
  }

  // opts: { calibrated, gateRatio, correlation, convergenceX, convergenceY,
  //         activeSegs, segTotal, xAnalysis, yAnalysis, peaksX, peaksY }
  var mq = calcMeasurementQuality({
    calibrated: opts.calibrated !== false,
    gateRatio: opts.gateRatio || 0,
    correlation: opts.correlation || 0,
    convergenceX: opts.convergenceX || 99,
    convergenceY: opts.convergenceY || 99,
    activeSegs: opts.activeSegs || 0,
    segTotal: opts.segTotal || 0
  });

  // R13.8: peaksX/Y 빈 배열 가드 (모든 피크가 하모닉/팬으로 필터링된 경우)
  var peaksX = Array.isArray(opts.peaksX) ? opts.peaksX : [];
  var peaksY = Array.isArray(opts.peaksY) ? opts.peaksY : [];

  // X/Y 중 더 낮은 confidence 사용
  var rcX = calcResultConfidence(opts.xAnalysis, peaksX);
  var rcY = calcResultConfidence(opts.yAnalysis, peaksY);
  var rc = rcX.score <= rcY.score ? rcX : rcY;
  // 양축 이슈 합산
  rc.issues = [].concat(rcX.issues, rcY.issues);
  rc.score = Math.min(rcX.score, rcY.score);

  // v1.0: 사용자 accel 대비 maxAccel 여유 체크
  var prac = opts.xAnalysis && opts.xAnalysis.practical;
  if (prac && prac.userAccel > 0) {
    var safeMax = Math.min(
      opts.xAnalysis?.recommended?.performance?.maxAccel || 99999,
      opts.yAnalysis?.recommended?.performance?.maxAccel || 99999
    );
    if (safeMax < prac.userAccel) {
      rc.issues.push({
        id: 'accel_limit', severity: 'warn',
        ko: '추천 maxAccel(' + safeMax + ') < 프린터 설정(' + prac.userAccel + ') — 가속도를 ' + safeMax + '으로 제한하세요',
        en: 'Recommended maxAccel(' + safeMax + ') < printer setting(' + prac.userAccel + ') — limit accel to ' + safeMax
      });
    }
    if (!prac.smoothingOk) {
      rc.issues.push({
        id: 'smoothing_exceed', severity: 'warn',
        ko: '현재 가속도에서 스무딩 ' + prac.userSmoothing.toFixed(3) + 'mm > 목표 ' + prac.targetSmoothing + 'mm',
        en: 'Smoothing at current accel ' + prac.userSmoothing.toFixed(3) + 'mm > target ' + prac.targetSmoothing + 'mm'
      });
    }
    // 빌드 유효성: 속도 미도달
    if (!prac.feedReachable) {
      rc.issues.push({
        id: 'speed_unreachable', severity: 'warn',
        ko: prac.userFeed + 'mm/s가 ' + Math.min(prac.buildX,prac.buildY) + 'mm 베드에서 도달 불가 (최대 ' + prac.maxReachSpeed + 'mm/s)',
        en: prac.userFeed + 'mm/s unreachable on ' + Math.min(prac.buildX,prac.buildY) + 'mm bed (max ' + prac.maxReachSpeed + 'mm/s)'
      });
    }
    // 측정 여기 부족
    if (prac.measExcitation === 'poor') {
      rc.issues.push({
        id: 'low_excitation', severity: 'warn',
        ko: '가감속 구간 ' + (prac.accelRatio*100).toFixed(0) + '% — 속도↑ 또는 가속도↓ 권장',
        en: 'Accel phase ' + (prac.accelRatio*100).toFixed(0) + '% — increase speed or reduce accel'
      });
    }
  }

  return finalVerdict(mq, rc);
}


// ══════════════════════════════════════════════════════
// Apply G코드 생성 (변경 없음)
// ══════════════════════════════════════════════════════

// R14.12: 하이픈/언더스코어 variant 모두 매핑 (2hump_ei, 2hump-ei, 2hump EI)
const M493_TYPE = {
  zv: 1, mzv: 3, ei: 4,
  '2hump_ei': 5, '2hump-ei': 5, '2hump ei': 5,
  '3hump_ei': 6, '3hump-ei': 6, '3hump ei': 6,
};

function _normShaperName(name) {
  if (!name) return 'mzv';
  return String(name).toLowerCase().replace(/[-\s]+/g, '_');
}

function generateApplyGcode(opts) {
  const { firmware = 'marlin_is', freqX, freqY,
    shaperType, shaperTypeX, shaperTypeY,
    damping: rawDamping = 0.1, saveToEeprom = false, confidence = 0 } = opts;
  // R14.11: 대소문자/하이픈 정규화 일관성 보장
  const stX = _normShaperName(shaperTypeX || shaperType || 'mzv');
  const stY = _normShaperName(shaperTypeY || shaperType || 'mzv');
  const damping = (isFinite(rawDamping) && rawDamping > 0) ? rawDamping : 0.1;
  const fx = (isFinite(freqX) && freqX > 0) ? freqX : 40;
  const fy = (isFinite(freqY) && freqY > 0) ? freqY : 40;
  const ts = new Date().toISOString().slice(0, 16);
  const lines = [
    `; FEMTO SHAPER — Apply Result`,
    `; Generated: ${ts} | Firmware: ${firmware}`,
    `; X: ${fx}Hz (${stX}) | Y: ${fy}Hz (${stY}) | D:${damping}`, '',
  ];
  switch (firmware) {
    case 'marlin_ftm': {
      // M493 S1: X 주파수, S2: Y 주파수 (Marlin FTM은 축별 별도 명령)
      const cx = M493_TYPE[stX] != null ? M493_TYPE[stX] : 3;
      const cy = M493_TYPE[stY] != null ? M493_TYPE[stY] : 3;
      lines.push(`M493 S1 A${fx} C${cx}`);
      lines.push(`M493 S2 A${fy} C${cy}`);
      if (saveToEeprom) lines.push('M500');
      break;
    }
    case 'marlin_is':
      lines.push(`M593 X F${fx} D${damping}`);
      lines.push(`M593 Y F${fy} D${damping}`);
      if (saveToEeprom) lines.push('M500');
      break;
    case 'klipper':
      // R14.13: damping_ratio_x/y 반드시 포함 (printer.cfg 필수 항목)
      lines.push(`; [input_shaper]`);
      lines.push(`; shaper_freq_x: ${fx}`);
      lines.push(`; shaper_freq_y: ${fy}`);
      lines.push(`; shaper_type_x: ${stX}`);
      lines.push(`; shaper_type_y: ${stY}`);
      lines.push(`; damping_ratio_x: ${damping}`);
      lines.push(`; damping_ratio_y: ${damping}`);
      break;
    case 'rrf':
      // R14.14: Y축 명령 누락 버그 수정 — P"type" 형식으로 X/Y 모두 출력
      lines.push(`M593 P"${stX}" F${fx} X1`);
      lines.push(`M593 P"${stY}" F${fy} Y1`);
      if (saveToEeprom) lines.push('M500');
      break;
  }
  return lines.join('\n');
}

// ── 판정 라벨 (R13.7: 알 수 없는 verdict 경고, R17.22: 언어 대응) ──
function verdictLabel(v) {
  const lang = (typeof curLang !== 'undefined') ? curLang : 'en';
  const isKo = lang === 'ko';
  if (v === VERDICT_APPLY)  return { text: isKo ? '적용'      : 'APPLY',  icon:'\u2705', color:'#A3BE8C' };
  if (v === VERDICT_REVIEW) return { text: isKo ? '검토'      : 'REVIEW', icon:'\u26A0',  color:'#EBCB8B' };
  if (v === VERDICT_RETRY)  return { text: isKo ? '재측정'    : 'RETRY',  icon:'\u274C',  color:'#BF616A' };
  // 알 수 없는 verdict 문자열 → 경고 + RETRY 반환
  if (typeof console !== 'undefined' && console.warn) console.warn('[verdictLabel] unknown verdict:', v);
  return { text: isKo ? '불명'/*unknown*/ : 'UNKNOWN', icon:'\u2753', color:'#888' };
}
