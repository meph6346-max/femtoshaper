// ================================================================
// FEMTO SHAPER Realistic Simulation
// Models real 3D printer physics + ADXL345 sensor + real print loads
//
// Run: node test/sim_realistic.js
// ================================================================
"use strict";

const DSP_N = 1024;
const DSP_OVERLAP = 768;
const DSP_STEP = DSP_N - DSP_OVERLAP;
const DSP_NBINS = DSP_N / 2 + 1;
const DSP_FS = 3200;
const DSP_FMIN = 18.75;
const DSP_FMAX = 200.0;

// ── FFT ──────────────────────────────────────────────────────
function fft(re, im) {
  const N = re.length;
  let j = 0;
  for (let i = 1; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let uRe = 1, uIm = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const tRe = uRe * re[b] - uIm * im[b];
        const tIm = uRe * im[b] + uIm * re[b];
        re[b] = re[a] - tRe; im[b] = im[a] - tIm;
        re[a] += tRe; im[a] += tIm;
        const nuRe = uRe * wRe - uIm * wIm;
        uIm = uRe * wIm + uIm * wRe;
        uRe = nuRe;
      }
    }
  }
}

const _hann = new Array(DSP_N); let _hannPower = 0;
(() => { for (let i = 0; i < DSP_N; i++) { _hann[i] = 0.5 * (1 - Math.cos(2*Math.PI*i/(DSP_N-1))); _hannPower += _hann[i]*_hann[i]; } })();

// ── Gaussian noise (Box-Muller) ──────────────────────────────
function randn() { let u = 0, v = 0; while (u === 0) u = Math.random(); while (v === 0) v = Math.random(); return Math.sqrt(-2*Math.log(u)) * Math.cos(2*Math.PI*v); }

// ── Multi-mode mechanical system (realistic 3D printer) ─────
// State: [x_primary, dx_primary, x_secondary, dx_secondary, ...]
// Each mode has independent natural freq, damping, gain
function simulateMultiMode(input, modes, fs = DSP_FS) {
  const dt = 1 / fs;
  const N = input.length;
  const out = new Float64Array(N);
  const state = modes.map(() => ({ x: 0, dx: 0 }));
  for (let n = 0; n < N; n++) {
    const u = input[n];
    let a_total = 0;
    for (let m = 0; m < modes.length; m++) {
      const md = modes[m];
      const omega = 2 * Math.PI * md.f;
      const st = state[m];
      const ddx = md.gain * omega*omega * u - 2*md.zeta*omega*st.dx - omega*omega*st.x;
      st.dx += ddx * dt;
      st.x += st.dx * dt;
      a_total += ddx;
    }
    out[n] = a_total;
  }
  return out;
}

// ── Realistic commanded motion (mimics G-code execution) ────
// Generates trapezoidal velocity profiles for random moves
function generateRealisticMotion(N, fs, opts = {}) {
  const a_cmd_x = new Float64Array(N);
  const a_cmd_y = new Float64Array(N);
  const a_max = opts.a_max || 3000;
  const v_max = opts.v_max || 200;
  const n_moves = opts.n_moves || 40;
  const move_mix = opts.move_mix || 'mixed';  // 'perim' (mostly X/Y), 'travel' (diagonal), 'mixed'

  let cursor = Math.floor(fs * 0.1);  // 100ms lead-in (quiet)
  for (let m = 0; m < n_moves && cursor < N - fs * 0.3; m++) {
    // Move characteristics
    let dx = 0, dy = 0;
    if (move_mix === 'perim') {
      // Perimeter-like: mostly single-axis
      if (Math.random() > 0.5) { dx = (Math.random() > 0.5 ? 1 : -1); dy = 0.1*(Math.random()-0.5); }
      else { dy = (Math.random() > 0.5 ? 1 : -1); dx = 0.1*(Math.random()-0.5); }
    } else if (move_mix === 'travel') {
      // Diagonal travel: both axes excited
      dx = (Math.random() > 0.5 ? 1 : -1);
      dy = (Math.random() > 0.5 ? 1 : -1);
    } else {
      // Mixed typical print
      dx = Math.random() * 2 - 1;
      dy = Math.random() * 2 - 1;
    }
    const len = Math.sqrt(dx*dx + dy*dy);
    if (len < 1e-6) continue;
    dx /= len; dy /= len;

    // Move duration 100~400ms
    const t_move = fs * (0.1 + Math.random() * 0.3);
    const t_accel = fs * (v_max / a_max);  // time to reach max velocity
    const t_const = Math.max(0, t_move - 2 * t_accel);
    const total = Math.min(N - cursor - 1, Math.floor(2*t_accel + t_const));

    // Generate velocity profile (trapezoidal)
    for (let n = 0; n < total; n++) {
      let a_val;
      if (n < t_accel) a_val = a_max * (n / t_accel);
      else if (n < t_accel + t_const) a_val = 0;
      else {
        const rn = n - t_accel - t_const;
        a_val = -a_max * (rn / t_accel);
      }
      a_cmd_x[cursor + n] += dx * a_val;
      a_cmd_y[cursor + n] += dy * a_val;
    }

    cursor += total + Math.floor(fs * (0.02 + Math.random() * 0.08));  // 20-100ms gap
  }

  return { a_cmd_x, a_cmd_y };
}

