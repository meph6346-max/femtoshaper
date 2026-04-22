// ================================================================
// FEMTO SHAPER Accuracy Simulation
// Node.js — run with: node test/sim_accuracy.js
//
// Goal: Quantify accuracy of raw-X(f) vs Phase-2 H(f) peak detection
// across realistic printer scenarios before real-device testing.
// ================================================================
"use strict";

// ── Constants (match dsp.h) ──────────────────────────────────
const DSP_N = 1024;
const DSP_OVERLAP = 768;
const DSP_STEP = DSP_N - DSP_OVERLAP;  // 256
const DSP_NBINS = DSP_N / 2 + 1;       // 513
const DSP_FS = 3200;
const DSP_FMIN = 18.75;
const DSP_FMAX = 200.0;

// ── FFT (Cooley-Tukey radix-2, in-place) ─────────────────────
function fft(re, im) {
  const N = re.length;
  // Bit-reverse
  let j = 0;
  for (let i = 1; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
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

// ── Hann window (cached) ─────────────────────────────────────
const _hann = new Array(DSP_N);
let _hannPower = 0;
(() => {
  for (let i = 0; i < DSP_N; i++) {
    _hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (DSP_N - 1)));
    _hannPower += _hann[i] * _hann[i];
  }
})();

// ── Weighted Welch PSD (mimics dsp.h::dspFeedDual) ──────────
function welchPsd(signal, fs = DSP_FS) {
  const psdSum = new Float64Array(DSP_NBINS);
  const jerkSum = new Float64Array(DSP_NBINS);
  let weightSum = 0;
  let energyEMA = 0;
  const re = new Array(DSP_N), im = new Array(DSP_N);

  const numSegs = Math.floor((signal.length - DSP_OVERLAP) / DSP_STEP);

  for (let s = 0; s < numSegs; s++) {
    const start = s * DSP_STEP;
    if (start + DSP_N > signal.length) break;

    // Energy for weighting
    let e = 0;
    for (let i = 0; i < DSP_N; i++) e += signal[start + i] * signal[start + i];
    e /= DSP_N;

    const bgE = s <= 3 ? e : energyEMA;
    energyEMA = s <= 3 ? e : energyEMA * 0.97 + e * 0.03;

    let weight = Math.max(0, (e - bgE) / Math.max(bgE, 1e-15));
    weight = Math.min(100, weight) + 0.01;

    // Output PSD: accel signal
    for (let i = 0; i < DSP_N; i++) { re[i] = signal[start + i] * _hann[i]; im[i] = 0; }
    fft(re, im);
    const norm = fs * _hannPower;
    for (let k = 0; k < DSP_NBINS; k++) {
      let p = (re[k] * re[k] + im[k] * im[k]) / norm;
      if (k > 0 && k < DSP_NBINS - 1) p *= 2;
      psdSum[k] += p * weight;
    }

    // Jerk PSD: first-difference of accel signal
    re[0] = 0; im[0] = 0;
    for (let i = 1; i < DSP_N; i++) {
      re[i] = (signal[start + i] - signal[start + i - 1]) * _hann[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < DSP_NBINS; k++) {
      let p = (re[k] * re[k] + im[k] * im[k]) / norm;
      if (k > 0 && k < DSP_NBINS - 1) p *= 2;
      jerkSum[k] += p * weight;
    }

    weightSum += weight;
  }

  const psd = new Array(DSP_NBINS);
  const jerkPsd = new Array(DSP_NBINS);
  for (let k = 0; k < DSP_NBINS; k++) {
    psd[k] = psdSum[k] / Math.max(weightSum, 1e-15);
    jerkPsd[k] = jerkSum[k] / Math.max(weightSum, 1e-15);
  }
  return { psd, jerkPsd, segs: numSegs };
}

// ── 2nd-order system simulation (Newmark-beta integration) ──
function simulate2ndOrder(input, f_n, zeta, fs = DSP_FS) {
  const dt = 1 / fs;
  const omega_n = 2 * Math.PI * f_n;
  const N = input.length;
  const out = new Float64Array(N);
  let x = 0, dx = 0;
  for (let n = 0; n < N; n++) {
    // m·ddx + c·dx + k·x = u  →  ddx = (u - 2ζωn·dx - ωn²·x)
    const u = input[n];
    const ddx = omega_n * omega_n * u - 2 * zeta * omega_n * dx - omega_n * omega_n * x;
    dx += ddx * dt;
    x += dx * dt;
    out[n] = ddx;  // measured acceleration at sensor
  }
  return out;
}

// ── Printer-like commanded motion: random decel events ──────
function generateCommandedAccel(N, fs, opts = {}) {
  const n_events = opts.n_events || 30;
  const a_max = opts.a_max || 3000;  // mm/s²
  const v_max = opts.v_max || 200;   // mm/s
  const noise = opts.noise || 0.5;   // sensor noise level

  const a_cmd = new Float64Array(N);
  for (let i = 0; i < n_events; i++) {
    // Event at random time, random duration
    const t0 = Math.floor(Math.random() * (N - fs * 0.5));
    const dur_samples = Math.floor(fs * (0.05 + Math.random() * 0.15));  // 50~200ms decel
    const sign = Math.random() > 0.5 ? 1 : -1;

    // Accelerate/decelerate profile
    for (let n = 0; n < dur_samples && t0 + n < N; n++) {
      // Trapezoidal: ramp-up 10%, flat 80%, ramp-down 10%
      const ramp = dur_samples * 0.1;
      let envelope;
      if (n < ramp) envelope = n / ramp;
      else if (n > dur_samples - ramp) envelope = (dur_samples - n) / ramp;
      else envelope = 1;
      a_cmd[t0 + n] += sign * a_max * envelope;
    }
  }

  // Add sensor noise
  for (let i = 0; i < N; i++) {
    a_cmd[i] += (Math.random() - 0.5) * 2 * noise;
  }
  return a_cmd;
}

// ── Peak detection (centroid 5-bin) ─────────────────────────
function findPeakCentroid(psd, fs = DSP_FS) {
  const freqRes = fs / DSP_N;
  const binMin = Math.floor(DSP_FMIN / freqRes);
  const binMax = Math.floor(DSP_FMAX / freqRes);
  let peakBin = binMin, peakV = psd[binMin];
  for (let k = binMin + 1; k <= binMax; k++) {
    if (psd[k] > peakV) { peakV = psd[k]; peakBin = k; }
  }
  const lo = Math.max(binMin, peakBin - 2);
  const hi = Math.min(binMax, peakBin + 2);
  let sumFW = 0, sumW = 0;
  for (let k = lo; k <= hi; k++) {
    sumFW += k * freqRes * psd[k];
    sumW += psd[k];
  }
  return sumW > 1e-15 ? sumFW / sumW : peakBin * freqRes;
}

// ── Phase 2: computeTransferFunction (mirrors shaper.js) ────
function computeTransferFunction(psdOut, psdInput, smoothBins = 2) {
  const n = psdOut.length;
  const smoothed = new Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - smoothBins), hi = Math.min(n - 1, i + smoothBins);
    let sum = 0, cnt = 0;
    for (let j = lo; j <= hi; j++) { sum += psdInput[j]; cnt++; }
    smoothed[i] = sum / cnt;
  }
  let maxIn = 0;
  for (let i = 0; i < n; i++) if (smoothed[i] > maxIn) maxIn = smoothed[i];
  const floor = Math.max(maxIn * 0.01, 1e-12);
  const H = new Array(n);
  for (let i = 0; i < n; i++) {
    H[i] = psdOut[i] / Math.max(smoothed[i], floor);
  }
  return H;
}

