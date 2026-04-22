// ============ FEMTO SHAPER 계산 엔진 v0.8 ============
//
// Klipper shaper_calibrate.py / shaper_defs.py 로직 JS 포팅
// 원본: https://github.com/Klipper3d/klipper
// Copyright (C) 2020-2024 Dmitry Butyugin <dmbutyugin@google.com>
// License: GNU GPLv3 (Klipper 원본과 동일)
//
// 포팅 항목:
//   - _get_shaper_smoothing() → calcSmoothing()
//   - find_shaper_max_accel() → calcMaxAccel() (이분법 탐색)
//   - _estimate_remaining_vibrations() → calcVibrationRemaining()
//   - _estimate_shaper() → estimateShaperResponse()
//   - 다중 damping ratio worst-case (TEST_DAMPING_RATIOS)
//
// FEMTO 자체 구현:
//   - getShaperDefs() — 쉐이퍼 A/T 계수 생성
//   - estimateDampingRatio() — PSD -3dB 대역폭 추정
//   - analyzeShaper() — 전체 분석 + 이중 추천

// ── Klipper 상수 ─────────────────────────────────────
const DEFAULT_DAMPING = 0.1;

// Klipper: SHAPER_VIBRATION_REDUCTION = 20 (진동 감소 기준 배율)
// PSD 최대값의 1/20 이하는 무시 (노이즈 플로어 처리)
const SHAPER_VIBRATION_REDUCTION = 20;

// Klipper: 여러 댐핑 비율에서 worst-case 취함
const TEST_DAMPING_RATIOS = [0.075, 0.1, 0.15];

// Klipper: max_accel 탐색 시 목표 스무딩
const TARGET_SMOOTHING = 0.12;

// Klipper: 기본 SCV (Square Corner Velocity)
// SCV: _scv() → settings.js getCfgScv() 연동 완료 (Phase 5)
const DEFAULT_SCV = 5.0;

// Settings 탭 연동 헬퍼 (Phase 5)
function _scv()      { return typeof getCfgScv      === 'function' ? getCfgScv()      : DEFAULT_SCV; }
function _damping()  { return typeof getCfgDamping  === 'function' ? getCfgDamping()  : DEFAULT_DAMPING; }
function _targetSm() { return typeof getCfgTargetSm === 'function' ? getCfgTargetSm() : TARGET_SMOOTHING; }

// ══════════════════════════════════════════════════════
// Phase 2: 전달함수 추정 H(f) = X(f) / F(f)
// OMA → EMA 격상: jerk PSD를 입력 스펙트럼으로 사용
//
// H1 추정기 (auto-spectrum 버전):
//   |H(f)|^2 ≈ G_xx(f) / G_ff(f)
//   여기서 G_xx = output PSD (measPsd), G_ff = input PSD (measJerk)
//
// 주의:
//   - F(f)가 0인 bin에서 divison 발산 방지 → noise floor 클램프
//   - 저SNR bin은 신뢰도 penalty
//   - F(f) 스무딩으로 추정 분산 감소
// ══════════════════════════════════════════════════════
function computeTransferFunction(psdOut, psdInput, opts) {
  opts = opts || {};
  const n = (psdOut && psdOut.length) || 0;
  if (!n || !psdInput || psdInput.length === 0) return null;

  // 1) 입력 PSD 스무딩 (±2 bin 이동평균) — 분산 감소
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

  // 2) 입력 노이즈 플로어 (최대치의 1%) — 0-division 차단
  let maxInput = 0;
  for (let i = 0; i < n; i++) if (smoothed[i] > maxInput) maxInput = smoothed[i];
  const noiseFloor = Math.max(maxInput * 0.01, 1e-9);

  // 3) H(f) = X(f) / F(f)  (파워 도메인)
  const H = new Array(n);
  for (let i = 0; i < n; i++) {
    const fIn = Math.max(smoothed[i], noiseFloor);
    const xVal = psdOut[i].v;
    const coherence = Math.min(1, smoothed[i] / maxInput);  // 0~1 신뢰도
    H[i] = {
      f: psdOut[i].f,
      v: xVal / fIn,           // |H(f)|^2 추정
      coherence: coherence,    // 이 주파수에서 입력 에너지 충분한가
      rawV: xVal,              // 원본 출력 PSD 보존
      inputV: smoothed[i],     // 입력 스펙트럼 보존
    };
  }
  return H;
}

