// ============ FEMTO SHAPER v0.8 ============
//
// Klipper shaper_calibrate.py / shaper_defs.py JS
// : https://github.com/Klipper3d/klipper
// Copyright (C) 2020-2024 Dmitry Butyugin <dmbutyugin@google.com>
// License: GNU GPLv3 (Klipper )
//
// :
// - _get_shaper_smoothing() calcSmoothing()
// - find_shaper_max_accel() calcMaxAccel() ( )
// - _estimate_remaining_vibrations() calcVibrationRemaining()
// - _estimate_shaper() estimateShaperResponse()
// - damping ratio worst-case (TEST_DAMPING_RATIOS)
//
// FEMTO :
// - getShaperDefs() A/T
// - estimateDampingRatio() PSD -3dB
// - analyzeShaper() +

// Klipper
const DEFAULT_DAMPING = 0.1;

// Klipper: SHAPER_VIBRATION_REDUCTION = 20 ( )
// PSD 1/20 ( )
const SHAPER_VIBRATION_REDUCTION = 20;

// Klipper: worst-case
const TEST_DAMPING_RATIOS = [0.075, 0.1, 0.15];

// Klipper: max_accel
const TARGET_SMOOTHING = 0.12;

// Klipper: SCV (Square Corner Velocity)
// SCV: _scv() settings.js getCfgScv() (Phase 5)
const DEFAULT_SCV = 5.0;

// Settings (Phase 5)
function _scv()      { return typeof getCfgScv      === 'function' ? getCfgScv()      : DEFAULT_SCV; }
function _damping()  { return typeof getCfgDamping  === 'function' ? getCfgDamping()  : DEFAULT_DAMPING; }
function _targetSm() { return typeof getCfgTargetSm === 'function' ? getCfgTargetSm() : TARGET_SMOOTHING; }

//
// Phase 2: H(f) = X(f) / F(f)
// OMA EMA : jerk PSD
//
// H1 (auto-spectrum ):
// |H(f)|^2 G_xx(f) / G_ff(f)
// G_xx = output PSD (measPsd), G_ff = input PSD (measJerk)
//
// :
// - F(f) 0 bin divison noise floor
// - SNR bin penalty
// - F(f)
//
function computeTransferFunction(psdOut, psdInput, opts) {
  opts = opts || {};
  const n = (psdOut && psdOut.length) || 0;
  if (!n || !psdInput || psdInput.length === 0) return null;

  // 1) PSD ( 2 bin )
  const smoothed = new Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - 2), hi = Math.min(n - 1, i + 2);
    let sum = 0, cnt = 0;
    for (let j = lo; j <= hi; j++) {
      const v = (typeof psdInput[j] === 'object') ? psdInput[j].v : psdInput[j];
      if (isFinite(v)) { sum += v; cnt++; }
    }
    smoothed[i] = cnt > 0 ? sum / cnt : 0;
  }

  // 2) ( 1%) 0-division
  let maxInput = 0;
  for (let i = 0; i < n; i++) if (smoothed[i] > maxInput) maxInput = smoothed[i];
  const noiseFloor = Math.max(maxInput * 0.01, 1e-9);

  // 3) H(f) = X(f) / F(f) ( )
  const H = new Array(n);
  for (let i = 0; i < n; i++) {
    const fIn = Math.max(smoothed[i], noiseFloor);
    const xVal = psdOut[i].v;
    const coherence = Math.min(1, smoothed[i] / maxInput);  // 0~1
    H[i] = {
      f: psdOut[i].f,
      v: xVal / fIn,           // |H(f)|^2
      coherence: coherence,    //
      rawV: xVal,              // PSD
      inputV: smoothed[i],     //
    };
  }
  return H;
}

// Phase 1-B (v3): -
//
// (test/sim_diagnostics.js, test/sim_ci_validate.js):
// v1: = f / ( SNR n_eff) CI (30-37% cov)
// v2: 1.5 f relVar CI (100% cov, 10 )
// v3: 0.15 f + 0.15 f max(relVar-0.5, 0) 95% cov,
//
// (3200Hz , 1024pt FFT, 10s ):
// relVar : mean=0.69, range 0.43-0.96 (Welch / )
// actual : ~0.5 Hz ( )
// binWidth 0.17 0.53Hz
function computePeakCI(psdData, peakFreq, opts) {
  opts = opts || {};
  if (!psdData || psdData.length < 3 || !peakFreq) return null;

  let peakIdx = -1, bestDist = Infinity;
  for (let i = 0; i < psdData.length; i++) {
    const d = Math.abs(psdData[i].f - peakFreq);
    if (d < bestDist) { bestDist = d; peakIdx = i; }
  }
  if (peakIdx < 0) return null;

  const binWidth = psdData.length > 1 ? Math.abs(psdData[1].f - psdData[0].f) : 3.125;
  const peakPower = psdData[peakIdx].v;
  const peakVar = psdData[peakIdx].var || 0;
  if (peakPower <= 0) return null;

  const peakStd = Math.sqrt(peakVar);
  const relVar = peakStd / Math.max(peakPower, 1e-12);
  const snr = peakPower / Math.max(peakStd, peakPower * 0.01);

  // ( 95% coverage ):
  // baseline: 0.15 binWidth (~0.47Hz fixed floor)
  // high-var: 0.15 binWidth excess ( )
  const sigma_f = 0.15 * binWidth
                + 0.15 * binWidth * Math.max(0, relVar - 0.5);

  return {
    lo: peakFreq - 1.96 * sigma_f,
    hi: peakFreq + 1.96 * sigma_f,
    sigma: sigma_f,
    snr: snr,
    relVar: relVar,
    peakIdx: peakIdx,
  };
}

