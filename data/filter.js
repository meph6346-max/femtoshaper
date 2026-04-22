// ============ FEMTO SHAPER Filter v1.0 ============
// 단일 목적: PSD 정제 → 순수 기계 공진 추출
// 모든 임계값은 설정에서 변경 가능

// ── 설정 변수 (settings.js에서 로드) ──────────────────
var filterPsdThreshold = 0.01;   // 최소 노이즈 floor (0.01 = ADXL 양자화 이하 차단)
var filterPowerHz = 60;       // 전원 주파수 (60Hz 또는 50Hz)
var filterFreqMin = 18;       // PSD 관심 범위 최소 (Hz)
var filterFreqMax = 150;      // PSD 관심 범위 최대 (Hz)
var filterNoiseFloorPct = 0.3;// 노이즈 플로어 백분위
var filterNoiseMultiplier = 5;// 노이즈 × 이 배율 = 임계값

// ── 배경 PSD 캐시 ────────────────────────────────────
var _bgPsdCache = null;

// ── 배경 노이즈 필터 ─────────────────────────────────
function filterByBackground(psd, bgPsd) {
  if (!psd || !Array.isArray(psd) || psd.length === 0) return psd || [];

  // 적응형 필터: 노이즈 플로어 자동 계산 + psdThreshold를 최소 floor로
  var vals = psd.filter(function(p) { return p.f >= filterFreqMin && p.f <= filterFreqMax; })
               .map(function(p) { return p.v; }).sort(function(a,b) { return a - b; });
  var noiseFloor = vals[Math.floor(vals.length * filterNoiseFloorPct)] || 0;
  var threshold = Math.max(noiseFloor * filterNoiseMultiplier, filterPsdThreshold);

  return psd.map(function(p) {
    if (p.f < filterFreqMin) return { f: p.f, v: 0, var: p.var || 0 };
    var bgV = 0;
    if (bgPsd && Array.isArray(bgPsd)) {
      var bgIdx = Math.round((p.f - filterFreqMin) / 3.125);
      if (bgIdx >= 0 && bgIdx < bgPsd.length) bgV = bgPsd[bgIdx] || 0;
    }
    // R46: 배경이 신호의 70% 이상을 차감하지 못하도록 clamp
    // (배경 측정이 잡음을 과하게 포함했을 때 실제 공진까지 제거하는 것 방지)
    var bgMax = p.v * 0.7;
    var bgEffective = Math.min(bgV, bgMax);
    var v = Math.max(0, p.v - bgEffective);
    return { f: p.f, v: v > threshold ? v : 0, var: p.var || 0 };
  });
}


// ══════════════════════════════════════════════════════
// 팬 스펙트럼 차감 (전체 PSD 빈별)
// ══════════════════════════════════════════════════════

var _fanHotendPsd = null;
var _fanPartsPsd = null;
var _fanPartsSpeed = 100;

function loadFanPeaks(fanData) {
  _fanHotendPsd = null;
  _fanPartsPsd = null;
  if (!fanData) return;
  if (fanData.hotend) _fanHotendPsd = fanData.hotend;
  if (fanData.parts) _fanPartsPsd = fanData.parts;
  if (Array.isArray(fanData) && fanData.length > 0 && !fanData.hotend) {
    _fanHotendPsd = fanData;
  }
}

function filterFanPeaks(psd) {
  if (!psd || psd.length === 0) return psd;
  var hasHotend = _fanHotendPsd && _fanHotendPsd.length > 0;
  var hasParts = _fanPartsPsd && _fanPartsPsd.length > 0;
  if (!hasHotend && !hasParts) return psd;

  // 빈 해상도 자동 감지 (PSD 간격의 절반 + 여유)
  var binRes = psd.length > 1 ? Math.abs(psd[1].f - psd[0].f) : 3.125;
  var matchTol = binRes * 0.6; // 빈 간격의 60% = 안전 매칭 범위

  var partsRatio = _fanPartsSpeed / 100;

  return psd.map(function(p) {
    var fanContrib = 0;
    if (hasHotend) {
      for (var i = 0; i < _fanHotendPsd.length; i++) {
        var hp = _fanHotendPsd[i];
        if (Math.abs((hp.f || hp.freq || 0) - p.f) < matchTol) { fanContrib += hp.v || hp.power || 0; break; }
      }
    }
    if (hasParts && partsRatio > 0) {
      for (var i = 0; i < _fanPartsPsd.length; i++) {
        var pp = _fanPartsPsd[i];
        if (Math.abs((pp.f || pp.freq || 0) - p.f) < matchTol) { fanContrib += (pp.v || pp.power || 0) * partsRatio; break; }
      }
    }
    if (fanContrib < 1e-12) return p;
    var remaining = Math.max(0, p.v - fanContrib);
    var fanRatio = p.v > 1e-12 ? fanContrib / p.v : 0;
    return { f: p.f, v: remaining, var: p.var || 0, fan: fanRatio > 0.8, fanContrib: fanContrib, fanRatio: fanRatio, original: p.v };
  });
}