// Phase 1-B: 피크 주파수 신뢰구간 계산
// 분산 기반 불확실성 전파: σ_f ≈ Δf × √(var_peak / peak²) / √n_eff
function computePeakCI(psdData, peakFreq, opts) {
  opts = opts || {};
  if (!psdData || psdData.length < 3 || !peakFreq) return null;

  // 피크 인덱스 찾기
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

  // 상대 분산 기반 σ_f (Cramér-Rao lower bound 근사)
  // σ_f = (binWidth / SNR) × (1 / √n_eff)
  const peakStd = Math.sqrt(peakVar);
  const snr = peakPower / Math.max(peakStd, peakPower * 0.01);
  const nEff = Math.max(1, opts.segs || 100);
  const sigma_f = binWidth / (Math.sqrt(snr) * Math.sqrt(nEff) + 1);

  return {
    lo: peakFreq - 1.96 * sigma_f,
    hi: peakFreq + 1.96 * sigma_f,
    sigma: sigma_f,
    snr: snr,
    peakIdx: peakIdx,
  };
}


// ── 쉐이퍼 A/T 계수 정의 ────────────────────────────
// Klipper shaper_defs.py의 init_func 로직을 풀어쓴 것
// 각 쉐이퍼별 A(진폭), T(시간 오프셋) 생성
//
// MZV T값: Opus+GPT 39라운드 검증 완료 — t_d=1/(freq*df), T=[0,0.5*t_d,t_d]
//   → shaper_defs.py 직접 확인 후 수정 예정 (현재 raw 접근 불가)
function getShaperDefs(freq, damping) {
  if (!freq || freq <= 0 || !isFinite(freq)) return [];
  damping = damping || DEFAULT_DAMPING;
  // ζ ≥ 1.0 이면 과감쇠 → sqrt(1-ζ²)가 0 또는 NaN → 방어
  // 실제 3D 프린터 댐핑은 0.01~0.5 범위
  if (damping >= 1.0) damping = 0.99;
  if (damping <= 0) damping = DEFAULT_DAMPING;

  // ── Klipper shaper_defs.py 원본 공식 직접 포팅 ──
  // 출처: github.com/Klipper3d/klipper/blob/master/klippy/extras/shaper_defs.py
  // License: GPL v3

  const v_tol = 1.0 / SHAPER_VIBRATION_REDUCTION; // 진동 허용 비율 = 0.05

  const shapers = [];

  // ── ZV ──
  // K = exp(-ζπ/df), A=[1, K], T=[0, 0.5*t_d]
  {
    const df  = Math.sqrt(1 - damping * damping);
    const K   = Math.exp(-damping * Math.PI / df);
    const t_d = 1.0 / (freq * df);
    shapers.push({ name: 'ZV', A: [1, K], T: [0, 0.5 * t_d] });
  }

  // ── MZV ──
  // Klipper 원본: K = exp(-0.75*ζπ/df) ← ZV와 다른 K!
  // a1 = 1 - 1/√2, a2 = (√2-1)*K, a3 = a1*K²
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

  // ── EI ──
  // Klipper 원본: K = exp(-ζπ/df)
  // a1 = 0.25*(1+v_tol), a2 = 0.5*(1-v_tol)*K, a3 = a1*K²
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

  // ── 2HUMP_EI ──
  // Klipper 원본: get_2hump_ei_shaper() — 4개 임펄스
  // V2 = v_tol², X = (V2*(sqrt(1-V2)+1))^(1/3)
  // a1 = (3X²+2X+3V2)/(16X), a2 = (0.5-a1)*K, a3 = a2*K, a4 = a1*K³
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

  // ── 3HUMP_EI ──
  // Klipper 원본: get_3hump_ei_shaper()
  // a1 = 0.0625*(1+3*v_tol+2*sqrt(2*(v_tol+1)*v_tol))
  // a2 = 0.25*(1-v_tol)*K
  // a3 = (0.5*(1+v_tol)-2*a1)*K²
  // a4 = a2*K²
  // a5 = a1*K⁴
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


// ── 쉐이퍼 주파수 응답 추정 ──────────────────────────
// Klipper _estimate_shaper() 직접 포팅
// 특정 주파수에서 쉐이퍼의 잔여 진동 비율 계산
//
// Klipper 원본 (graph_shaper.py):
//   W = A[i] * exp(-damping * (T[-1] - T[i]))
//   S += W * sin(omega_d * T[i])
//   C += W * cos(omega_d * T[i])
//   return sqrt(S² + C²) * inv_D
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
    // 시간 차이에 따른 감쇠 적용
    const W = A[i] * Math.exp(-damping * (T[n - 1] - T[i]));
    S += W * Math.sin(omegaD * T[i]);
    C += W * Math.cos(omegaD * T[i]);
  }

  return Math.sqrt(S * S + C * C) * invD;
}


