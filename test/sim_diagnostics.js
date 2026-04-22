// ================================================================
// FEMTO SHAPER Diagnostic Tests
// CI coverage, gate threshold, multi-mode deflation
// Run: node test/sim_diagnostics.js
// ================================================================
"use strict";

// Load helpers from main sim
const sim = require('./sim_realistic_helpers.js');
const { welchPsd, detectPeaksCurrent, detectPeaksDeflation, generateRealisticMotion,
        simulateMultiMode, addFanVibration, adxl345Model, zoomPeakRefine,
        DSP_FS, DSP_N, DSP_OVERLAP, DSP_STEP, N_SAMPLES } = sim;

const TRUE_F_X = 42.5;
const TRUE_F_Y = 38.0;
const TRUE_ZETA_X = 0.08;
const TRUE_ZETA_Y = 0.10;

function computePeakCI(peakFreq, peakVar, peakPower, binWidth, nEff) {
  if (peakPower <= 0) return null;
  const peakStd = Math.sqrt(peakVar);
  const snr = peakPower / Math.max(peakStd, peakPower * 0.01);
  const sigma_f = binWidth / (Math.sqrt(snr) * Math.sqrt(Math.max(1, nEff)) + 1);
  return { lo: peakFreq - 1.96 * sigma_f, hi: peakFreq + 1.96 * sigma_f, sigma: sigma_f };
}

const mean = arr => arr.length > 0 ? arr.reduce((a,b) => a+b, 0) / arr.length : 0;
const std = arr => {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s,v) => s+(v-m)**2, 0) / arr.length);
};

// ── CI COVERAGE TEST ──────────────────────────────────────
console.log("=".repeat(90));
console.log("CI COVERAGE VALIDATION — does computePeakCI give correct 95% coverage?");
console.log("=".repeat(90));
console.log("Scenario".padEnd(25) + "True  PeakMean  Bias   PredSig  ActualSig  Ratio   Cov%");
console.log("-".repeat(90));

const ciScenarios = [
  { name: "Baseline", n_moves: 40, a_max: 3000 },
  { name: "Fan noise 70Hz", n_moves: 40, a_max: 3000, fans: [{f:70, amp:0.3, phase:0.1, harmonics: true}] },
  { name: "Low excitation", n_moves: 10, a_max: 1500 },
];

for (const sc of ciScenarios) {
  const peaks = [], sigmas = [], covered = [];
  const NTRIALS = 30;
  for (let t = 0; t < NTRIALS; t++) {
    const { a_cmd_x } = generateRealisticMotion(N_SAMPLES, DSP_FS, sc);
    const a_meas = simulateMultiMode(a_cmd_x, [{ f: TRUE_F_X, zeta: TRUE_ZETA_X, gain: 1.0 }]);
    if (sc.fans) addFanVibration(a_meas, sc.fans);
    const adxl = adxl345Model(a_meas, new Float64Array(N_SAMPLES), new Float64Array(N_SAMPLES), {});
    const sig = new Float64Array(N_SAMPLES);
    let m = 0; for (let i=0; i<N_SAMPLES; i++) m += adxl.rx[i]; m /= N_SAMPLES;
    for (let i=0; i<N_SAMPLES; i++) sig[i] = adxl.rx[i] - m;
    const { psd, segs } = welchPsd(sig);
    const pks = detectPeaksCurrent(psd);
    if (pks.length === 0) continue;
    const pk = pks[0];
    const binWidth = DSP_FS / DSP_N;
    let peakBin = 0, bestV = 0;
    for (let i = 0; i < psd.length; i++) {
      if (Math.abs(psd[i].f - pk.f) < 1.5 && psd[i].v > bestV) { bestV = psd[i].v; peakBin = i; }
    }
    const ci = computePeakCI(pk.f, psd[peakBin].var, psd[peakBin].v, binWidth, segs);
    peaks.push(pk.f);
    sigmas.push(ci ? ci.sigma : 0);
    covered.push(ci ? (ci.lo <= TRUE_F_X && TRUE_F_X <= ci.hi) : false);
  }
  const pkMean = mean(peaks);
  const actualStd = std(peaks);
  const sigMean = mean(sigmas);
  const covPct = covered.filter(Boolean).length / covered.length * 100;
  const ratio = actualStd > 0 ? sigMean / actualStd : 0;
  console.log(
    sc.name.padEnd(25) +
    `${TRUE_F_X}`.padEnd(6) +
    `${pkMean.toFixed(2)}`.padEnd(10) +
    `${Math.abs(pkMean-TRUE_F_X).toFixed(2)}`.padEnd(7) +
    `${sigMean.toFixed(3)}`.padEnd(9) +
    `${actualStd.toFixed(3)}`.padEnd(11) +
    `${ratio.toFixed(2)}`.padEnd(8) +
    `${covPct.toFixed(0)}%`
  );
}
console.log("");