// ── ADXL345 sensor model ────────────────────────────────────
// Quantization: full res mode, 4mg/LSB (±16g range)
// Cross-axis: 5% of perpendicular axis leaks in
// Bandwidth limit: low-pass at ~1.6kHz (simple RC)
function adxl345Model(a_true_x, a_true_y, a_true_z, opts = {}) {
  const G = 9.80665;
  const lsb = 0.004 * G;  // 4mg/LSB
  const crossAxis = opts.crossAxis || 0.05;  // 5%
  const noiseLevel = opts.noise || 0.01 * G;  // ADXL345 noise floor
  const bias_x = opts.bias_x || 0.02 * G;
  const bias_y = opts.bias_y || 0.015 * G;
  const N = a_true_x.length;
  const rx = new Float64Array(N), ry = new Float64Array(N), rz = new Float64Array(N);

  // 1-pole low-pass filter state
  let lpx = 0, lpy = 0, lpz = 0;
  const alpha = 0.7;  // ~1.6kHz BW at 3200Hz fs

  for (let n = 0; n < N; n++) {
    // Mix with gravity and cross-axis
    const mx = a_true_x[n] + crossAxis * a_true_y[n] + bias_x + randn() * noiseLevel;
    const my = a_true_y[n] + crossAxis * a_true_x[n] + bias_y + randn() * noiseLevel;
    const mz = (a_true_z ? a_true_z[n] : 0) + G + randn() * noiseLevel;  // gravity 1g

    // Low-pass
    lpx = alpha * lpx + (1-alpha) * mx;
    lpy = alpha * lpy + (1-alpha) * my;
    lpz = alpha * lpz + (1-alpha) * mz;

    // Quantize
    rx[n] = Math.round(lpx / lsb) * lsb;
    ry[n] = Math.round(lpy / lsb) * lsb;
    rz[n] = Math.round(lpz / lsb) * lsb;
  }
  return { rx, ry, rz };
}

// ── Fan spectrum injection ──────────────────────────────────
// Real fans show up as narrow peaks with harmonics
// Hotend fan: ~120 Hz with 2nd, 3rd harmonics
// Parts fan: ~70 Hz with harmonics
function addFanVibration(signal, fans, fs = DSP_FS) {
  const dt = 1 / fs;
  for (let n = 0; n < signal.length; n++) {
    const t = n * dt;
    for (const fan of fans) {
      // Fundamental + harmonics with decreasing amplitude
      signal[n] += fan.amp * Math.sin(2*Math.PI*fan.f*t + fan.phase);
      if (fan.harmonics) {
        signal[n] += fan.amp * 0.4 * Math.sin(2*Math.PI*fan.f*2*t + fan.phase);
        signal[n] += fan.amp * 0.15 * Math.sin(2*Math.PI*fan.f*3*t + fan.phase);
      }
    }
  }
}