// ── Simulation scenarios ────────────────────────────────────
function runScenario(name, opts) {
  const N = opts.N || 32768;  // ~10s at 3200Hz
  const fs = DSP_FS;
  const f_n = opts.f_n;
  const zeta = opts.zeta || 0.1;
  const n_trials = opts.n_trials || 5;

  const errors_raw = [], errors_hf = [];
  for (let t = 0; t < n_trials; t++) {
    const a_cmd = generateCommandedAccel(N, fs, opts);
    const a_meas = simulate2ndOrder(a_cmd, f_n, zeta, fs);

    // Add measurement noise
    for (let i = 0; i < N; i++) {
      a_meas[i] += (Math.random() - 0.5) * 2 * (opts.measNoise || 0.2);
    }

    const { psd, jerkPsd } = welchPsd(a_meas, fs);
    const peakRaw = findPeakCentroid(psd, fs);
    const H = computeTransferFunction(psd, jerkPsd, opts.smoothBins || 2);
    const peakHf = findPeakCentroid(H, fs);

    errors_raw.push(Math.abs(peakRaw - f_n));
    errors_hf.push(Math.abs(peakHf - f_n));
  }

  const meanErr = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const stdErr = arr => {
    const m = meanErr(arr);
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
  };
  return {
    name,
    f_n, zeta,
    errRawMean: meanErr(errors_raw),
    errRawStd: stdErr(errors_raw),
    errHfMean: meanErr(errors_hf),
    errHfStd: stdErr(errors_hf),
    rawSamples: errors_raw.map(e => e.toFixed(3)),
    hfSamples: errors_hf.map(e => e.toFixed(3)),
  };
}