//
// : Deflation
//
// test/sim_diagnostics.js :
// Moderate gap ( =10Hz): 8.38Hz deflation 2.42Hz (3.5 )
// Equal amp ( =8Hz): 5.11Hz deflation 1.10Hz (4.6 )
//
// : Lorentzian PSD
//
//
function detectPeaksDeflation(psd, detectFn, opts) {
  opts = opts || {};
  const maxPeaks = opts.maxPeaks || 4;
  if (!psd || psd.length < 10) return [];
  // Clone PSD for mutation
  const workPsd = psd.map(p => ({ f: p.f, v: p.v, var: p.var || 0 }));
  const selected = [];
  for (let iter = 0; iter < maxPeaks; iter++) {
    const pks = detectFn(workPsd);
    if (!pks || pks.length === 0) break;
    // Take strongest peak in residual
    const pk = pks[0];
    selected.push(pk);
    // Subtract Lorentzian fit (reuse zoomPeakRefine if available)
    let f0 = pk.f, gamma = (pk.damping || 0.1) * pk.f;
    if (typeof zoomPeakRefine === 'function') {
      const r = zoomPeakRefine(workPsd, pk.f);
      if (r && r.freq) { f0 = r.freq; gamma = Math.max(1.0, (r.damping || 0.1) * f0); }
    }
    const A = pk.v;
    // Baseline: 30th percentile away from peak
    const farBins = workPsd.filter(p => Math.abs(p.f - f0) > 15).map(p => p.v).sort((a,b) => a-b);
    const baseline = farBins.length > 0 ? farBins[Math.floor(farBins.length * 0.3)] : 0;
    for (let i = 0; i < workPsd.length; i++) {
      const lorz = (A - baseline) / (1 + Math.pow((workPsd[i].f - f0) / gamma, 2));
      workPsd[i].v = Math.max(baseline, workPsd[i].v - lorz);
    }
  }
  return selected;
}


// A/T
// Klipper shaper_defs.py init_func
// A( ), T( )
//
// MZV T : Opus+GPT 39 t_d=1/(freq*df), T=[0,0.5*t_d,t_d]
// shaper_defs.py ( raw )
function getShaperDefs(freq, damping) {
  if (!freq || freq <= 0 || !isFinite(freq)) return [];
  damping = damping || DEFAULT_DAMPING;
  // 1.0 sqrt(1- ) 0 NaN
  // 3D 0.01~0.5
  if (damping >= 1.0) damping = 0.99;
  if (damping <= 0) damping = DEFAULT_DAMPING;

  // Klipper shaper_defs.py
  // : github.com/Klipper3d/klipper/blob/master/klippy/extras/shaper_defs.py
  // License: GPL v3

  const v_tol = 1.0 / SHAPER_VIBRATION_REDUCTION; // = 0.05

  const shapers = [];

  // ZV
  // K = exp(- /df), A=[1, K], T=[0, 0.5*t_d]
  {
    const df  = Math.sqrt(1 - damping * damping);
    const K   = Math.exp(-damping * Math.PI / df);
    const t_d = 1.0 / (freq * df);
    shapers.push({ name: 'ZV', A: [1, K], T: [0, 0.5 * t_d] });
  }

  // MZV
  // Klipper : K = exp(-0.75* /df) ZV K!
  // a1 = 1 - 1/ 2, a2 = ( 2-1)*K, a3 = a1*K
  // T = [0, 0.375*t_d, 0.75*t_d]
  {
    const df  = Math.sqrt(1 - damping * damping);
    const K   = Math.exp(-0.75 * damping * Math.PI / df);
    const t_d = 1.0 / (freq * df);
    const a1 = 1.0 - 1.0 / Math.SQRT2;
    const a2 = (Math.SQRT2 - 1.0) * K;
    const a3 = a1 * K * K;
    shapers.push({ name: 'MZV', A: [a1, a2, a3], T: [0, 0.375 * t_d, 0.75 * t_d] });
  }

  // EI
  // Klipper : K = exp(- /df)
  // a1 = 0.25*(1+v_tol), a2 = 0.5*(1-v_tol)*K, a3 = a1*K
  // T = [0, 0.5*t_d, t_d]
  {
    const df  = Math.sqrt(1 - damping * damping);
    const K   = Math.exp(-damping * Math.PI / df);
    const t_d = 1.0 / (freq * df);
    const a1 = 0.25 * (1.0 + v_tol);
    const a2 = 0.5  * (1.0 - v_tol) * K;
    const a3 = a1 * K * K;
    shapers.push({ name: 'EI', A: [a1, a2, a3], T: [0, 0.5 * t_d, t_d] });
  }

  // 2HUMP_EI
  // Klipper : get_2hump_ei_shaper() 4
  // V2 = v_tol , X = (V2*(sqrt(1-V2)+1))^(1/3)
  // a1 = (3X +2X+3V2)/(16X), a2 = (0.5-a1)*K, a3 = a2*K, a4 = a1*K
  // T = [0, 0.5*t_d, t_d, 1.5*t_d]
  {
    const df  = Math.sqrt(1 - damping * damping);
    const K   = Math.exp(-damping * Math.PI / df);
    const t_d = 1.0 / (freq * df);
    const V2  = v_tol * v_tol;
    const X   = Math.pow(V2 * (Math.sqrt(1.0 - V2) + 1.0), 1.0 / 3.0);
    const a1  = (3.0*X*X + 2.0*X + 3.0*V2) / (16.0*X);
    const a2  = (0.5 - a1) * K;
    const a3  = a2 * K;
    const a4  = a1 * K * K * K;
    shapers.push({ name: '2HUMP_EI', A: [a1, a2, a3, a4], T: [0, 0.5*t_d, t_d, 1.5*t_d] });
  }

  // 3HUMP_EI
  // Klipper : get_3hump_ei_shaper()
  // a1 = 0.0625*(1+3*v_tol+2*sqrt(2*(v_tol+1)*v_tol))
  // a2 = 0.25*(1-v_tol)*K
  // a3 = (0.5*(1+v_tol)-2*a1)*K
  // a4 = a2*K
  // a5 = a1*K
  // T = [0, 0.5*t_d, t_d, 1.5*t_d, 2.0*t_d]
  {
    const df  = Math.sqrt(1 - damping * damping);
    const K   = Math.exp(-damping * Math.PI / df);
    const t_d = 1.0 / (freq * df);
    const K2  = K * K;
    const a1 = 0.0625 * (1.0 + 3.0 * v_tol + 2.0 * Math.sqrt(2.0 * (v_tol + 1.0) * v_tol));
    const a2 = 0.25 * (1.0 - v_tol) * K;
    const a3 = (0.5 * (1.0 + v_tol) - 2.0 * a1) * K2;
    const a4 = a2 * K2;
    const a5 = a1 * K2 * K2;
    shapers.push({ name: '3HUMP_EI', A: [a1, a2, a3, a4, a5], T: [0, 0.5*t_d, t_d, 1.5*t_d, 2.0*t_d] });
  }

  return shapers.map(s => {
    s.duration = s.T[s.T.length - 1];
    return s;
  });
}