// ── CoreXY projection with calibration error ────────────────
// In a CoreXY: A,B motors produce (A+B)/2 X-like and (A-B)/2 Y-like motion
// Calibration vectors calWx, calWy should perfectly separate X from Y
// Error: rotation by angle_err and/or non-orthogonal components
function coreXYProject(a_motor_A, a_motor_B, angleErr = 0) {
  const N = a_motor_A.length;
  const ax = new Float64Array(N);
  const ay = new Float64Array(N);
  const cosE = Math.cos(angleErr);
  const sinE = Math.sin(angleErr);
  for (let n = 0; n < N; n++) {
    const pureX = (a_motor_A[n] + a_motor_B[n]) / 2;
    const pureY = (a_motor_A[n] - a_motor_B[n]) / 2;
    // Apply error rotation
    ax[n] = cosE * pureX - sinE * pureY;
    ay[n] = sinE * pureX + cosE * pureY;
  }
  return { ax, ay };
}

// ── Welch PSD (matches dsp.h exactly) ───────────────────────
function welchPsd(signal, fs = DSP_FS) {
  const psdSum = new Float64Array(DSP_NBINS);
  const psdSqSum = new Float64Array(DSP_NBINS);
  let weightSum = 0, energyEMA = 0;
  const re = new Array(DSP_N), im = new Array(DSP_N);
  const numSegs = Math.floor((signal.length - DSP_OVERLAP) / DSP_STEP);
  for (let s = 0; s < numSegs; s++) {
    const start = s * DSP_STEP;
    if (start + DSP_N > signal.length) break;
    let e = 0;
    for (let i = 0; i < DSP_N; i++) e += signal[start+i] * signal[start+i];
    e /= DSP_N;
    const bgE = s <= 3 ? e : energyEMA;
    energyEMA = s <= 3 ? e : energyEMA*0.97 + e*0.03;
    let weight = Math.max(0, (e - bgE) / Math.max(bgE, 1e-15));
    weight = Math.min(100, weight) + 0.01;
    for (let i = 0; i < DSP_N; i++) { re[i] = signal[start+i] * _hann[i]; im[i] = 0; }
    fft(re, im);
    const norm = fs * _hannPower;
    for (let k = 0; k < DSP_NBINS; k++) {
      let p = (re[k]*re[k] + im[k]*im[k]) / norm;
      if (k > 0 && k < DSP_NBINS-1) p *= 2;
      psdSum[k] += p * weight;
      psdSqSum[k] += p * p * weight;
    }
    weightSum += weight;
  }
  const psd = [], psdVar = [];
  const freqRes = fs / DSP_N;
  for (let k = 0; k < DSP_NBINS; k++) {
    const mean = psdSum[k] / Math.max(weightSum, 1e-15);
    const msq = psdSqSum[k] / Math.max(weightSum, 1e-15);
    psd.push({ f: k * freqRes, v: mean, var: Math.max(0, msq - mean*mean) });
    psdVar.push(Math.max(0, msq - mean*mean));
  }
  const gateRatio = weightSum > 0 ? (numSegs - (numSegs * 0.01)) / numSegs : 0;
  return { psd, psdVar, segs: numSegs, gateRatio };
}