// ── Main ────────────────────────────────────────────────────
console.log("=".repeat(72));
console.log("FEMTO SHAPER Accuracy Simulation");
console.log("=".repeat(72));
console.log(`FFT: ${DSP_N}pt, Welch 75% overlap, ${DSP_FS}Hz sampling`);
console.log(`Bin resolution: ${(DSP_FS/DSP_N).toFixed(3)} Hz`);
console.log("");

const scenarios = [
  { name: "Typical (42Hz, ζ=0.10)",       f_n: 42, zeta: 0.10, n_events: 30, a_max: 3000 },
  { name: "Low freq (25Hz, ζ=0.10)",      f_n: 25, zeta: 0.10, n_events: 30, a_max: 3000 },
  { name: "High freq (80Hz, ζ=0.10)",     f_n: 80, zeta: 0.10, n_events: 30, a_max: 3000 },
  { name: "Low damping (42Hz, ζ=0.05)",   f_n: 42, zeta: 0.05, n_events: 30, a_max: 3000 },
  { name: "High damping (42Hz, ζ=0.20)",  f_n: 42, zeta: 0.20, n_events: 30, a_max: 3000 },
  { name: "Low excitation (events=10)",   f_n: 42, zeta: 0.10, n_events: 10, a_max: 1500 },
  { name: "Noisy (measNoise=2.0)",        f_n: 42, zeta: 0.10, n_events: 30, a_max: 3000, measNoise: 2.0 },
];

console.log("Scenario".padEnd(40) + "Raw X(f)".padEnd(16) + "H(f)".padEnd(16) + "Gain");
console.log("-".repeat(72));
const results = [];
for (const sc of scenarios) {
  const r = runScenario(sc.name, sc);
  results.push(r);
  const gain = r.errRawMean / Math.max(r.errHfMean, 0.001);
  console.log(
    sc.name.padEnd(40) +
    `${r.errRawMean.toFixed(2)}±${r.errRawStd.toFixed(2)}Hz`.padEnd(16) +
    `${r.errHfMean.toFixed(2)}±${r.errHfStd.toFixed(2)}Hz`.padEnd(16) +
    `${gain.toFixed(2)}x`
  );
}

console.log("");
console.log("=".repeat(72));
console.log("Summary:");
const avgGain = results.reduce((s, r) => s + (r.errRawMean / Math.max(r.errHfMean, 0.001)), 0) / results.length;
console.log(`  Average H(f) gain: ${avgGain.toFixed(2)}x`);
const wins = results.filter(r => r.errHfMean < r.errRawMean).length;
console.log(`  H(f) better in ${wins}/${results.length} scenarios`);
console.log("=".repeat(72));