// ══════════════════════════════════════════════════════
// 하모닉 정수비 필터



// ══════════════════════════════════════════════════════
// 통합 피크 검출 — 전체 시스템의 유일한 피크 검출
// ══════════════════════════════════════════════════════

var MAX_DETECT_PEAKS = 8;

function detectPeaks(psd, opts) {
  if (!psd || psd.length < 5) return [];
  var kin = (opts && opts.kin) || 'corexy';
  var axis = (opts && opts.axis) || 'x';
  var minProm = (opts && opts.minProm) || 0.2;
  var minRel = (opts && opts.minRel) || 0.1;
  var minSep = (opts && opts.minSep) || 4;

  // 1. 노이즈 플로어
  var vals = psd.filter(function(p){ return p.f >= filterFreqMin && p.f <= filterFreqMax; })
               .map(function(p){ return p.v; });
  vals.sort(function(a,b){ return a - b; });
  var noiseFloor = vals[Math.floor(vals.length * filterNoiseFloorPct)] || 0;
  var threshold = noiseFloor * filterNoiseMultiplier;
  var pkGlobal = vals.length > 0 ? vals[vals.length - 1] : 1e-12;
  if (pkGlobal < 1e-12) return [];

  // 2. 후보 수집
  var candidates = [];
  for (var i = 1; i < psd.length - 1; i++) {
    if (psd[i].f < filterFreqMin || psd[i].f > filterFreqMax) continue;
    if (psd[i].v <= threshold || psd[i].v <= psd[i-1].v || psd[i].v <= psd[i+1].v) continue;
    var lo = Math.max(0, i-4), hi = Math.min(psd.length-1, i+4);
    var lMin = psd[lo].v;
    for (var j = lo; j < i; j++) if (psd[j].v < lMin) lMin = psd[j].v;
    var rMin = psd[i+1].v;
    for (var j = i+1; j <= hi; j++) if (psd[j].v < rMin) rMin = psd[j].v;
    var surMin = Math.max(lMin, rMin);
    var prom = psd[i].v > 1e-12 ? (psd[i].v - surMin) / psd[i].v : 0;
    var rel = psd[i].v / pkGlobal;
    if (prom < minProm || rel < minRel) continue;
    candidates.push({ idx: i, f: psd[i].f, v: psd[i].v, prom: prom, rel: rel,
      snr: noiseFloor > 0 ? psd[i].v / noiseFloor : 0,
      isFan: !!psd[i].fan, fanRatio: psd[i].fanRatio || 0 });
  }

  // 3. NMS
  candidates.sort(function(a,b){ return b.v - a.v; });
  var selected = [];
  for (var i = 0; i < candidates.length && selected.length < MAX_DETECT_PEAKS; i++) {
    var c = candidates[i], tooClose = false;
    for (var j = 0; j < selected.length; j++) {
      if (Math.abs(c.f - selected[j].f) < minSep) { tooClose = true; break; }
    }
    if (!tooClose) selected.push(c);
  }

  // 4. 줌 정밀화
  for (var i = 0; i < selected.length; i++) {
    var z = zoomPeakRefine(psd, selected[i].f);
    if (z.improved) selected[i].f = z.freq;
    selected[i].damping = z.damping || 0;
    selected[i].Q = z.Q || 0;
    selected[i].adjacentPeak = z.adjacentPeak || false;
    selected[i].secondPeak = z.secondPeak || null;
  }

  // 5. 하모닉 체크 — 최소 오차 매칭 (여러 기본파 후보 중 가장 정확한 것 선택)
  for (var i = 0; i < selected.length; i++) {
    selected[i].isHarmonic = false;
    selected[i].harmonicOf = null;
    selected[i].harmonicOrder = 0;
    var bestErr = 1, bestJ = -1, bestR = 0;
    for (var j = 0; j < i; j++) {
      // R11.2: 하드코딩 15Hz → filterFreqMin (18.75Hz)으로 통일
      // 저주파 프레임 공진(18~25Hz) 기본파의 하모닉이 누락되던 문제 수정
      if (selected[j].f < filterFreqMin) continue;
      var ratio = selected[i].f / selected[j].f, rounded = Math.round(ratio);
      if (rounded >= 2 && rounded <= 6) {
        // R44: 5% 허용오차 → 3%로 강화 (4.9× 처럼 경계값이 오분류되던 문제)
        var err = Math.abs(ratio - rounded) / rounded;
        if (err < 0.03 && err < bestErr) { bestErr = err; bestJ = j; bestR = rounded; }
      }
    }
    if (bestJ >= 0) {
      selected[i].isHarmonic = true;
      selected[i].harmonicOf = selected[bestJ].f;
      selected[i].harmonicOrder = bestR;
    }
  }

  // 6. 키네마틱 존 분류
  if (typeof classifyKinPeakZones === 'function') {
    var zoned = classifyKinPeakZones(selected, kin, axis);
    for (var i = 0; i < selected.length && i < zoned.length; i++) {
      selected[i].zone = zoned[i].zone;
      selected[i].zone_ko = zoned[i].ko;
      selected[i].zone_en = zoned[i].en;
      selected[i].act_ko = zoned[i].act_ko;
      selected[i].act_en = zoned[i].act_en;
    }
  }

  selected.sort(function(a,b){ return a.f - b.f; });
  return selected;
}