// ── Peak detection: CURRENT pipeline (filter.js style) ──────
function detectPeaksCurrent(psd) {
  const filtered = psd.filter(p => p.f >= DSP_FMIN && p.f <= DSP_FMAX);
  if (filtered.length < 5) return [];
  const vals = filtered.map(p => p.v).sort((a,b) => a-b);
  const noiseFloor = vals[Math.floor(vals.length * 0.3)] || 0;
  const threshold = noiseFloor * 5;
  const pkGlobal = vals[vals.length-1];
  if (pkGlobal < 1e-12) return [];

  const candidates = [];
  for (let i = 1; i < psd.length - 1; i++) {
    if (psd[i].f < DSP_FMIN || psd[i].f > DSP_FMAX) continue;
    if (psd[i].v <= threshold || psd[i].v <= psd[i-1].v || psd[i].v <= psd[i+1].v) continue;
    const lo = Math.max(0, i-4), hi = Math.min(psd.length-1, i+4);
    let lMin = psd[lo].v;
    for (let j = lo; j < i; j++) if (psd[j].v < lMin) lMin = psd[j].v;
    let rMin = psd[i+1].v;
    for (let j = i+1; j <= hi; j++) if (psd[j].v < rMin) rMin = psd[j].v;
    const surMin = Math.max(lMin, rMin);
    const prom = psd[i].v > 1e-12 ? (psd[i].v - surMin) / psd[i].v : 0;
    const rel = psd[i].v / pkGlobal;
    if (prom < 0.2 || rel < 0.1) continue;
    candidates.push({ idx: i, f: psd[i].f, v: psd[i].v, prom, rel, var: psd[i].var });
  }
  candidates.sort((a,b) => b.v - a.v);
  const selected = [];
  for (const c of candidates) {
    let tooClose = false;
    for (const s of selected) if (Math.abs(c.f - s.f) < 4) { tooClose = true; break; }
    if (!tooClose) selected.push(c);
    if (selected.length >= 8) break;
  }
  // Apply zoomPeakRefine (simplified Lorentzian grid search)
  for (const p of selected) {
    const r = zoomPeakRefine(psd, p.f);
    if (r.improved) p.f = r.freq;
    p.damping = r.damping;
    p.Q = r.Q;
  }
  return selected;
}

function zoomPeakRefine(psd, approxFreq) {
  if (!psd || psd.length < 5 || approxFreq < 15) return { freq: approxFreq, damping: 0.1, Q: 5, improved: false };
  let pkIdx = 0, pkV = 0;
  for (let i = 0; i < psd.length; i++) {
    if (Math.abs(psd[i].f - approxFreq) < 10 && psd[i].v > pkV) { pkV = psd[i].v; pkIdx = i; }
  }
  if (pkV < 1e-12) return { freq: approxFreq, damping: 0.1, Q: 5, improved: false };
  const lo = Math.max(0, pkIdx - 7), hi = Math.min(psd.length - 1, pkIdx + 7);
  const fitBins = [];
  for (let k = lo; k <= hi; k++) fitBins.push({ f: psd[k].f, v: psd[k].v });
  const A = pkV;
  const C = Math.min(...fitBins.map(b => b.v)) * 0.5;
  let bestF0 = approxFreq, bestGamma = approxFreq * 0.1, bestErr = 1e30;
  for (let df = -1.5; df <= 1.5; df += 0.1) {
    for (let g = 0.5; g <= 15; g += 0.3) {
      const f0 = psd[pkIdx].f + df; let err = 0;
      for (const b of fitBins) {
        const pred = (A - C) / (1 + Math.pow((b.f - f0) / g, 2)) + C;
        err += (b.v - pred) ** 2;
      }
      if (err < bestErr) { bestErr = err; bestF0 = f0; bestGamma = g; }
    }
  }
  return { freq: bestF0, damping: bestGamma / bestF0, Q: bestF0 / (2 * bestGamma), improved: Math.abs(bestF0 - approxFreq) > 0.05 };
}

