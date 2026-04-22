// Shared helpers for simulation tests
"use strict";

const DSP_N = 1024;
const DSP_OVERLAP = 768;
const DSP_STEP = DSP_N - DSP_OVERLAP;
const DSP_NBINS = DSP_N / 2 + 1;
const DSP_FS = 3200;
const DSP_FMIN = 18.75;
const DSP_FMAX = 200.0;
const N_SAMPLES = 32768;

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

function randn() { let u = 0, v = 0; while (u === 0) u = Math.random(); while (v === 0) v = Math.random(); return Math.sqrt(-2*Math.log(u)) * Math.cos(2*Math.PI*v); }

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

function generateRealisticMotion(N, fs, opts = {}) {
  const a_cmd_x = new Float64Array(N);
  const a_cmd_y = new Float64Array(N);
  const a_max = opts.a_max || 3000;
  const v_max = opts.v_max || 200;
  const n_moves = opts.n_moves || 40;
  const move_mix = opts.move_mix || 'mixed';
  let cursor = Math.floor(fs * 0.1);
  for (let m = 0; m < n_moves && cursor < N - fs * 0.3; m++) {
    let dx = 0, dy = 0;
    if (move_mix === 'perim') {
      if (Math.random() > 0.5) { dx = (Math.random() > 0.5 ? 1 : -1); dy = 0.1*(Math.random()-0.5); }
      else { dy = (Math.random() > 0.5 ? 1 : -1); dx = 0.1*(Math.random()-0.5); }
    } else if (move_mix === 'travel') {
      dx = (Math.random() > 0.5 ? 1 : -1); dy = (Math.random() > 0.5 ? 1 : -1);
    } else {
      dx = Math.random() * 2 - 1; dy = Math.random() * 2 - 1;
    }
    const len = Math.sqrt(dx*dx + dy*dy); if (len < 1e-6) continue;
    dx /= len; dy /= len;
    const t_move = fs * (0.1 + Math.random() * 0.3);
    const t_accel = fs * (v_max / a_max);
    const t_const = Math.max(0, t_move - 2 * t_accel);
    const total = Math.min(N - cursor - 1, Math.floor(2*t_accel + t_const));
    for (let n = 0; n < total; n++) {
      let a_val;
      if (n < t_accel) a_val = a_max * (n / t_accel);
      else if (n < t_accel + t_const) a_val = 0;
      else { const rn = n - t_accel - t_const; a_val = -a_max * (rn / t_accel); }
      a_cmd_x[cursor + n] += dx * a_val;
      a_cmd_y[cursor + n] += dy * a_val;
    }
    cursor += total + Math.floor(fs * (0.02 + Math.random() * 0.08));
  }
  return { a_cmd_x, a_cmd_y };
}

function adxl345Model(a_true_x, a_true_y, a_true_z, opts = {}) {
  const G = 9.80665;
  const lsb = 0.004 * G;
  const crossAxis = opts.crossAxis || 0.05;
  const noiseLevel = opts.noise || 0.01 * G;
  const bias_x = opts.bias_x || 0.02 * G;
  const bias_y = opts.bias_y || 0.015 * G;
  const N = a_true_x.length;
  const rx = new Float64Array(N), ry = new Float64Array(N), rz = new Float64Array(N);
  let lpx = 0, lpy = 0, lpz = 0;
  const alpha = 0.7;
  for (let n = 0; n < N; n++) {
    const mx = a_true_x[n] + crossAxis * a_true_y[n] + bias_x + randn() * noiseLevel;
    const my = a_true_y[n] + crossAxis * a_true_x[n] + bias_y + randn() * noiseLevel;
    const mz = (a_true_z ? a_true_z[n] : 0) + G + randn() * noiseLevel;
    lpx = alpha * lpx + (1-alpha) * mx;
    lpy = alpha * lpy + (1-alpha) * my;
    lpz = alpha * lpz + (1-alpha) * mz;
    rx[n] = Math.round(lpx / lsb) * lsb;
    ry[n] = Math.round(lpy / lsb) * lsb;
    rz[n] = Math.round(lpz / lsb) * lsb;
  }
  return { rx, ry, rz };
}

function addFanVibration(signal, fans, fs = DSP_FS) {
  const dt = 1 / fs;
  for (let n = 0; n < signal.length; n++) {
    const t = n * dt;
    for (const fan of fans) {
      signal[n] += fan.amp * Math.sin(2*Math.PI*fan.f*t + fan.phase);
      if (fan.harmonics) {
        signal[n] += fan.amp * 0.4 * Math.sin(2*Math.PI*fan.f*2*t + fan.phase);
        signal[n] += fan.amp * 0.15 * Math.sin(2*Math.PI*fan.f*3*t + fan.phase);
      }
    }
  }
}

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
  const psd = [];
  const freqRes = fs / DSP_N;
  for (let k = 0; k < DSP_NBINS; k++) {
    const m = psdSum[k] / Math.max(weightSum, 1e-15);
    const msq = psdSqSum[k] / Math.max(weightSum, 1e-15);
    psd.push({ f: k * freqRes, v: m, var: Math.max(0, msq - m*m) });
  }
  return { psd, segs: numSegs };
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
  for (const p of selected) {
    const r = zoomPeakRefine(psd, p.f);
    if (r.improved) p.f = r.freq;
    p.damping = r.damping;
    p.Q = r.Q;
  }
  return selected;
}

function detectPeaksDeflation(psd, maxPeaks = 4) {
  const workPsd = psd.map(p => ({ f: p.f, v: p.v, var: p.var }));
  const selected = [];
  for (let iter = 0; iter < maxPeaks; iter++) {
    const pks = detectPeaksCurrent(workPsd);
    if (pks.length === 0) break;
    const pk = pks[0];
    selected.push(pk);
    const r = zoomPeakRefine(workPsd, pk.f);
    const f0 = r.freq || pk.f;
    const gamma = Math.max(1.0, (r.damping || 0.1) * f0);
    const A = pk.v;
    const noiseEst = workPsd.filter(p => Math.abs(p.f - f0) > 15).map(p => p.v).sort((a,b) => a-b);
    const baseline = noiseEst.length > 0 ? noiseEst[Math.floor(noiseEst.length * 0.3)] : 0;
    for (let i = 0; i < workPsd.length; i++) {
      const lorz = (A - baseline) / (1 + Math.pow((workPsd[i].f - f0) / gamma, 2));
      workPsd[i].v = Math.max(baseline, workPsd[i].v - lorz);
    }
  }
  return selected;
}

module.exports = {
  DSP_FS, DSP_N, DSP_NBINS, DSP_OVERLAP, DSP_STEP, DSP_FMIN, DSP_FMAX, N_SAMPLES,
  fft, randn, simulateMultiMode, generateRealisticMotion, adxl345Model,
  addFanVibration, welchPsd, zoomPeakRefine, detectPeaksCurrent, detectPeaksDeflation
};