//
// Klipper _estimate_shaper()
//
//
// Klipper (graph_shaper.py):
//   W = A[i] * exp(-damping * (T[-1] - T[i]))
//   S += W * sin(omega_d * T[i])
//   C += W * cos(omega_d * T[i])
// return sqrt(S + C ) * inv_D
function estimateShaperResponse(shaper, testFreq, dampingRatio) {
  const A = shaper.A;
  const T = shaper.T;
  const n = A.length;
  const invD = 1.0 / A.reduce((s, a) => s + a, 0);

  const omega = 2 * Math.PI * testFreq;
  const damping = dampingRatio * omega;
  const omegaD = omega * Math.sqrt(1 - dampingRatio * dampingRatio);

  let S = 0, C = 0;
  for (let i = 0; i < n; i++) {
    // Klipper: W = A[i] * exp(-damping * (T[last] - T[i]))
    //
    const W = A[i] * Math.exp(-damping * (T[n - 1] - T[i]));
    S += W * Math.sin(omegaD * T[i]);
    C += W * Math.cos(omegaD * T[i]);
  }

  return Math.sqrt(S * S + C * C) * invD;
}


//
// Klipper _estimate_remaining_vibrations()
//
// ( FEMTO vs Klipper):
// 1. SHAPER_VIBRATION_REDUCTION
// 2. damping ratio worst-case
// 3. PSD (v) (v Klipper PSD power)
//
// @param {Array} psdData - [{f, v}] PSD
// @param {object} shaper - {A[], T[]}
// @param {number} dampingRatio -
// @returns {number} (0~1)
function calcVibrationRemainingForDR(psdData, shaper, dampingRatio) {
  if (!psdData || psdData.length === 0) return 1;

  // PSD (Klipper: psd.max() / SHAPER_VIBRATION_REDUCTION)
  let psdMax = 0;
  for (const d of psdData) {
    if (d.v > psdMax) psdMax = d.v;
  }
  const vibrThreshold = psdMax / SHAPER_VIBRATION_REDUCTION;

  let remainingVibrations = 0;
  let allVibrations = 0;

  for (const d of psdData) {
    if (d.f <= 0 || d.f > 200) continue; // Klipper: MAX_FREQ = 200

    //
    const response = estimateShaperResponse(shaper, d.f, dampingRatio);

    // Klipper: remaining = max(vals * psd - threshold, 0).sum()
    // Klipper: all = max(psd - threshold, 0).sum()
    const psdVal = d.v;
    remainingVibrations += Math.max(response * psdVal - vibrThreshold, 0);
    allVibrations += Math.max(psdVal - vibrThreshold, 0);
  }

  return allVibrations > 0 ? remainingVibrations / allVibrations : 1;
}

/* *
* damping ratio worst-case
* Klipper: TEST_DAMPING_RATIOS = [0.075, 0.1, 0.15]
  */
function calcVibrationRemaining(psdData, shaper) {
  let worstVibr = 0;
  for (const dr of TEST_DAMPING_RATIOS) {
    const vibr = calcVibrationRemainingForDR(psdData, shaper, dr);
    if (vibr > worstVibr) worstVibr = vibr;
  }
  return worstVibr;
}


//
// Klipper _get_shaper_smoothing()
//
// Klipper :
// ts = (A[i]*T[i]) / (A[i])
// T[i] >= ts :
//     offset_90  += A[i] * (scv + half_accel*(T[i]-ts)) * (T[i]-ts)
// offset_180 += A[i] * half_accel * (T[i]-ts)
// smoothing = max(offset_90 * 2 * inv_D, offset_180 * inv_D)
//
// @param {object} shaper - {A[], T[]}
// @param {number} accel - (mm/s , 5000)
// @param {number} scv - Square Corner Velocity (mm/s, 5)
// @returns {number} (mm)
function calcSmoothing(shaper, accel, scv) {
  accel = accel || 5000;
  if (!isFinite(accel) || accel <= 0) accel = 5000;
  scv = scv || DEFAULT_SCV;
  if (!isFinite(scv)) scv = DEFAULT_SCV;

  const A = shaper.A;
  const T = shaper.T;
  const n = A.length;
  const halfAccel = accel * 0.5;
  const invD = 1.0 / A.reduce((s, a) => s + a, 0);

  // (Klipper: ts)
  let sumAT = 0, sumA = 0;
  for (let i = 0; i < n; i++) {
    sumAT += A[i] * T[i];
    sumA += A[i];
  }
  const ts = sumAT / sumA;

  // 90 /180
  let offset90 = 0, offset180 = 0;
  for (let i = 0; i < n; i++) {
    if (T[i] >= ts) {
      const dt = T[i] - ts;
      // 90 : SCV +
      offset90 += A[i] * (scv + halfAccel * dt) * dt;
      // 180 :
      offset180 += A[i] * halfAccel * dt * dt;
    }
  }
  offset90 *= invD * Math.SQRT2;
  offset180 *= invD;

  return Math.max(offset90, offset180);
}