// ── Improved peak detection (proposed fixes) ────────────────
function detectPeaksImproved(psd, opts = {}) {
  const fanFreqs = opts.fanFreqs || [];  // Known fan frequencies to exclude
  const fanHalfWidth = opts.fanHalfWidth || 3.0;  // Hz

  const filtered = psd.filter(p => p.f >= DSP_FMIN && p.f <= DSP_FMAX);
  if (filtered.length < 5) return [];
  const vals = filtered.map(p => p.v).sort((a,b) => a-b);
  const noiseFloor = vals[Math.floor(vals.length * 0.3)] || 0;
  const threshold = noiseFloor * 5;
  const pkGlobal = vals[vals.length-1];

  const candidates = [];
  for (let i = 1; i < psd.length - 1; i++) {
    if (psd[i].f < DSP_FMIN || psd[i].f > DSP_FMAX) continue;
    if (psd[i].v <= threshold || psd[i].v <= psd[i-1].v || psd[i].v <= psd[i+1].v) continue;

    // NEW: exclude fan peaks
    let nearFan = false;
    for (const ff of fanFreqs) {
      if (Math.abs(psd[i].f - ff) < fanHalfWidth) { nearFan = true; break; }
      if (Math.abs(psd[i].f - 2*ff) < fanHalfWidth) { nearFan = true; break; }  // 2nd harmonic
    }
    if (nearFan) continue;

    const lo = Math.max(0, i-4), hi = Math.min(psd.length-1, i+4);
    let lMin = psd[lo].v;
    for (let j = lo; j < i; j++) if (psd[j].v < lMin) lMin = psd[j].v;
    let rMin = psd[i+1].v;
    for (let j = i+1; j <= hi; j++) if (psd[j].v < rMin) rMin = psd[j].v;
    const surMin = Math.max(lMin, rMin);
    const prom = psd[i].v > 1e-12 ? (psd[i].v - surMin) / psd[i].v : 0;
    const rel = psd[i].v / pkGlobal;
    if (prom < 0.2 || rel < 0.1) continue;

    // NEW: variance-aware confidence
    const relVar = psd[i].var > 0 ? Math.sqrt(psd[i].var) / psd[i].v : 0;
    const varConfidence = Math.max(0, 1 - relVar);  // high variance => low confidence

    // NEW: adaptive prominence weighted by confidence
    const effectiveProm = prom * varConfidence;

    candidates.push({
      idx: i, f: psd[i].f, v: psd[i].v, prom, rel, var: psd[i].var,
      relVar, varConfidence, effectiveProm,
      score: psd[i].v * varConfidence  // variance-weighted power
    });
  }

  // NEW: sort by variance-weighted score (not raw power)
  candidates.sort((a,b) => b.score - a.score);
  const selected = [];
  for (const c of candidates) {
    let tooClose = false;
    for (const s of selected) if (Math.abs(c.f - s.f) < 4) { tooClose = true; break; }
    if (!tooClose) selected.push(c);
    if (selected.length >= 8) break;
  }

  // Lorentzian refinement
  for (const p of selected) {
    const r = zoomPeakRefine(psd, p.f);
    if (r.improved) p.f = r.freq;
    p.damping = r.damping;
    p.Q = r.Q;
  }
  return selected;
}

// ══════════════════════════════════════════════════════════
// REALISTIC TEST SCENARIOS
// ══════════════════════════════════════════════════════════

const TRUE_F_X = 42.5;
const TRUE_F_Y = 38.0;
const TRUE_ZETA_X = 0.08;
const TRUE_ZETA_Y = 0.10;
const N_SAMPLES = 32768;  // ~10 seconds
const N_TRIALS = 10;