// ── 잔여 진동 계산 ────────────────────────────────────
// Klipper _estimate_remaining_vibrations() 포팅
//
// 핵심 차이점 (기존 FEMTO vs Klipper):
//   1. SHAPER_VIBRATION_REDUCTION 임계값 적용
//   2. 다중 damping ratio에서 worst-case 취함
//   3. PSD 진폭(v)을 직접 사용 (v² 아님 — Klipper는 PSD가 이미 power)
//
// @param {Array} psdData - [{f, v}] PSD 데이터
// @param {object} shaper - {A[], T[]}
// @param {number} dampingRatio - 테스트 댐핑 비율
// @returns {number} 잔여 진동 비율 (0~1)
function calcVibrationRemainingForDR(psdData, shaper, dampingRatio) {
  if (!psdData || psdData.length === 0) return 1;

  // PSD 최대값에서 임계값 계산 (Klipper: psd.max() / SHAPER_VIBRATION_REDUCTION)
  let psdMax = 0;
  for (const d of psdData) {
    if (d.v > psdMax) psdMax = d.v;
  }
  const vibrThreshold = psdMax / SHAPER_VIBRATION_REDUCTION;

  let remainingVibrations = 0;
  let allVibrations = 0;

  for (const d of psdData) {
    if (d.f <= 0 || d.f > 200) continue; // Klipper: MAX_FREQ = 200

    // 쉐이퍼 응답 계산
    const response = estimateShaperResponse(shaper, d.f, dampingRatio);

    // Klipper: remaining = max(vals * psd - threshold, 0).sum()
    // Klipper: all = max(psd - threshold, 0).sum()
    const psdVal = d.v;
    remainingVibrations += Math.max(response * psdVal - vibrThreshold, 0);
    allVibrations += Math.max(psdVal - vibrThreshold, 0);
  }

  return allVibrations > 0 ? remainingVibrations / allVibrations : 1;
}

/**
 * 여러 damping ratio에서 worst-case 잔여 진동 계산
 * Klipper: TEST_DAMPING_RATIOS = [0.075, 0.1, 0.15] 중 최대값 사용
 */
function calcVibrationRemaining(psdData, shaper) {
  let worstVibr = 0;
  for (const dr of TEST_DAMPING_RATIOS) {
    const vibr = calcVibrationRemainingForDR(psdData, shaper, dr);
    if (vibr > worstVibr) worstVibr = vibr;
  }
  return worstVibr;
}


// ── 스무딩 계산 ──────────────────────────────────────
// Klipper _get_shaper_smoothing() 직접 포팅
//
// Klipper 원본:
//   ts = Σ(A[i]*T[i]) / Σ(A[i])  — 쉐이퍼 중심 시간
//   T[i] >= ts 인 임펄스에 대해:
//     offset_90  += A[i] * (scv + half_accel*(T[i]-ts)) * (T[i]-ts)
//     offset_180 += A[i] * half_accel * (T[i]-ts)²
//   smoothing = max(offset_90 * √2 * inv_D, offset_180 * inv_D)
//
// @param {object} shaper - {A[], T[]}
// @param {number} accel - 가속도 (mm/s², 기본 5000)
// @param {number} scv - Square Corner Velocity (mm/s, 기본 5)
// @returns {number} 스무딩 값 (mm)
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

  // 쉐이퍼 중심 시간 (Klipper: ts)
  let sumAT = 0, sumA = 0;
  for (let i = 0; i < n; i++) {
    sumAT += A[i] * T[i];
    sumA += A[i];
  }
  const ts = sumAT / sumA;

  // 90도/180도 턴에서의 오프셋 계산
  let offset90 = 0, offset180 = 0;
  for (let i = 0; i < n; i++) {
    if (T[i] >= ts) {
      const dt = T[i] - ts;
      // 90도 턴: SCV + 가속 성분
      offset90 += A[i] * (scv + halfAccel * dt) * dt;
      // 180도 턴: 가속 성분만
      offset180 += A[i] * halfAccel * dt * dt;
    }
  }
  offset90 *= invD * Math.SQRT2;
  offset180 *= invD;

  return Math.max(offset90, offset180);
}


// ── 최대 가속도 계산 ─────────────────────────────────
// Klipper find_shaper_max_accel() 포팅
//
// Klipper 원본:
//   TARGET_SMOOTHING = 0.12
//   max_accel = bisect(λ accel: smoothing(shaper, accel, scv) ≤ 0.12)
//
// 이분법(bisection)으로 smoothing이 TARGET_SMOOTHING 이하가 되는
// 최대 가속도를 찾음
//
// @param {object} shaper - {A[], T[]}
// @param {number} scv - Square Corner Velocity (기본 5)
// @returns {number} 최대 가속도 (mm/s²)
function calcMaxAccel(shaper, scv) {
  scv = scv || _scv();
  const targetSmoothing = _targetSm(); // Settings 탭 값 반영

  // Klipper _bisect() 로직 포팅
  // smoothing(accel) <= TARGET_SMOOTHING 인 최대 accel 찾기

  // 먼저 상한 찾기: smoothing이 TARGET_SMOOTHING 초과하는 accel
  let left = 1, right = 1;

  // accel이 아주 작을 때 smoothing이 이미 초과하면 0 반환
  if (calcSmoothing(shaper, 1e-9, scv) > targetSmoothing) {
    return 0;
  }

  // 상한 확장
  while (calcSmoothing(shaper, right, scv) <= targetSmoothing) {
    right *= 2;
    if (right > 1e7) return right; // 사실상 무한대
  }

  // left는 OK, right는 초과 → 이분법
  // left 쪽에서 OK인 지점 찾기
  left = right * 0.5;
  while (calcSmoothing(shaper, left, scv) > targetSmoothing) {
    right = left;
    left *= 0.5;
  }

  // 이분법 탐색 (Klipper: right - left > 1e-8)
  for (let iter = 0; iter < 100; iter++) {
    if (right - left <= 1) break; // mm/s² 단위이므로 1 이하면 충분
    const mid = (left + right) * 0.5;
    if (calcSmoothing(shaper, mid, scv) <= targetSmoothing) {
      left = mid;
    } else {
      right = mid;
    }
  }

  return Math.round(left);
}