//
// Klipper find_shaper_max_accel()
//
// Klipper :
//   TARGET_SMOOTHING = 0.12
// max_accel = bisect( accel: smoothing(shaper, accel, scv) 0.12)
//
// (bisection) smoothing TARGET_SMOOTHING
//
//
// @param {object} shaper - {A[], T[]}
// @param {number} scv - Square Corner Velocity ( 5)
// @returns {number} (mm/s )
function calcMaxAccel(shaper, scv) {
  scv = scv || _scv();
  const targetSmoothing = _targetSm();
  // R36: shaper ( )
  if (!shaper || !Array.isArray(shaper.A) || !Array.isArray(shaper.T) || shaper.A.length === 0) {
    return 0;
  }
  if (!isFinite(scv) || scv <= 0) scv = DEFAULT_SCV;
  if (!isFinite(targetSmoothing) || targetSmoothing <= 0) return 0;

  // Klipper _bisect()
  let left = 1, right = 1;

  // accel smoothing 0
  if (calcSmoothing(shaper, 1e-9, scv) > targetSmoothing) {
    return 0;
  }

  //
  while (calcSmoothing(shaper, right, scv) <= targetSmoothing) {
    right *= 2;
    if (right > 1e7) return right; //
  }

  // left OK, right
  // left OK
  left = right * 0.5;
  while (calcSmoothing(shaper, left, scv) > targetSmoothing) {
    right = left;
    left *= 0.5;
  }

  // (Klipper: right - left > 1e-8)
  for (let iter = 0; iter < 100; iter++) {
    if (right - left <= 1) break; // mm/s 1
    const mid = (left + right) * 0.5;
    if (calcSmoothing(shaper, mid, scv) <= targetSmoothing) {
      left = mid;
    } else {
      right = mid;
    }
  }

  return Math.round(left);
}


// v0.9
// JS = ESP32 3.125Hz PSD
//
// 1. 3 Parabolic : 0.1Hz
// 2. Lorentzian : ( -3dB )
// 3. Lorentzian :
// 4. : R

/* *
* 3 Parabolic sub-bin
* PSD[k-1], PSD[k], PSD[k+1]
* : ~0.1Hz ( 1/30)
  */
function parabolicPeakInterp(psd, peakIdx) {
  if (peakIdx < 1 || peakIdx >= psd.length - 1) return psd[peakIdx]?.f || 0;
  const y1 = psd[peakIdx-1].v, y2 = psd[peakIdx].v, y3 = psd[peakIdx+1].v;
  const denom = y1 - 2*y2 + y3;
  if (Math.abs(denom) < 1e-12) return psd[peakIdx].f;
  const delta = 0.5 * (y1 - y3) / denom;
  const df = psd.length > 1 ? psd[1].f - psd[0].f : 3.125;
  return psd[peakIdx].f + delta * df;
}

/* *
* Lorentzian
* PSD = Lorentzian : L(f) = A / (1 + ((f-f0)/ ) )
* f0 = , = HWHM, A =
* damping = / f0
 *
* : 3 f0
 *
 * @returns {f0, amplitude, gamma, damping, rSquared, fitted[]}
  */
function fitLorentzian(psd, peakIdx) {
  if (!psd || peakIdx < 2 || peakIdx >= psd.length - 2) {
    return { f0: psd?.[peakIdx]?.f || 0, amplitude: 0, gamma: 3, damping: DEFAULT_DAMPING, rSquared: 0 };
  }

  // 1 : Parabolic f0
  const f0Init = parabolicPeakInterp(psd, peakIdx);
  const A = psd[peakIdx].v;
  if (A <= 0) return { f0: f0Init, amplitude: 0, gamma: 3, damping: DEFAULT_DAMPING, rSquared: 0 };

  // 2 : Lorentzian
  // L(f) = A / (1 + ((f-f0)/ ) ) = (f-f0) / (A/L(f) - 1)
  const gammaEstimates = [];
  const fitRange = Math.min(8, Math.floor(psd.length / 4)); // 8 ( 25Hz)
  for (let di = -fitRange; di <= fitRange; di++) {
    const idx = peakIdx + di;
    if (idx < 0 || idx >= psd.length || di === 0) continue;
    const Li = psd[idx].v;
    if (Li <= 0 || Li >= A * 0.99) continue; // 0
    const ratio = A / Li;
    if (ratio <= 1) continue;
    const df = psd[idx].f - f0Init;
    const gamma2 = df * df / (ratio - 1);
    if (gamma2 > 0 && gamma2 < 10000) {
      gammaEstimates.push({ gamma: Math.sqrt(gamma2), weight: Li / A }); //
    }
  }

  // ( robust)
  let gamma = 3.0; // =0.075 @ 40Hz
  if (gammaEstimates.length >= 3) {
    gammaEstimates.sort((a, b) => a.gamma - b.gamma);
    const totalW = gammaEstimates.reduce((s, e) => s + e.weight, 0);
    let cumW = 0;
    for (const e of gammaEstimates) {
      cumW += e.weight;
      if (cumW >= totalW * 0.5) { gamma = e.gamma; break; }
    }
  } else if (gammaEstimates.length > 0) {
    gamma = gammaEstimates.reduce((s, e) => s + e.gamma, 0) / gammaEstimates.length;
  }

  // 3 : f0 Lorentzian (1D Newton)
  // L/ f0 = 0
  let f0 = f0Init;
  for (let iter = 0; iter < 10; iter++) {
    let num = 0, den = 0;
    for (let di = -fitRange; di <= fitRange; di++) {
      const idx = peakIdx + di;
      if (idx < 0 || idx >= psd.length) continue;
      const fi = psd[idx].f;
      const Li = psd[idx].v;
      const pred = A / (1 + Math.pow((fi - f0) / gamma, 2));
      const resid = Li - pred;
      const dPdf0 = 2 * A * (fi - f0) / (gamma * gamma * Math.pow(1 + Math.pow((fi - f0) / gamma, 2), 2));
      num += resid * dPdf0;
      den += dPdf0 * dPdf0;
    }
    if (Math.abs(den) < 1e-20) break;
    const step = num / den;
    f0 += step;
    if (Math.abs(step) < 0.01) break; // 0.01Hz
  }

  // 4 : R
  let ssRes = 0, ssTot = 0;
  const meanV = psd.slice(Math.max(0, peakIdx - fitRange), peakIdx + fitRange + 1)
    .reduce((s, p) => s + p.v, 0) / (2 * fitRange + 1);
  for (let di = -fitRange; di <= fitRange; di++) {
    const idx = peakIdx + di;
    if (idx < 0 || idx >= psd.length) continue;
    const pred = A / (1 + Math.pow((psd[idx].f - f0) / gamma, 2));
    ssRes += Math.pow(psd[idx].v - pred, 2);
    ssTot += Math.pow(psd[idx].v - meanV, 2);
  }
  const rSquared = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;

  //
  const damping = f0 > 0 ? gamma / f0 : DEFAULT_DAMPING;

  return {
    f0: parseFloat(f0.toFixed(2)),
    amplitude: A,
    gamma: parseFloat(gamma.toFixed(3)),
    damping: Math.max(0.01, Math.min(0.5, parseFloat(damping.toFixed(4)))),
    rSquared: parseFloat(rSquared.toFixed(4)),
  };
}