// ── GATE THRESHOLD TEST ──────────────────────────────────
console.log("=".repeat(90));
console.log("GATE RATIO vs ACCURACY — when does accuracy become unreliable?");
console.log("=".repeat(90));
console.log("NMoves  GateRatio   ErrX    ErrY    MaxErr   Quality");
console.log("-".repeat(90));
for (const nm of [5, 10, 20, 40, 80]) {
  const errs_x = [], errs_y = [], gates = [];
  for (let t = 0; t < 10; t++) {
    const { a_cmd_x, a_cmd_y } = generateRealisticMotion(N_SAMPLES, DSP_FS, { n_moves: nm, a_max: 3000 });
    const a_mx = simulateMultiMode(a_cmd_x, [{f: TRUE_F_X, zeta: TRUE_ZETA_X, gain: 1}]);
    const a_my = simulateMultiMode(a_cmd_y, [{f: TRUE_F_Y, zeta: TRUE_ZETA_Y, gain: 1}]);
    const adxlX = adxl345Model(a_mx, new Float64Array(N_SAMPLES), new Float64Array(N_SAMPLES), {});
    const adxlY = adxl345Model(new Float64Array(N_SAMPLES), a_my, new Float64Array(N_SAMPLES), {});
    const sig_x = new Float64Array(N_SAMPLES), sig_y = new Float64Array(N_SAMPLES);
    let mx=0, my=0;
    for (let i=0; i<N_SAMPLES; i++) { mx += adxlX.rx[i]; my += adxlY.ry[i]; }
    mx /= N_SAMPLES; my /= N_SAMPLES;
    for (let i=0; i<N_SAMPLES; i++) { sig_x[i] = adxlX.rx[i] - mx; sig_y[i] = adxlY.ry[i] - my; }
    const wx = welchPsd(sig_x), wy = welchPsd(sig_y);
    const pkX = detectPeaksCurrent(wx.psd), pkY = detectPeaksCurrent(wy.psd);
    if (pkX.length > 0) errs_x.push(Math.abs(pkX[0].f - TRUE_F_X));
    if (pkY.length > 0) errs_y.push(Math.abs(pkY[0].f - TRUE_F_Y));
    // Gate ratio estimate
    let activeSegs = 0;
    const numSegs = Math.floor((N_SAMPLES - DSP_OVERLAP) / DSP_STEP);
    for (let s = 0; s < numSegs; s++) {
      let e = 0;
      for (let i = s*DSP_STEP; i < s*DSP_STEP+DSP_N && i < N_SAMPLES; i++) e += sig_x[i]**2;
      if (e > 0.01) activeSegs++;
    }
    gates.push(activeSegs / numSegs);
  }
  const gMean = mean(gates), ex = mean(errs_x), ey = mean(errs_y);
  const maxE = Math.max(...errs_x, ...errs_y);
  let quality = '';
  if (gMean < 0.1) quality = 'CRITICAL: unreliable';
  else if (gMean < 0.2) quality = 'marginal: retry recommended';
  else if (gMean < 0.4) quality = 'acceptable';
  else quality = 'good';
  console.log(
    `${nm}`.padEnd(8) +
    `${(gMean*100).toFixed(0)}%`.padEnd(12) +
    `${ex.toFixed(2)}Hz`.padEnd(8) +
    `${ey.toFixed(2)}Hz`.padEnd(8) +
    `${maxE.toFixed(1)}Hz`.padEnd(9) +
    quality
  );
}
console.log("");

// ── MULTI-MODE DEFLATION TEST ────────────────────────────
console.log("=".repeat(90));
console.log("MULTI-MODE SEPARATION — does iterative deflation help?");
console.log("=".repeat(90));
console.log("Scenario".padEnd(30) + "Current (primary/secondary err)   Deflation (primary/secondary err)");
console.log("-".repeat(90));

const multiScens = [
  { name: "Close modes (Δ=4Hz)",       f1: 42, f2: 46 },
  { name: "Moderate gap (Δ=10Hz)",     f1: 42, f2: 52 },
  { name: "Wide gap (Δ=25Hz)",         f1: 42, f2: 67 },
  { name: "Equal amplitude (Δ=8Hz)",   f1: 42, f2: 50, equalAmp: true },
];

for (const sc of multiScens) {
  const curE1 = [], curE2 = [], defE1 = [], defE2 = [];
  for (let t = 0; t < 10; t++) {
    const { a_cmd_x } = generateRealisticMotion(N_SAMPLES, DSP_FS, { n_moves: 40, a_max: 3000 });
    const a_meas = simulateMultiMode(a_cmd_x, [
      { f: sc.f1, zeta: 0.08, gain: 1.0 },
      { f: sc.f2, zeta: 0.10, gain: sc.equalAmp ? 1.0 : 0.4 },
    ]);
    const adxl = adxl345Model(a_meas, new Float64Array(N_SAMPLES), new Float64Array(N_SAMPLES), {});
    const sig = new Float64Array(N_SAMPLES);
    let m = 0; for (let i=0; i<N_SAMPLES; i++) m += adxl.rx[i]; m /= N_SAMPLES;
    for (let i=0; i<N_SAMPLES; i++) sig[i] = adxl.rx[i] - m;
    const { psd } = welchPsd(sig);
    const curPks = detectPeaksCurrent(psd);
    const defPks = detectPeaksDeflation(psd, 4);
    const findBest = (pks, tgt) => pks.reduce((best, p) => Math.abs(p.f-tgt) < Math.abs((best?.f||1e9)-tgt) ? p : best, null);
    const c1 = findBest(curPks, sc.f1), c2 = findBest(curPks, sc.f2);
    const d1 = findBest(defPks, sc.f1), d2 = findBest(defPks, sc.f2);
    if (c1) curE1.push(Math.abs(c1.f - sc.f1));
    if (c2) curE2.push(Math.abs(c2.f - sc.f2));
    if (d1) defE1.push(Math.abs(d1.f - sc.f1));
    if (d2) defE2.push(Math.abs(d2.f - sc.f2));
  }
  console.log(
    sc.name.padEnd(30) +
    `${mean(curE1).toFixed(2)}/${mean(curE2).toFixed(2)}Hz (n=${curE1.length}/${curE2.length})`.padEnd(34) +
    `${mean(defE1).toFixed(2)}/${mean(defE2).toFixed(2)}Hz (n=${defE1.length}/${defE2.length})`
  );
}
console.log("=".repeat(90));
