// Validate new empirical CI formula
"use strict";
const sim = require('./sim_realistic_helpers.js');
const { welchPsd, detectPeaksCurrent, generateRealisticMotion, simulateMultiMode,
        addFanVibration, adxl345Model, DSP_FS, DSP_N, N_SAMPLES } = sim;

const TRUE_F = 42.5;
const TRUE_ZETA = 0.08;

// New empirical CI formula v3 (matches shaper.js:computePeakCI)
function computePeakCINew(peakFreq, peakVar, peakPower, binWidth) {
  if (peakPower <= 0) return null;
  const peakStd = Math.sqrt(peakVar);
  const relVar = peakStd / Math.max(peakPower, 1e-12);
  const sigma_f = 0.15 * binWidth + 0.15 * binWidth * Math.max(0, relVar - 0.5);
  return { lo: peakFreq - 1.96 * sigma_f, hi: peakFreq + 1.96 * sigma_f, sigma: sigma_f };
}

const scens = [
  { name: "Baseline (clean)",    n_moves: 40, a_max: 3000 },
  { name: "Fan noise 70Hz",      n_moves: 40, a_max: 3000, fans: [{f:70, amp:0.3, phase:0.1, harmonics: true}] },
  { name: "Fan noise 70+120Hz",  n_moves: 40, a_max: 3000, fans: [{f:70, amp:0.3, phase:0.1, harmonics: true},{f:120,amp:0.2,phase:0.7,harmonics:true}] },
  { name: "Low excitation (10m)", n_moves: 10, a_max: 1500 },
  { name: "Noisy sensor",        n_moves: 40, a_max: 3000, adxl: { noise: 0.05 * 9.80665 } },
];

console.log("=".repeat(90));
console.log("NEW CI FORMULA VALIDATION (target: 95% coverage)");
console.log("=".repeat(90));
console.log("Scenario".padEnd(25) + "Peak(mean)  Actual σ   Pred σ    Ratio    Cov%  Status");
console.log("-".repeat(90));

const mean = arr => arr.reduce((a,b) => a+b, 0) / arr.length;
const std = arr => { const m = mean(arr); return Math.sqrt(arr.reduce((s,v)=>s+(v-m)**2, 0)/arr.length); };

for (const sc of scens) {
  const peaks = [], sigmas = [], covered = [];
  for (let t = 0; t < 50; t++) {
    const { a_cmd_x } = generateRealisticMotion(N_SAMPLES, DSP_FS, sc);
    const a_meas = simulateMultiMode(a_cmd_x, [{ f: TRUE_F, zeta: TRUE_ZETA, gain: 1.0 }]);
    if (sc.fans) addFanVibration(a_meas, sc.fans);
    const adxl = adxl345Model(a_meas, new Float64Array(N_SAMPLES), new Float64Array(N_SAMPLES), sc.adxl || {});
    const sig = new Float64Array(N_SAMPLES);
    let m = 0; for (let i=0; i<N_SAMPLES; i++) m += adxl.rx[i]; m /= N_SAMPLES;
    for (let i=0; i<N_SAMPLES; i++) sig[i] = adxl.rx[i] - m;
    const { psd } = welchPsd(sig);
    const pks = detectPeaksCurrent(psd);
    if (pks.length === 0) continue;
    const pk = pks[0];
    let peakBin = 0, bestV = 0;
    for (let i = 0; i < psd.length; i++) {
      if (Math.abs(psd[i].f - pk.f) < 1.5 && psd[i].v > bestV) { bestV = psd[i].v; peakBin = i; }
    }
    const ci = computePeakCINew(pk.f, psd[peakBin].var, psd[peakBin].v, DSP_FS/DSP_N);
    peaks.push(pk.f);
    sigmas.push(ci.sigma);
    covered.push(ci.lo <= TRUE_F && TRUE_F <= ci.hi);
  }
  const pkMean = mean(peaks), actual = std(peaks), pred = mean(sigmas);
  const cov = covered.filter(Boolean).length / covered.length * 100;
  const ratio = actual > 0 ? pred / actual : 0;
  const status = cov >= 90 ? 'OK' : cov >= 80 ? 'ACCEPT' : 'TOO NARROW';
  console.log(
    sc.name.padEnd(25) +
    `${pkMean.toFixed(2)}Hz`.padEnd(12) +
    `${actual.toFixed(3)}`.padEnd(11) +
    `${pred.toFixed(3)}`.padEnd(10) +
    `${ratio.toFixed(2)}`.padEnd(9) +
    `${cov.toFixed(0)}%`.padEnd(7) +
    status
  );
}
console.log("=".repeat(90));