module.exports = { welchPsd, computeTransferFunction, findPeakCentroid, simulate2ndOrder, generateCommandedAccel };

// ================================================================
// EXTENDED TESTS — alternative peak refinement methods
// ================================================================

// Parabolic interpolation
function findPeakParabolic(psd, fs = DSP_FS) {
  const freqRes = fs / DSP_N;
  const binMin = Math.floor(DSP_FMIN / freqRes);
  const binMax = Math.floor(DSP_FMAX / freqRes);
  let peakBin = binMin, peakV = psd[binMin];
  for (let k = binMin + 1; k <= binMax; k++) {
    if (psd[k] > peakV) { peakV = psd[k]; peakBin = k; }
  }
  if (peakBin <= binMin || peakBin >= binMax) return peakBin * freqRes;
  const y0 = psd[peakBin - 1], y1 = psd[peakBin], y2 = psd[peakBin + 1];
  const denom = y0 - 2*y1 + y2;
  const delta = Math.abs(denom) > 1e-15 ? 0.5 * (y0 - y2) / denom : 0;
  return (peakBin + delta) * freqRes;
}

// Lorentzian fit (matches shaper.js estimateDampingRatio logic)
function findPeakLorentzian(psd, fs = DSP_FS) {
  const freqRes = fs / DSP_N;
  const binMin = Math.floor(DSP_FMIN / freqRes);
  const binMax = Math.floor(DSP_FMAX / freqRes);
  let peakBin = binMin, peakV = psd[binMin];
  for (let k = binMin + 1; k <= binMax; k++) {
    if (psd[k] > peakV) { peakV = psd[k]; peakBin = k; }
  }
  const A = peakV;
  if (A <= 0) return peakBin * freqRes;

  const fitRange = 8;
  const lo = Math.max(binMin, peakBin - fitRange);
  const hi = Math.min(binMax, peakBin + fitRange);

  // Initial f0 from parabolic
  const y0 = psd[Math.max(0, peakBin-1)], y1 = psd[peakBin], y2 = psd[Math.min(psd.length-1, peakBin+1)];
  const denom = y0 - 2*y1 + y2;
  const delta = Math.abs(denom) > 1e-15 ? 0.5 * (y0 - y2) / denom : 0;
  let f0 = (peakBin + delta) * freqRes;

  // Estimate gamma
  const gammaEst = [];
  for (let k = lo; k <= hi; k++) {
    if (k === peakBin) continue;
    const Lk = psd[k];
    if (Lk <= 0 || Lk >= A * 0.99) continue;
    const ratio = A / Lk;
    if (ratio <= 1) continue;
    const df = k * freqRes - f0;
    const g2 = df * df / (ratio - 1);
    if (g2 > 0 && g2 < 10000) gammaEst.push({ gamma: Math.sqrt(g2), weight: Lk / A });
  }
  let gamma = 3.0;
  if (gammaEst.length >= 3) {
    gammaEst.sort((a, b) => a.gamma - b.gamma);
    const totalW = gammaEst.reduce((s, e) => s + e.weight, 0);
    let cumW = 0;
    for (const e of gammaEst) { cumW += e.weight; if (cumW >= totalW * 0.5) { gamma = e.gamma; break; } }
  } else if (gammaEst.length > 0) {
    gamma = gammaEst.reduce((s, e) => s + e.gamma, 0) / gammaEst.length;
  }

  // Newton iteration for f0
  for (let iter = 0; iter < 10; iter++) {
    let num = 0, den = 0;
    for (let k = lo; k <= hi; k++) {
      const fi = k * freqRes;
      const Li = psd[k];
      const pred = A / (1 + Math.pow((fi - f0) / gamma, 2));
      const resid = Li - pred;
      const dPdf0 = 2 * A * (fi - f0) / (gamma * gamma * Math.pow(1 + Math.pow((fi - f0) / gamma, 2), 2));
      num += resid * dPdf0;
      den += dPdf0 * dPdf0;
    }
    if (Math.abs(den) < 1e-20) break;
    const step = num / den;
    f0 += step;
    if (Math.abs(step) < 0.01) break;
  }
  return f0;
}