function runRealisticScenario(name, cfg) {
  const errors_cur_x = [], errors_cur_y = [];
  const errors_imp_x = [], errors_imp_y = [];
  const spurious_cur = []; // spurious peak count
  const spurious_imp = [];

  for (let t = 0; t < N_TRIALS; t++) {
    const { a_cmd_x, a_cmd_y } = generateRealisticMotion(N_SAMPLES, DSP_FS, cfg);

    // Primary + secondary modes
    const modesX = [
      { f: TRUE_F_X, zeta: TRUE_ZETA_X, gain: 1.0 },
      ...(cfg.secondaryMode ? [{ f: cfg.secondaryMode.fx || 65, zeta: 0.12, gain: 0.3 }] : []),
    ];
    const modesY = [
      { f: TRUE_F_Y, zeta: TRUE_ZETA_Y, gain: 1.0 },
      ...(cfg.secondaryMode ? [{ f: cfg.secondaryMode.fy || 72, zeta: 0.12, gain: 0.3 }] : []),
    ];

    let a_meas_x = simulateMultiMode(a_cmd_x, modesX);
    let a_meas_y = simulateMultiMode(a_cmd_y, modesY);

    // Fan vibrations
    if (cfg.fans) {
      addFanVibration(a_meas_x, cfg.fans);
      addFanVibration(a_meas_y, cfg.fans);
    }

    // Calibration error: rotate X/Y
    if (cfg.calError && cfg.calError > 0) {
      const ang = cfg.calError * Math.PI / 180;
      const cosA = Math.cos(ang), sinA = Math.sin(ang);
      const ax_new = new Float64Array(N_SAMPLES);
      const ay_new = new Float64Array(N_SAMPLES);
      for (let i = 0; i < N_SAMPLES; i++) {
        ax_new[i] = cosA * a_meas_x[i] - sinA * a_meas_y[i];
        ay_new[i] = sinA * a_meas_x[i] + cosA * a_meas_y[i];
      }
      a_meas_x = ax_new; a_meas_y = ay_new;
    }

    // Convert to raw ADXL units (not m/s^2)
    const a_z = new Float64Array(N_SAMPLES);
    const adxl = adxl345Model(a_meas_x, a_meas_y, a_z, cfg.adxl || {});

    // Convert back to m/s^2 for pipeline (DC removed)
    const sig_x = new Float64Array(N_SAMPLES);
    const sig_y = new Float64Array(N_SAMPLES);
    let mean_x = 0, mean_y = 0;
    for (let i = 0; i < N_SAMPLES; i++) { mean_x += adxl.rx[i]; mean_y += adxl.ry[i]; }
    mean_x /= N_SAMPLES; mean_y /= N_SAMPLES;
    for (let i = 0; i < N_SAMPLES; i++) {
      sig_x[i] = adxl.rx[i] - mean_x;
      sig_y[i] = adxl.ry[i] - mean_y;
    }

    const { psd: psdX } = welchPsd(sig_x);
    const { psd: psdY } = welchPsd(sig_y);

    const curPeaksX = detectPeaksCurrent(psdX);
    const curPeaksY = detectPeaksCurrent(psdY);
    const impPeaksX = detectPeaksImproved(psdX, { fanFreqs: (cfg.fans || []).map(f => f.f) });
    const impPeaksY = detectPeaksImproved(psdY, { fanFreqs: (cfg.fans || []).map(f => f.f) });

    // Take primary peak (largest) for accuracy
    const curPX = curPeaksX[0] ? curPeaksX[0].f : 0;
    const curPY = curPeaksY[0] ? curPeaksY[0].f : 0;
    const impPX = impPeaksX[0] ? impPeaksX[0].f : 0;
    const impPY = impPeaksY[0] ? impPeaksY[0].f : 0;

    errors_cur_x.push(Math.abs(curPX - TRUE_F_X));
    errors_cur_y.push(Math.abs(curPY - TRUE_F_Y));
    errors_imp_x.push(Math.abs(impPX - TRUE_F_X));
    errors_imp_y.push(Math.abs(impPY - TRUE_F_Y));

    // Count spurious peaks (those not matching any true freq within 5Hz)
    const trueList = [TRUE_F_X, TRUE_F_Y, ...(cfg.secondaryMode ? [cfg.secondaryMode.fx || 65, cfg.secondaryMode.fy || 72] : [])];
    const isSpurious = p => !trueList.some(tf => Math.abs(p.f - tf) < 5);
    spurious_cur.push(curPeaksX.filter(isSpurious).length + curPeaksY.filter(isSpurious).length);
    spurious_imp.push(impPeaksX.filter(isSpurious).length + impPeaksY.filter(isSpurious).length);
  }

  const mean = arr => arr.reduce((a,b) => a+b, 0) / arr.length;
  const max = arr => Math.max(...arr);

  return {
    name,
    curErrX: mean(errors_cur_x), curErrY: mean(errors_cur_y),
    impErrX: mean(errors_imp_x), impErrY: mean(errors_imp_y),
    curSpur: mean(spurious_cur), impSpur: mean(spurious_imp),
    curMaxErr: Math.max(max(errors_cur_x), max(errors_cur_y)),
    impMaxErr: Math.max(max(errors_imp_x), max(errors_imp_y)),
  };
}