// v1.0: decomposeMultiPeak detectPeaks()

/* *
* v0.9 Lorentzian ( -3dB )
 *
* :
* - 3.125Hz sub-bin (8 )
* - R
* - ( <0.05) ( : 1 )
  */
function estimateDampingRatio(psdData, peakFreq) {
  if (!psdData || !peakFreq || psdData.length < 5) return DEFAULT_DAMPING;

  //
  let peakIdx = 0, peakV = 0;
  for (let i = 0; i < psdData.length; i++) {
    if (Math.abs(psdData[i].f - peakFreq) < 3.2 && psdData[i].v > peakV) {
      peakV = psdData[i].v; peakIdx = i;
    }
  }
  if (peakV <= 0) return DEFAULT_DAMPING;

  const fit = fitLorentzian(psdData, peakIdx);

  // R ( Lorentzian )
  if (fit.rSquared < 0.5) return DEFAULT_DAMPING;

  return fit.damping;
}


// ( )
/* *
* PSD 5
 *
* v0.6 charts.js / app.js
 *
* @param {Array} psdData - [{f, v}] PSD
* @param {number} peakFreq - (Hz)
* @param {number} damping - (null )
* @param {Array} peaks - [{freq, power, prominence}] ( , )
 * @returns {object} {
 *   shapers: [{name, freq, vibrPct, maxAccel, smoothing, duration}],
 *   recommended: {performance: {}, lowVibration: {}, safe: {}},
 *   dampingRatio: number,
 *   multiPeak: {detected, peaks} | null
 * }
  */