// ══════════════════════════════════════════════════════
// 줌 피크 정밀화 (Lorentzian 피팅)
// ══════════════════════════════════════════════════════

function zoomPeakRefine(psd, approxFreq) {
  if (!psd || psd.length < 5 || approxFreq < 15) return { freq: approxFreq, damping: 0.1, Q: 5, improved: false };
  var pkIdx = 0, pkV = 0;
  for (var i = 0; i < psd.length; i++) {
    if (Math.abs(psd[i].f - approxFreq) < 10 && psd[i].v > pkV) { pkV = psd[i].v; pkIdx = i; }
  }
  if (pkV < 1e-12) return { freq: approxFreq, damping: 0.1, Q: 5, improved: false };

  var lo = Math.max(0, pkIdx - 7), hi = Math.min(psd.length - 1, pkIdx + 7);
  var fitBins = [];
  for (var k = lo; k <= hi; k++) fitBins.push({ f: psd[k].f, v: psd[k].v });

  var A = pkV;
  var C = Math.min.apply(null, fitBins.map(function(b) { return b.v; })) * 0.5;
  var bestF0 = approxFreq, bestGamma = approxFreq * 0.1, bestErr = 1e30;

  for (var df = -1.5; df <= 1.5; df += 0.1) {
    for (var g = 0.5; g <= 15; g += 0.3) {
      var f0 = psd[pkIdx].f + df, err = 0;
      for (var i = 0; i < fitBins.length; i++) {
        var pred = (A - C) / (1 + Math.pow((fitBins[i].f - f0) / g, 2)) + C;
        err += Math.pow(fitBins[i].v - pred, 2);
      }
      if (err < bestErr) { bestErr = err; bestF0 = f0; bestGamma = g; }
    }
  }

  var adjacentPeak = bestGamma > (bestF0 * 0.15);
  var secondPeak = null;
  if (adjacentPeak && fitBins.length >= 8) {
    var residual = fitBins.map(function(b) {
      return { f: b.f, v: Math.max(0, b.v - ((A - C) / (1 + Math.pow((b.f - bestF0) / (bestGamma * 0.5), 2)) + C)) };
    });
    var r2Max = 0, r2F = 0;
    for (var i = 1; i < residual.length - 1; i++) {
      if (residual[i].v > r2Max && Math.abs(residual[i].f - bestF0) > 2) { r2Max = residual[i].v; r2F = residual[i].f; }
    }
    if (r2Max > pkV * 0.15 && r2F > 0) secondPeak = { freq: r2F, power: r2Max };
  }

  return { freq: bestF0, damping: bestGamma / bestF0, Q: bestF0 / (2 * bestGamma),
    gamma: bestGamma, improved: Math.abs(bestF0 - approxFreq) > 0.05,
    adjacentPeak: adjacentPeak, secondPeak: secondPeak };
}