console.log("=".repeat(88));
console.log("FEMTO SHAPER Realistic Simulation");
console.log("=".repeat(88));
console.log(`True resonances: X=${TRUE_F_X}Hz (z=${TRUE_ZETA_X}) Y=${TRUE_F_Y}Hz (z=${TRUE_ZETA_Y})`);
console.log(`Samples: ${N_SAMPLES} (${(N_SAMPLES/DSP_FS).toFixed(1)}s) x ${N_TRIALS} trials per scenario`);
console.log("");

const scenarios = [
  {
    name: "Baseline (clean)",
    n_moves: 40, a_max: 3000, move_mix: 'mixed',
  },
  {
    name: "+ Fan noise (parts=70Hz, hotend=120Hz)",
    n_moves: 40, a_max: 3000,
    fans: [
      { f: 70, amp: 0.3, phase: 0.1, harmonics: true },
      { f: 120, amp: 0.2, phase: 0.7, harmonics: true },
    ],
  },
  {
    name: "+ Secondary mode (65Hz/72Hz)",
    n_moves: 40, a_max: 3000, secondaryMode: { fx: 65, fy: 72 },
  },
  {
    name: "+ Calibration error (5 deg)",
    n_moves: 40, a_max: 3000, calError: 5,
  },
  {
    name: "+ Low excitation (10 moves)",
    n_moves: 10, a_max: 1500,
  },
  {
    name: "+ ADXL cross-axis (10%)",
    n_moves: 40, a_max: 3000, adxl: { crossAxis: 0.10 },
  },
  {
    name: "+ Perimeter-only (single-axis)",
    n_moves: 40, a_max: 3000, move_mix: 'perim',
  },
  {
    name: "Realistic combined",
    n_moves: 30, a_max: 3000,
    fans: [{ f: 70, amp: 0.25, phase: 0.1, harmonics: true }, { f: 120, amp: 0.15, phase: 0.7, harmonics: true }],
    secondaryMode: { fx: 65, fy: 72 },
    calError: 3,
  },
];

console.log("Scenario".padEnd(44) + "Current Pipeline          Improved Pipeline");
console.log(" ".repeat(44) + "X err  Y err  Spur   Max | X err  Y err  Spur   Max");
console.log("-".repeat(88));
const results = [];
for (const sc of scenarios) {
  const r = runRealisticScenario(sc.name, sc);
  results.push(r);
  console.log(
    sc.name.padEnd(44) +
    `${r.curErrX.toFixed(2)}Hz `.padEnd(7) +
    `${r.curErrY.toFixed(2)}Hz `.padEnd(7) +
    `${r.curSpur.toFixed(1)}   `.padEnd(7) +
    `${r.curMaxErr.toFixed(1)} | `.padEnd(6) +
    `${r.impErrX.toFixed(2)}Hz `.padEnd(7) +
    `${r.impErrY.toFixed(2)}Hz `.padEnd(7) +
    `${r.impSpur.toFixed(1)}   `.padEnd(7) +
    `${r.impMaxErr.toFixed(1)}`
  );
}
console.log("=".repeat(88));
console.log("");
console.log("Summary:");
const avgCur = results.reduce((s,r) => s + (r.curErrX + r.curErrY)/2, 0) / results.length;
const avgImp = results.reduce((s,r) => s + (r.impErrX + r.impErrY)/2, 0) / results.length;
const avgSpurCur = results.reduce((s,r) => s + r.curSpur, 0) / results.length;
const avgSpurImp = results.reduce((s,r) => s + r.impSpur, 0) / results.length;
console.log(`  Average peak error (current):  ${avgCur.toFixed(2)} Hz`);
console.log(`  Average peak error (improved): ${avgImp.toFixed(2)} Hz`);
console.log(`  Gain: ${(avgCur/avgImp).toFixed(2)}x`);
console.log(`  Average spurious peaks (current):  ${avgSpurCur.toFixed(1)}`);
console.log(`  Average spurious peaks (improved): ${avgSpurImp.toFixed(1)}`);
console.log("");
const wins = results.filter(r => (r.impErrX + r.impErrY) < (r.curErrX + r.curErrY)).length;
console.log(`  Improved pipeline better in ${wins}/${results.length} scenarios`);
console.log("=".repeat(88));
