const sim = require('./sim_realistic_helpers.js');
const { welchPsd, detectPeaksCurrent, generateRealisticMotion, simulateMultiMode,
        adxl345Model, DSP_FS, DSP_N, N_SAMPLES } = sim;
const TRUE_F = 42.5;
let relVars = [], snrs = [];
for (let t = 0; t < 20; t++) {
  const { a_cmd_x } = generateRealisticMotion(N_SAMPLES, DSP_FS, { n_moves: 40, a_max: 3000 });
  const a_meas = simulateMultiMode(a_cmd_x, [{ f: TRUE_F, zeta: 0.08, gain: 1.0 }]);
  const adxl = adxl345Model(a_meas, new Float64Array(N_SAMPLES), new Float64Array(N_SAMPLES), {});
  const sig = new Float64Array(N_SAMPLES);
  let m = 0; for (let i=0; i<N_SAMPLES; i++) m += adxl.rx[i]; m /= N_SAMPLES;
  for (let i=0; i<N_SAMPLES; i++) sig[i] = adxl.rx[i] - m;
  const { psd } = welchPsd(sig);
  const pks = detectPeaksCurrent(psd);
  if (!pks.length) continue;
  let peakBin = 0, bestV = 0;
  for (let i = 0; i < psd.length; i++) {
    if (Math.abs(psd[i].f - pks[0].f) < 1.5 && psd[i].v > bestV) { bestV = psd[i].v; peakBin = i; }
  }
  const std_ = Math.sqrt(psd[peakBin].var);
  const power = psd[peakBin].v;
  const relVar = std_ / power;
  const snr = power / Math.max(std_, power*0.01);
  relVars.push(relVar);
  snrs.push(snr);
}
const mean = a => a.reduce((x,y)=>x+y,0)/a.length;
console.log(`relVar: mean=${mean(relVars).toFixed(3)}, range=[${Math.min(...relVars).toFixed(3)}, ${Math.max(...relVars).toFixed(3)}]`);
console.log(`SNR:    mean=${mean(snrs).toFixed(1)}, range=[${Math.min(...snrs).toFixed(1)}, ${Math.max(...snrs).toFixed(1)}]`);