// ── v0.9 고정밀 피크 분석 엔진 ────────────────────────
// 브라우저 JS = 무제한 연산 → ESP32 3.125Hz PSD에서 최대 정밀도 추출
//
// 1. 3점 Parabolic 보간: 피크 주파수 ±0.1Hz 정밀도
// 2. Lorentzian 피팅: 정확한 댐핑 비율 (기존 -3dB 방식 대체)
// 3. 멀티 Lorentzian 분해: 겹친 피크 분리
// 4. 신뢰 구간: 피팅 R² 기반

/**
 * 3점 Parabolic 보간 — sub-bin 피크 주파수
 * PSD[k-1], PSD[k], PSD[k+1]에 포물선을 피팅하여 꼭짓점 주파수 추출
 * 정밀도: ~0.1Hz (빈 해상도의 1/30)
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

/**
 * Lorentzian 피크 피팅
 * 기계적 공진의 PSD = Lorentzian 형태: L(f) = A / (1 + ((f-f0)/γ)²)
 *   f0 = 공진 주파수, γ = HWHM, A = 피크 진폭
 *   damping = γ / f0
 *
 * 방법: 3점 보간으로 f0 추정 → 주변 빈들에서 γ 최소자승 피팅
 *
 * @returns {f0, amplitude, gamma, damping, rSquared, fitted[]}
 */
function fitLorentzian(psd, peakIdx) {
  if (!psd || peakIdx < 2 || peakIdx >= psd.length - 2) {
    return { f0: psd?.[peakIdx]?.f || 0, amplitude: 0, gamma: 3, damping: DEFAULT_DAMPING, rSquared: 0 };
  }

  // 1단계: Parabolic 보간으로 f0 초기 추정
  const f0Init = parabolicPeakInterp(psd, peakIdx);
  const A = psd[peakIdx].v;
  if (A <= 0) return { f0: f0Init, amplitude: 0, gamma: 3, damping: DEFAULT_DAMPING, rSquared: 0 };

  // 2단계: γ 추정 — 피크 주변 빈들에서 Lorentzian 역산
  // L(f) = A / (1 + ((f-f0)/γ)²) → γ² = (f-f0)² / (A/L(f) - 1)
  const gammaEstimates = [];
  const fitRange = Math.min(8, Math.floor(psd.length / 4)); // ±8빈 (±25Hz)
  for (let di = -fitRange; di <= fitRange; di++) {
    const idx = peakIdx + di;
    if (idx < 0 || idx >= psd.length || di === 0) continue;
    const Li = psd[idx].v;
    if (Li <= 0 || Li >= A * 0.99) continue; // 피크 자체 또는 0은 제외
    const ratio = A / Li;
    if (ratio <= 1) continue;
    const df = psd[idx].f - f0Init;
    const gamma2 = df * df / (ratio - 1);
    if (gamma2 > 0 && gamma2 < 10000) {
      gammaEstimates.push({ gamma: Math.sqrt(gamma2), weight: Li / A }); // 피크에 가까울수록 가중
    }
  }

  // 가중 중앙값 (이상치 robust)
  let gamma = 3.0; // 기본값 ≈ ζ=0.075 @ 40Hz
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

  // 3단계: f0 정밀 보정 — Lorentzian 중심 최적화 (1D Newton)
  // ∂L/∂f0 = 0 → 최소자승 미분
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
    if (Math.abs(step) < 0.01) break; // 0.01Hz 수렴
  }

  // 4단계: R² 피팅 품질
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

  // 댐핑 비율
  const damping = f0 > 0 ? gamma / f0 : DEFAULT_DAMPING;

  return {
    f0: parseFloat(f0.toFixed(2)),
    amplitude: A,
    gamma: parseFloat(gamma.toFixed(3)),
    damping: Math.max(0.01, Math.min(0.5, parseFloat(damping.toFixed(4)))),
    rSquared: parseFloat(rSquared.toFixed(4)),
  };
}