// Quadratic-log interpolation (works well with log-shaped peaks)
function findPeakQuadLog(psd, fs = DSP_FS) {
  const freqRes = fs / DSP_N;
  const binMin = Math.floor(DSP_FMIN / freqRes);
  const binMax = Math.floor(DSP_FMAX / freqRes);
  let peakBin = binMin, peakV = psd[binMin];
  for (let k = binMin + 1; k <= binMax; k++) {
    if (psd[k] > peakV) { peakV = psd[k]; peakBin = k; }
  }
  if (peakBin <= binMin || peakBin >= binMax) return peakBin * freqRes;
  const y0 = Math.log(Math.max(psd[peakBin - 1], 1e-15));
  const y1 = Math.log(Math.max(psd[peakBin], 1e-15));
  const y2 = Math.log(Math.max(psd[peakBin + 1], 1e-15));
  const denom = y0 - 2*y1 + y2;
  const delta = Math.abs(denom) > 1e-15 ? 0.5 * (y0 - y2) / denom : 0;
  return (peakBin + delta) * freqRes;
}

// Compare multiple methods
console.log("");
console.log("=".repeat(78));
console.log("METHOD COMPARISON — peak refinement only (no H(f))");
console.log("=".repeat(78));
console.log("Scenario".padEnd(32) + "Centroid".padEnd(12) + "Parabolic".padEnd(12) + "QuadLog".padEnd(12) + "Lorentzian");
console.log("-".repeat(78));

const methodScenarios = [
  { name: "f=25Hz ζ=0.10", f_n: 25, zeta: 0.10 },
  { name: "f=42Hz ζ=0.10", f_n: 42, zeta: 0.10 },
  { name: "f=42Hz ζ=0.05", f_n: 42, zeta: 0.05 },
  { name: "f=42Hz ζ=0.20", f_n: 42, zeta: 0.20 },
  { name: "f=60Hz ζ=0.10", f_n: 60, zeta: 0.10 },
  { name: "f=80Hz ζ=0.10", f_n: 80, zeta: 0.10 },
  { name: "f=100Hz ζ=0.10", f_n: 100, zeta: 0.10 },
];

for (const sc of methodScenarios) {
  const nTrials = 8;
  const errs = { cent: [], para: [], qlog: [], lor: [] };
  for (let t = 0; t < nTrials; t++) {
    const a_cmd = generateCommandedAccel(32768, DSP_FS, { n_events: 30, a_max: 3000 });
    const a_meas = simulate2ndOrder(a_cmd, sc.f_n, sc.zeta, DSP_FS);
    for (let i = 0; i < a_meas.length; i++) a_meas[i] += (Math.random() - 0.5) * 0.4;
    const { psd } = welchPsd(a_meas, DSP_FS);
    errs.cent.push(Math.abs(findPeakCentroid(psd) - sc.f_n));
    errs.para.push(Math.abs(findPeakParabolic(psd) - sc.f_n));
    errs.qlog.push(Math.abs(findPeakQuadLog(psd) - sc.f_n));
    errs.lor.push(Math.abs(findPeakLorentzian(psd) - sc.f_n));
  }
  const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  console.log(
    sc.name.padEnd(32) +
    `${mean(errs.cent).toFixed(3)}Hz`.padEnd(12) +
    `${mean(errs.para).toFixed(3)}Hz`.padEnd(12) +
    `${mean(errs.qlog).toFixed(3)}Hz`.padEnd(12) +
    `${mean(errs.lor).toFixed(3)}Hz`
  );
}
console.log("=".repeat(78));