function analyzeShaper(psdData, peakFreq, damping, peaks) {
  // PSD
  if (!psdData || psdData.length === 0) {
    const empty = {name:'ZV',freq:0,vibrPct:100,maxAccel:0,smoothing:1,duration:0,_A:[1],_T:[0],_score:0};
    return { shapers:[empty], recommended:{performance:empty,safe:empty,best:empty}, confidence:0, multiPeak:null };
  }
  // peakFreq (0/NaN/Infinity PSD )
  if (!isFinite(peakFreq) || peakFreq <= 0) {
    let maxV=0;peakFreq=40;
    for(const p of psdData) if(p.f>=18&&p.f<=150&&isFinite(p.v)&&p.v>maxV){maxV=p.v;peakFreq=p.f;}
    if(peakFreq<=0) peakFreq=40;
  }
  // PSD NaN/Infinity
  psdData = psdData.map(p => ({f: p.f, v: isFinite(p.v) ? p.v : 0, var: p.var || 0}));

  // v0.9:
  // = =
  // = =
  const hasVariance = psdData.some(p => p.var > 0);
  let binWeights = null;
  if (hasVariance) {
    const maxVar = Math.max(...psdData.map(p => p.var), 1e-12);
    binWeights = psdData.map(p => {
      if (p.var <= 0 || p.v <= 0) return 1.0;
      // = 1 / (1 + CV ), CV = var / mean
      const cv = Math.sqrt(p.var) / Math.max(p.v, 1e-12);
      return 1.0 / (1.0 + cv * cv);
    });
  }

  // v1.0: detectPeaks , fitLorentzian
  if (!damping && peaks && peaks.length > 0 && peaks[0].damping > 0) {
    damping = peaks[0].damping;
  }
  if (!damping) {
    damping = estimateDampingRatio(psdData, peakFreq);
  }

  // ( )
  let freqCI = null;
  if (peaks && peaks[0] && peaks[0].Q > 0) {
    const gamma = peaks[0].gamma || peakFreq * damping;
    const snr = Math.max(peaks[0].snr || 1, 1);
    const sigmaF = gamma / (snr * Math.sqrt(10));
    freqCI = { lower: peakFreq - 1.96 * sigmaF, upper: peakFreq + 1.96 * sigmaF, sigma: sigmaF };
  }

  // PSD
  const psdMax = Math.max(...psdData.map(d => d.v));
  const psdNorm = psdMax > 0
    ? psdData.map((d, i) => ({
        f: d.f,
        v: d.v / psdMax * (binWeights ? binWeights[i] : 1.0)
      }))
    : psdData;

  // v0.9: PSD Cubic (3.125Hz 0.5Hz)
  // : 3.125Hz 1Hz
  // 1.5Hz
  // Catmull-Rom 0.5Hz PSD
  function interpolatePSD(psd, step) {
    if (!psd || psd.length < 4) return psd;
    const result = [];
    for (let f = psd[0].f; f <= psd[psd.length-1].f; f += step) {
      // 4
      let idx = 0;
      for (let i = 0; i < psd.length - 1; i++) {
        if (psd[i].f <= f && psd[i+1].f > f) { idx = i; break; }
        if (i === psd.length - 2) idx = i;
      }
      const i0 = Math.max(0, idx - 1);
      const i1 = idx;
      const i2 = Math.min(psd.length - 1, idx + 1);
      const i3 = Math.min(psd.length - 1, idx + 2);
      // Catmull-Rom
      const t = (psd[i2].f > psd[i1].f) ? (f - psd[i1].f) / (psd[i2].f - psd[i1].f) : 0;
      const t2 = t * t, t3 = t2 * t;
      const v = 0.5 * (
        (2 * psd[i1].v) +
        (-psd[i0].v + psd[i2].v) * t +
        (2*psd[i0].v - 5*psd[i1].v + 4*psd[i2].v - psd[i3].v) * t2 +
        (-psd[i0].v + 3*psd[i1].v - 3*psd[i2].v + psd[i3].v) * t3
      );
      result.push({ f: parseFloat(f.toFixed(1)), v: Math.max(0, v) });
    }
    return result;
  }
  const psdInterp = interpolatePSD(psdNorm, 0.5);  // 0.5Hz

  const cfgScv = _scv();

  //
  // Klipper calibrate_shaper.py :
  //
  // v0.9 :
  // PSD: 3.125Hz 0.5Hz Catmull-Rom ( )
  // : 0.2Hz (Klipper numpy arange )
  // 5 675 = 3375 vibr% 50ms (JS )
  //

  const VIBR_THRESHOLD = 5.0; // Klipper: vibr% 5%
  const SHAPER_NAMES = ['ZV', 'MZV', 'EI', '2HUMP_EI', '3HUMP_EI'];

  const freqMin = 15;
  const freqMax = 150;
  const freqStep = 0.2;  // v0.9: Klipper ( 1.0Hz)

  const shapers = [];

  for (const shaperName of SHAPER_NAMES) {
    let bestVibr = Infinity;
    let bestDefs = null;
    const sweepResults = [];

    // : vibr%, smoothing, score
    for (let testFreq = freqMin; testFreq <= freqMax; testFreq += freqStep) {
      const defs = getShaperDefs(testFreq, damping);
      const shaperDef = defs.find(s => s.name === shaperName);
      if (!shaperDef) continue;

      const vibrRatio = calcVibrationRemaining(psdInterp, shaperDef);
      const smoothing = calcSmoothing(shaperDef, 5000, cfgScv);

      // Klipper score (shaper_calibrate.py ):
      //   score = smoothing * (vibrations^1.5 + vibrations * 0.2 + 0.01)
      // "vibr% smoothing "
      const score = smoothing * (Math.pow(vibrRatio, 1.5) + vibrRatio * 0.2 + 0.01);

      if (vibrRatio < bestVibr) {
        bestVibr = vibrRatio;
      }
      sweepResults.push({ freq: testFreq, vibrRatio, vibrPct: vibrRatio * 100, smoothing, score, def: shaperDef });
    }

    // Klipper fit_shaper ( ):
    // 1. vibr% best_res
    // 2. best_res.vibrs * 1.1 + 0.0005 score
    // Klipper results[::-1] ( freq )
    const bestRes = sweepResults.reduce((a, b) => a.vibrRatio < b.vibrRatio ? a : b, sweepResults[0]);
    const vibrLimit = bestRes ? bestRes.vibrRatio * 1.1 + 0.0005 : Infinity;

    let selected = bestRes;
    for (let i = sweepResults.length - 1; i >= 0; i--) {
      const r = sweepResults[i];
      if (r.vibrRatio < vibrLimit && r.score < selected.score) {
        selected = r;
      }
    }

    if (!selected && sweepResults.length > 0) {
      selected = sweepResults.reduce((a, b) => a.vibrRatio < b.vibrRatio ? a : b);
    }

    // maxAccel 1
    let bestFreq = peakFreq, bestSmoothing = 0, bestMaxAccel = 0;
    if (selected) {
      bestDefs = selected.def;
      bestFreq = selected.freq;
      bestSmoothing = selected.smoothing;
      bestMaxAccel = calcMaxAccel(bestDefs, cfgScv);
    } else {
      // fallback:
      const fb = getShaperDefs(peakFreq, damping).find(s => s.name === shaperName);
      if (fb) {
        bestDefs = fb;
        bestVibr = calcVibrationRemaining(psdInterp, fb) * 100;
        bestSmoothing = calcSmoothing(fb, 5000, cfgScv);
        bestMaxAccel = calcMaxAccel(fb, cfgScv);
        bestFreq = peakFreq;
      }
    }

    shapers.push({
      name: shaperName,
      freq: parseFloat(bestFreq.toFixed(1)),
      vibrPct: parseFloat((selected ? selected.vibrPct : 100).toFixed(1)),
      maxAccel: bestMaxAccel,
      smoothing: parseFloat(bestSmoothing.toFixed(3)),
      duration: bestDefs ? bestDefs.duration : 0,
      _A: bestDefs ? bestDefs.A : [],
      _T: bestDefs ? bestDefs.T : [],
    });
  }

  // v0.9: vibr >= 90%
  const allHighVibr = shapers.every(s => s.vibrPct >= 90);
  if (allHighVibr && peakFreq >= 18) {
    for (const s of shapers) {
      const defs = getShaperDefs(peakFreq, damping).find(d => d.name === s.name);
      if (defs) {
        s.freq = parseFloat(peakFreq.toFixed(1));
        s.vibrPct = parseFloat((calcVibrationRemaining(psdInterp, defs) * 100).toFixed(1));
        s.smoothing = parseFloat(calcSmoothing(defs, 5000, cfgScv).toFixed(3));
        s.maxAccel = calcMaxAccel(defs, cfgScv);
      }
    }
  }

  // (Klipper )
  // Performance: vibr% 5% maxAccel (= smoothing )
  // Low vibration: vibr%
  const perfCandidates = shapers.filter(s => s.vibrPct <= VIBR_THRESHOLD);
  const performance = perfCandidates.length > 0
    ? perfCandidates.reduce((a, b) => a.maxAccel > b.maxAccel ? a : b)
    : shapers.reduce((a, b) => a.vibrPct < b.vibrPct ? a : b);
  const lowVibration = shapers.reduce((a, b) => a.vibrPct < b.vibrPct ? a : b);

  // Safe: vibr% 5% robust (2HUMP_EI/3HUMP_EI )
  const safeCandidates = shapers.filter(s =>
    s.vibrPct <= VIBR_THRESHOLD &&
    (s.name === '2HUMP_EI' || s.name === '3HUMP_EI' || s.name === 'EI')
  );
  const safe = safeCandidates.length > 0
    ? { ...safeCandidates.reduce((a, b) => a.vibrPct < b.vibrPct ? a : b), tag: 'safe' }
    : { ...lowVibration, tag: 'safe' };

  // Klipper find_best_shaper 5 1
  // Klipper (shaper_calibrate.py):
  //   score = smoothing * (vibr^1.5 + vibr*0.2 + 0.01)
  // best = score 20% ,
  // score 5% + smoothing 10%
  // ZV : vibr% 10%
  let bestShaper = null;
  for (const s of shapers) {
    const vibrRatio = s.vibrPct / 100;
    const score = s.smoothing * (Math.pow(vibrRatio, 1.5) + vibrRatio * 0.2 + 0.01);
    s._score = score;
    if (!bestShaper ||
        score * 1.2 < bestShaper._score ||
        (score * 1.05 < bestShaper._score && s.smoothing * 1.1 < bestShaper.smoothing)) {
      bestShaper = s;
    }
  }
  // ZV : ZV vibr% 10%
  if (bestShaper && bestShaper.name === 'ZV') {
    for (const s of shapers) {
      if (s.name !== 'ZV' && s.vibrPct * 1.1 < bestShaper.vibrPct) {
        bestShaper = s;
        break;
      }
    }
  }

  // : detectPeaks ( )
  let multiPeak = null;
  const dpPeaks = (peaks || []).filter(p => (p.f || p.freq) > 15 && !p.isHarmonic && !p.isFan);
  if (dpPeaks.length >= 2) {
    const sorted = dpPeaks.slice().sort((a, b) => (a.f || 0) - (b.f || 0));
    const maxP = Math.max(...sorted.map(p => p.v || p.power || 0));
    const minP = Math.min(...sorted.map(p => p.v || p.power || 0));
    const ratio = maxP > 0 ? minP / maxP : 0;
    const spread = (sorted[sorted.length-1].f || 0) - (sorted[0].f || 0);
    const totalP = sorted.reduce((s, p) => s + (p.v || p.power || 0), 0);
    const midFreq = sorted.reduce((s, p) => s + (p.f || 0) * (p.v || p.power || 0), 0) / (totalP || 1);
    const level = (ratio > 0.3 && spread > 8) ? 'confirmed'
                : (ratio > 0.15 && spread > 6) ? 'suspected' : null;
    if (level) {
      multiPeak = {
        detected: true, level,
        peaks: sorted.map(p => ({ freq: parseFloat((p.f || 0).toFixed(1)), power: p.v || p.power || 0 })),
        midFreq: parseFloat(midFreq.toFixed(1)),
        spread: parseFloat(spread.toFixed(1)),
        ratio: parseFloat(ratio.toFixed(2)),
        count: sorted.length,
      };
    }
  }

  // broad peak: Q factor ( )
  let broadPeak = null;
  const zoomQ = dpPeaks.length > 0 ? (dpPeaks[0].Q || 0) : 0;
  if (!multiPeak && zoomQ > 0 && zoomQ < 3) {
    broadPeak = { detected: true, Q: zoomQ, message: 'broad_response_mount_suspect' };
  }

  // confidence
  const psdPeak = Math.max(...psdData.map(d => d.v));
  const hfVals = psdData.filter(d => d.f >= 90).map(d => d.v).sort((a, b) => a - b);
  const nf = hfVals.length > 0 ? hfVals[Math.floor(hfVals.length / 2)] : 1e-12;
  const snrDb = nf > 1e-15 ? 10 * Math.log10(psdPeak / nf) : 0;
  const snrContrib = snrDb >= 6
    ? Math.min(0.6, 0.2 + (snrDb - 6) / 24 * 0.4)
    : Math.max(0, snrDb / 6 * 0.2);
  const segsContrib = 0.15;
  let peakContrib = 0.1;
  if (multiPeak?.level === 'confirmed') peakContrib = 0;
  else if (multiPeak?.level === 'suspected') peakContrib = 0.05;
  if (broadPeak) peakContrib = Math.max(0, peakContrib - 0.05);
  const confidence = Math.min(1.0, snrContrib + segsContrib + peakContrib);

  // Classification Layer (GPT P6 + )
  // 5 : single / dual_dominant / dual_balanced / broad / harmonic
  //
  // :
  // 1. broadPeak
  // 2. multiPeak
  // 3. 1 45%
  // dual single (fp )
  // 4. harmonic Quick/Print validator.js
  let resonanceMode = 'single';
  if (broadPeak) {
    resonanceMode = 'broad';
  } else if (multiPeak?.level === 'confirmed') {
    resonanceMode = multiPeak.ratio >= 0.6 ? 'dual_balanced' : 'dual_dominant';
  } else if (multiPeak?.level === 'suspected') {
    resonanceMode = 'dual_dominant';
  }

  // : 1 2bin /
  // > 0.45 1 2
  // : suspected confirmed(ratio<0.4)
  // confirmed(ratio 0.4) dual
  const isWeakDual = (resonanceMode === 'dual_dominant' && (!multiPeak || multiPeak.level === 'suspected' || multiPeak.ratio < 0.4));
  if (isWeakDual) {
    const actBins = psdData.filter(d => d.f >= 18.75 && d.f <= 200);
    const totalEnergy = actBins.reduce((s, d) => s + d.v, 0);
    if (totalEnergy > 1e-12) {
      let pkIdx = 0, pkMax = 0;
      actBins.forEach((d, i) => { if (d.v > pkMax) { pkMax = d.v; pkIdx = i; } });
      let peakEnergy = 0;
      for (let j = Math.max(0, pkIdx - 2); j <= Math.min(actBins.length - 1, pkIdx + 2); j++) {
        peakEnergy += actBins[j].v;
      }
      const energyRatio = peakEnergy / totalEnergy;
      if (energyRatio > 0.45) {
        // 1 dual single +
        resonanceMode = 'single';
      }
    }
  }

  // : multiPeak 2 single
  // ratio ( ) 2 2 dual
  if ((resonanceMode === 'dual_dominant') && multiPeak?.peaks?.length >= 2 && multiPeak.ratio < 0.3) {
    const f1 = multiPeak.peaks[0].freq;
    const f2 = multiPeak.peaks[1].freq;
    const fRatio = Math.max(f1, f2) / Math.min(f1, f2);
    const isHarmonicPair = [2, 3, 4].some(h => Math.abs(fRatio - h) < 0.15);
    if (isHarmonicPair) {
      resonanceMode = 'single';
    }
  }

  // confidence : SNR<6dB confidence<0.45 dual single
  // residual
  if ((resonanceMode === 'dual_dominant' || resonanceMode === 'dual_balanced') && confidence < 0.45) {
    resonanceMode = 'single';
  }

  // : peakFreq<22Hz >130Hz dual
  // 20Hz : 1/f residual fp
  // 130Hz : residual fp
  if ((resonanceMode === 'dual_dominant') && (peakFreq < 22 || peakFreq > 130)) {
    if (!multiPeak || multiPeak.level !== 'confirmed' || multiPeak.ratio < 0.5) {
      resonanceMode = 'single';
    }
  }

  // ( safe_freq / )
  // single:        perf=primary, safe=EI/2HUMP_EI
  // dual_dominant: perf=primary, safe=midFreq ( )
  // dual_balanced:  perf=midFreq, safe=midFreq + 2HUMP_EI
  // broad: perf=primary, safe=EI/2HUMP_EI (mount )
  let safeFreq = peakFreq;
  let perfFreq = performance.freq;
  let safeShaperHint = safe.name;

  if (resonanceMode === 'dual_balanced' && multiPeak?.midFreq) {
    // : midpoint
    safeFreq = multiPeak.midFreq;
    perfFreq = multiPeak.midFreq;
    // safe 2HUMP_EI
    const hump2 = shapers.find(s => s.name === '2HUMP_EI');
    if (hump2 && hump2.vibrPct <= 10) safeShaperHint = '2HUMP_EI';
  } else if (resonanceMode === 'dual_dominant' && multiPeak?.midFreq) {
    // : perf primary , safe midpoint
    safeFreq = multiPeak.midFreq;
    // perfFreq best/performance
  } else if (resonanceMode === 'broad') {
    // broad: EI
    safeShaperHint = safe.name; // EI
  }

  // v1.0:
  const userAccel = typeof getCfgAccel === 'function' ? getCfgAccel() : 5000;
  const userFeed = typeof getCfgFeedrate === 'function' ? getCfgFeedrate() : 300;
  const userBuildX = typeof getCfgBuildX === 'function' ? getCfgBuildX() : 250;
  const userBuildY = typeof getCfgBuildY === 'function' ? getCfgBuildY() : 250;
  const cfgScvVal = typeof getCfgScv === 'function' ? getCfgScv() : 5.0;
  const recShaper = performance;
  const recMaxAccel = recShaper.maxAccel || 1;
  // accel
  let userSmoothing = 0;
  if (recShaper._A && recShaper._T) {
    userSmoothing = calcSmoothing({A:recShaper._A, T:recShaper._T}, userAccel, cfgScvVal);
  }
  //
  const accelHeadroom = recMaxAccel / Math.max(userAccel, 1);
  // : v /(2a)
  const accelDist = (userFeed * userFeed) / (2 * Math.max(userAccel, 1));
  //
  const buildMin = Math.min(userBuildX, userBuildY);
  const accelRatio = Math.min(1, (2 * accelDist) / Math.max(buildMin, 1));  //
  const maxReachSpeed = Math.sqrt(userAccel * buildMin);  //
  const feedReachable = userFeed <= maxReachSpeed;        // feedrate ?
  //
  const measExcitation = accelRatio > 0.05 ? (accelRatio > 0.15 ? 'good' : 'fair') : 'poor';

  return {
    shapers,
    recommended: {
      performance: { ...performance, tag: 'perf' },
      lowVibration: { ...lowVibration, tag: 'lowvib' },
      safe: safe,
      best: bestShaper ? { ...bestShaper, tag: 'best' } : { ...performance, tag: 'best' },
    },
    resonanceMode,
    strategy: {
      perfFreq: parseFloat(perfFreq.toFixed(1) || peakFreq),
      safeFreq: parseFloat(safeFreq.toFixed(1)),
      safeShaperHint,
      description: {
        single: 'Clean single resonance',
        dual_dominant: 'Dominant + secondary resonance',
        dual_balanced: 'Balanced dual resonance',
        broad: 'Broadened response — check sensor mount',
        harmonic: 'Harmonic contamination filtered',
      }[resonanceMode] || 'Single mode',
    },
    dampingRatio: damping,
    confidence: parseFloat(confidence.toFixed(2)),
    snrDb: parseFloat(snrDb.toFixed(1)),
    multiPeak: multiPeak,
    broadPeak: broadPeak,
    preciseFreq: peakFreq,
    fitQuality: (peaks && peaks[0] && peaks[0].Q > 0) ? Math.min(1, peaks[0].Q / 10) : 0.5,
    freqCI: freqCI,
    hasVariance: hasVariance,
    noResonance: allHighVibr,
    // v1.0:
    practical: {
      userAccel,
      userFeed,
      buildX: userBuildX,
      buildY: userBuildY,
      userSmoothing: parseFloat(userSmoothing.toFixed(3)),
      targetSmoothing: _targetSm(),
      accelHeadroom: parseFloat(accelHeadroom.toFixed(2)),
      accelDist: parseFloat(accelDist.toFixed(1)),
      accelOk: accelHeadroom >= 1.0,
      smoothingOk: userSmoothing <= _targetSm(),
      accelRatio: parseFloat(accelRatio.toFixed(2)),
      maxReachSpeed: Math.round(maxReachSpeed),
      feedReachable,
      measExcitation,
      //
      rec: (function() {
        const ma = recMaxAccel;
        // : (50%) ~ (100%)
        const accelMin = Math.max(1000, Math.round(ma * 0.5 / 100) * 100);
        const accelMax = Math.round(ma / 100) * 100;
        // : 20~40%
        const sMin = Math.round(Math.sqrt(0.2 * accelMin * buildMin));
        const sMax = Math.min(Math.round(Math.sqrt(0.4 * accelMax * buildMin)), Math.round(maxReachSpeed));
        //
        let status;
        if (ma < 2000) status = 'retry';         //
        else if (userAccel > ma) status = 'over'; //
        else if (accelHeadroom >= 1.5) status = 'headroom'; //
        else status = 'tight';                    //
        return { accelMin, accelMax, speedMin: sMin, speedMax: sMax, status };
      })(),
    },
  };
}