// v1.0: decomposeMultiPeak 삭제 — detectPeaks()로 통합

/**
 * v0.9 댐핑 추정 — Lorentzian 피팅 기반 (기존 -3dB 대역폭 대체)
 *
 * 장점:
 *   - 3.125Hz 빈에서도 sub-bin γ 추정 가능 (8빈 이상 사용)
 *   - R² 피팅 품질로 신뢰도 판단
 *   - 좁은 피크(ζ<0.05)도 추정 가능 (기존: 1빈에 갇혀 실패)
 */
function estimateDampingRatio(psdData, peakFreq) {
  if (!psdData || !peakFreq || psdData.length < 5) return DEFAULT_DAMPING;

  // 피크 인덱스 찾기
  let peakIdx = 0, peakV = 0;
  for (let i = 0; i < psdData.length; i++) {
    if (Math.abs(psdData[i].f - peakFreq) < 3.2 && psdData[i].v > peakV) {
      peakV = psdData[i].v; peakIdx = i;
    }
  }
  if (peakV <= 0) return DEFAULT_DAMPING;

  const fit = fitLorentzian(psdData, peakIdx);

  // R² 낮으면 (피크가 Lorentzian이 아님) → 기본값
  if (fit.rSquared < 0.5) return DEFAULT_DAMPING;

  return fit.damping;
}


// ── 전체 쉐이퍼 분석 (메인 진입점) ───────────────────
/**
 * PSD 데이터로부터 5종 쉐이퍼 전체 분석 수행
 *
 * 반환 구조는 v0.6과 동일 → charts.js / app.js 수정 불필요
 *
 * @param {Array} psdData - [{f, v}] PSD 데이터
 * @param {number} peakFreq - 주 공진 주파수 (Hz)
 * @param {number} damping - 댐핑 비율 (null이면 자동 추정)
 * @param {Array} peaks - [{freq, power, prominence}] 멀티피크 (참고용, 스윕이 자동 처리)
 * @returns {object} {
 *   shapers: [{name, freq, vibrPct, maxAccel, smoothing, duration}],
 *   recommended: {performance: {}, lowVibration: {}, safe: {}},
 *   dampingRatio: number,
 *   multiPeak: {detected, peaks} | null
 * }
 */
function analyzeShaper(psdData, peakFreq, damping, peaks) {
  // 빈 PSD 방어
  if (!psdData || psdData.length === 0) {
    const empty = {name:'ZV',freq:0,vibrPct:100,maxAccel:0,smoothing:1,duration:0,_A:[1],_T:[0],_score:0};
    return { shapers:[empty], recommended:{performance:empty,safe:empty,best:empty}, confidence:0, multiPeak:null };
  }
  // peakFreq 방어 (0/NaN/Infinity → PSD에서 자동 감지)
  if (!isFinite(peakFreq) || peakFreq <= 0) {
    let maxV=0;peakFreq=40;
    for(const p of psdData) if(p.f>=18&&p.f<=150&&isFinite(p.v)&&p.v>maxV){maxV=p.v;peakFreq=p.f;}
    if(peakFreq<=0) peakFreq=40;
  }
  // PSD NaN/Infinity 값 정리
  psdData = psdData.map(p => ({f: p.f, v: isFinite(p.v) ? p.v : 0, var: p.var || 0}));

  // ── v0.9: 분산 기반 빈 가중치 ──────────────────────
  // 분산 낮음 = 세그먼트 간 일관적 = 신뢰도 높음
  // 분산 높음 = 세그먼트마다 다름 = 노이즈 가능성
  const hasVariance = psdData.some(p => p.var > 0);
  let binWeights = null;
  if (hasVariance) {
    const maxVar = Math.max(...psdData.map(p => p.var), 1e-12);
    binWeights = psdData.map(p => {
      if (p.var <= 0 || p.v <= 0) return 1.0;
      // 가중치 = 1 / (1 + CV²),  CV = √var / mean
      const cv = Math.sqrt(p.var) / Math.max(p.v, 1e-12);
      return 1.0 / (1.0 + cv * cv);
    });
  }

  // ── v1.0: 댐핑 비율 — detectPeaks 줌 결과 우선, 폴백 fitLorentzian ──
  if (!damping && peaks && peaks.length > 0 && peaks[0].damping > 0) {
    damping = peaks[0].damping;
  }
  if (!damping) {
    damping = estimateDampingRatio(psdData, peakFreq);
  }

  // 피크 주파수 신뢰 구간 (줌 데이터 기반)
  let freqCI = null;
  if (peaks && peaks[0] && peaks[0].Q > 0) {
    const gamma = peaks[0].gamma || peakFreq * damping;
    const snr = Math.max(peaks[0].snr || 1, 1);
    const sigmaF = gamma / (snr * Math.sqrt(10));
    freqCI = { lower: peakFreq - 1.96 * sigmaF, upper: peakFreq + 1.96 * sigmaF, sigma: sigmaF };
  }

  // PSD 정규화 — 분산 가중 적용
  const psdMax = Math.max(...psdData.map(d => d.v));
  const psdNorm = psdMax > 0
    ? psdData.map((d, i) => ({
        f: d.f,
        v: d.v / psdMax * (binWeights ? binWeights[i] : 1.0)
      }))
    : psdData;

  // ── v0.9: PSD Cubic 보간 (3.125Hz → 0.5Hz) ──────────
  // 제미나이 서드오피니언 반영: 3.125Hz 빈을 1Hz 쉐이퍼 스윕에 적용하면
  // 양자화 오차로 최적 주파수가 ±1.5Hz 빗겨갈 수 있음
  // → Catmull-Rom 보간으로 0.5Hz 해상도 PSD 생성
  function interpolatePSD(psd, step) {
    if (!psd || psd.length < 4) return psd;
    const result = [];
    for (let f = psd[0].f; f <= psd[psd.length-1].f; f += step) {
      // 보간 대상 4포인트 찾기
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
  const psdInterp = interpolatePSD(psdNorm, 0.5);  // 0.5Hz 해상도

  const cfgScv = _scv();

  // ══════════════════════════════════════════════════════
  // Klipper calibrate_shaper.py 방식: 주파수 스윕
  //
  // v0.9 변경:
  //   PSD: 3.125Hz → 0.5Hz Catmull-Rom 보간 (양자화 오차 제거)
  //   스윕: 0.2Hz 스텝 (Klipper numpy arange와 동등)
  //   → 5종 × 675 = 3375회 vibr% 계산 ≈ 50ms (JS에서 무시할 수준)
  // ══════════════════════════════════════════════════════

  const VIBR_THRESHOLD = 5.0; // Klipper: vibr% ≤ 5% 기준
  const SHAPER_NAMES = ['ZV', 'MZV', 'EI', '2HUMP_EI', '3HUMP_EI'];

  const freqMin = 15;
  const freqMax = 150;
  const freqStep = 0.2;  // v0.9: Klipper 동등 (이전 1.0Hz)

  const shapers = [];

  for (const shaperName of SHAPER_NAMES) {
    let bestVibr = Infinity;
    let bestDefs = null;
    const sweepResults = [];

    // 주파수 스윕: 각 주파수에서 vibr%, smoothing, score 계산
    for (let testFreq = freqMin; testFreq <= freqMax; testFreq += freqStep) {
      const defs = getShaperDefs(testFreq, damping);
      const shaperDef = defs.find(s => s.name === shaperName);
      if (!shaperDef) continue;

      const vibrRatio = calcVibrationRemaining(psdInterp, shaperDef);
      const smoothing = calcSmoothing(shaperDef, 5000, cfgScv);

      // Klipper score 공식 (shaper_calibrate.py 직접 포팅):
      //   score = smoothing * (vibrations^1.5 + vibrations * 0.2 + 0.01)
      // "vibr%를 줄이면서 smoothing도 줄이는 밸런스를 찾는 복합 점수"
      const score = smoothing * (Math.pow(vibrRatio, 1.5) + vibrRatio * 0.2 + 0.01);

      if (vibrRatio < bestVibr) {
        bestVibr = vibrRatio;
      }
      sweepResults.push({ freq: testFreq, vibrRatio, vibrPct: vibrRatio * 100, smoothing, score, def: shaperDef });
    }

    // Klipper fit_shaper 선택 로직 (소스 직접 포팅):
    //   1. vibr% 최소인 best_res 찾기
    //   2. best_res.vibrs * 1.1 + 0.0005 이내에서 score 최소 선택
    //   Klipper는 results[::-1] (높은 freq부터) 순회
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

    // maxAccel은 최종 승자만 1회 계산
    let bestFreq = peakFreq, bestSmoothing = 0, bestMaxAccel = 0;
    if (selected) {
      bestDefs = selected.def;
      bestFreq = selected.freq;
      bestSmoothing = selected.smoothing;
      bestMaxAccel = calcMaxAccel(bestDefs, cfgScv);
    } else {
      // fallback: 피크 주파수 기준
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

  // v0.9: 모든 쉐이퍼가 vibr >= 90%이면 공진 미감지 → 피크 주파수 기준 재계산
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

  // ── 추천 선택 (Klipper 동일 기준) ──────────────────
  // Performance: vibr% ≤ 5% 중 maxAccel 최대 (= smoothing 최소)
  // Low vibration: vibr% 최소
  const perfCandidates = shapers.filter(s => s.vibrPct <= VIBR_THRESHOLD);
  const performance = perfCandidates.length > 0
    ? perfCandidates.reduce((a, b) => a.maxAccel > b.maxAccel ? a : b)
    : shapers.reduce((a, b) => a.vibrPct < b.vibrPct ? a : b);
  const lowVibration = shapers.reduce((a, b) => a.vibrPct < b.vibrPct ? a : b);

  // Safe: vibr% ≤ 5% 중 가장 robust (2HUMP_EI/3HUMP_EI 우선)
  const safeCandidates = shapers.filter(s =>
    s.vibrPct <= VIBR_THRESHOLD &&
    (s.name === '2HUMP_EI' || s.name === '3HUMP_EI' || s.name === 'EI')
  );
  const safe = safeCandidates.length > 0
    ? { ...safeCandidates.reduce((a, b) => a.vibrPct < b.vibrPct ? a : b), tag: 'safe' }
    : { ...lowVibration, tag: 'safe' };

  // ── Klipper find_best_shaper — 5종 중 최종 1개 추천 ──
  // Klipper 로직 (shaper_calibrate.py):
  //   score = smoothing * (vibr^1.5 + vibr*0.2 + 0.01)
  //   best = score가 20% 이상 좋거나,
  //          score 5% + smoothing 10% 좋으면 교체
  //   ZV 선택 시: vibr%가 10% 이상 좋은 다른 쉐이퍼가 있으면 교체
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
  // ZV 예외: ZV가 선택되면 vibr%가 10% 이상 좋은 다른 쉐이퍼로 교체
  if (bestShaper && bestShaper.name === 'ZV') {
    for (const s of shapers) {
      if (s.name !== 'ZV' && s.vibrPct * 1.1 < bestShaper.vibrPct) {
        bestShaper = s;
        break;
      }
    }
  }

  // ── 멀티피크: detectPeaks 결과 변환 (통합 피크 사용) ──
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

  // ── broad peak: 줌 Q factor 기반 (하드코딩 대역폭 계산 대체) ──
  let broadPeak = null;
  const zoomQ = dpPeaks.length > 0 ? (dpPeaks[0].Q || 0) : 0;
  if (!multiPeak && zoomQ > 0 && zoomQ < 3) {
    broadPeak = { detected: true, Q: zoomQ, message: 'broad_response_mount_suspect' };
  }

  // ── confidence ─────────────────────────────────────
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

  // ── Classification Layer (GPT P6 + 에너지비율 거부권) ──
  // 5가지 모드: single / dual_dominant / dual_balanced / broad / harmonic
  //
  // 파이프라인:
  //   1. broadPeak 최우선
  //   2. multiPeak 기반 기본 분류
  //   3. 에너지비율 거부권 — 1차 피크 에너지가 전체의 45% 이상이면
  //      dual로 분류된 것을 single로 되돌림 (fp 억제)
  //   4. harmonic은 Quick/Print 융합 시 validator.js에서 최종 판정
  let resonanceMode = 'single';
  if (broadPeak) {
    resonanceMode = 'broad';
  } else if (multiPeak?.level === 'confirmed') {
    resonanceMode = multiPeak.ratio >= 0.6 ? 'dual_balanced' : 'dual_dominant';
  } else if (multiPeak?.level === 'suspected') {
    resonanceMode = 'dual_dominant';
  }

  // 에너지비율 거부권: 1차 피크 ±2bin 에너지 / 전체 에너지
  // > 0.45이면 에너지가 1차에 집중 → 2차는 노이즈 아티팩트 가능성 높음
  // 에너지비율 거부권: suspected 또는 약한 confirmed(ratio<0.4)에서만
  // 강한 confirmed(ratio≥0.4)는 진짜 dual이므로 건드리지 않음
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
        // 에너지가 1차에 집중 → dual이 아니라 single + 노이즈
        resonanceMode = 'single';
      }
    }
  }

  // ── 잔여역검증: multiPeak의 2차 피크가 하모닉이면 single ──
  // ratio가 낮은(약한) 2차 피크에서만 적용 — 강한 2차는 진짜 dual일 수 있음
  if ((resonanceMode === 'dual_dominant') && multiPeak?.peaks?.length >= 2 && multiPeak.ratio < 0.3) {
    const f1 = multiPeak.peaks[0].freq;
    const f2 = multiPeak.peaks[1].freq;
    const fRatio = Math.max(f1, f2) / Math.min(f1, f2);
    const isHarmonicPair = [2, 3, 4].some(h => Math.abs(fRatio - h) < 0.15);
    if (isHarmonicPair) {
      resonanceMode = 'single';
    }
  }

  // ── 저confidence 방어: SNR<6dB 또는 confidence<0.45이면 dual→single ──
  // 노이즈가 심하면 residual에서 가짜 피크를 잡을 확률이 높음
  if ((resonanceMode === 'dual_dominant' || resonanceMode === 'dual_balanced') && confidence < 0.45) {
    resonanceMode = 'single';
  }

  // ── 극단 주파수 방어: peakFreq<22Hz 또는 >130Hz에서 dual 의심 ──
  // 20Hz 이하: 1/f 노이즈 지배적 → residual fp 높음
  // 130Hz 이상: 스테퍼 노이즈 대역 → residual fp 높음
  if ((resonanceMode === 'dual_dominant') && (peakFreq < 22 || peakFreq > 130)) {
    if (!multiPeak || multiPeak.level !== 'confirmed' || multiPeak.ratio < 0.5) {
      resonanceMode = 'single';
    }
  }

  // ── 전략 선택 (모드별 safe_freq / 추천 분기) ──────────
  // single:        perf=primary, safe=EI/2HUMP_EI
  // dual_dominant:  perf=primary, safe=midFreq (가중평균)
  // dual_balanced:  perf=midFreq, safe=midFreq + 2HUMP_EI
  // broad:          perf=primary, safe=EI/2HUMP_EI (mount 경고 동반)
  let safeFreq = peakFreq;
  let perfFreq = performance.freq;
  let safeShaperHint = safe.name;

  if (resonanceMode === 'dual_balanced' && multiPeak?.midFreq) {
    // 균형형 이중 공진: 두 피크 사이의 가중 midpoint를 안전 주파수로
    safeFreq = multiPeak.midFreq;
    perfFreq = multiPeak.midFreq;
    // safe 쉐이퍼는 넓은 대역 억제가 가능한 2HUMP_EI 권장
    const hump2 = shapers.find(s => s.name === '2HUMP_EI');
    if (hump2 && hump2.vibrPct <= 10) safeShaperHint = '2HUMP_EI';
  } else if (resonanceMode === 'dual_dominant' && multiPeak?.midFreq) {
    // 지배적 이중 공진: perf는 primary 유지, safe는 midpoint
    safeFreq = multiPeak.midFreq;
    // perfFreq는 기존 best/performance 그대로
  } else if (resonanceMode === 'broad') {
    // broad: 주파수 신뢰도 낮음 → EI 계열 권장
    safeShaperHint = safe.name; // 이미 EI 계열이 선택됨
  }

  // v1.0: 사용자 프린터 설정 기반 실용 메트릭
  const userAccel = typeof getCfgAccel === 'function' ? getCfgAccel() : 5000;
  const userFeed = typeof getCfgFeedrate === 'function' ? getCfgFeedrate() : 300;
  const userBuildX = typeof getCfgBuildX === 'function' ? getCfgBuildX() : 250;
  const userBuildY = typeof getCfgBuildY === 'function' ? getCfgBuildY() : 250;
  const cfgScvVal = typeof getCfgScv === 'function' ? getCfgScv() : 5.0;
  const recShaper = performance;
  const recMaxAccel = recShaper.maxAccel || 1;
  // 사용자 accel에서의 실제 스무딩
  let userSmoothing = 0;
  if (recShaper._A && recShaper._T) {
    userSmoothing = calcSmoothing({A:recShaper._A, T:recShaper._T}, userAccel, cfgScvVal);
  }
  // 가속 여유도
  const accelHeadroom = recMaxAccel / Math.max(userAccel, 1);
  // 속도 도달 거리: v²/(2a)
  const accelDist = (userFeed * userFeed) / (2 * Math.max(userAccel, 1));
  // 빌드 볼륨 유효성
  const buildMin = Math.min(userBuildX, userBuildY);
  const accelRatio = Math.min(1, (2 * accelDist) / Math.max(buildMin, 1));  // 가감속 비율
  const maxReachSpeed = Math.sqrt(userAccel * buildMin);  // 베드에서 달성 가능한 최고 속도
  const feedReachable = userFeed <= maxReachSpeed;        // feedrate 달성 가능?
  // 등속 구간이 너무 많으면 측정 품질 저하
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
    // v1.0: 사용자 설정 기반 실용 메트릭
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
      // 추천 설정 범위
      rec: (function() {
        const ma = recMaxAccel;
        // 가속도 범위: 보수적(50%) ~ 최대(100%)
        const accelMin = Math.max(1000, Math.round(ma * 0.5 / 100) * 100);
        const accelMax = Math.round(ma / 100) * 100;
        // 속도 범위: 각 가속도에서 가감속 20~40% 기준
        const sMin = Math.round(Math.sqrt(0.2 * accelMin * buildMin));
        const sMax = Math.min(Math.round(Math.sqrt(0.4 * accelMax * buildMin)), Math.round(maxReachSpeed));
        // 상태 판정
        let status;
        if (ma < 2000) status = 'retry';         // 공진이 너무 낮거나 불안정
        else if (userAccel > ma) status = 'over'; // 가속도 초과
        else if (accelHeadroom >= 1.5) status = 'headroom'; // 여유 충분
        else status = 'tight';                    // 여유 적음
        return { accelMin, accelMax, speedMin: sMin, speedMax: sMax, status };
      })(),
    },
  };
}
