#pragma once
// ============================================================
// dsp.h — FEMTO SHAPER Welch PSD 엔진 v1.2
//
// [v1.2 변경] N=512→1024, 오버랩 75%
//   해상도: 6.25Hz → 3.125Hz/bin
//   세그먼트 스텝: 256샘플 (75% 오버랩 → 동일 스텝, COLA 성립)
//   빈 수: 257→513
//   관심 범위: 18.75~200Hz (bin 6~64)
//   RAM: 9KB → 18KB (ESP32-C3 가용 140KB 중 13%)
//   FFT 시간: ~2ms → ~5ms
//
// 이유: 28Hz 공진이 6.25Hz 격자에서 빈4(25Hz)/빈5(31.25Hz) 사이에
//       걸려 3Hz 오차 → 3.125Hz 격자에서 빈9(28.125Hz)로 0.125Hz 오차
//
// [기존 버그수정 v1.0~v1.1 유지]
//
// 메모리:
//   _re/_im:    1024 × 2 × 4B = 8192B
//   _hann:      1024 × 4B     = 4096B
//   _psdSum:    513 × 4B      = 2052B
//   _segBuf:    1024 × 2B     = 2048B
//   dspPsdAccum:513 × 4B      = 2052B
//   합계:                     ~18.4KB
// ============================================================

#include <Arduino.h>
#include <math.h>
#include <string.h>

// ── 파라미터 ─────────────────────────────────────────
#define DSP_N        1024
#define DSP_OVERLAP  768                               // 75% 오버랩
#define DSP_STEP     (DSP_N - DSP_OVERLAP)             // 256 (기존과 동일 스텝)
#define DSP_FS_DEFAULT 3200.0f
#define DSP_NBINS    (DSP_N / 2 + 1)                   // 513

#define DSP_FMIN     18.75f
#define DSP_FMAX     200.0f

static float _dspSampleRate = DSP_FS_DEFAULT;

static inline void dspSetSampleRate(float sampleRate) {
  _dspSampleRate = (sampleRate > 0.0f) ? sampleRate : DSP_FS_DEFAULT;
}

static inline float dspGetSampleRate() {
  return _dspSampleRate;
}

static inline float dspFreqRes() {
  return _dspSampleRate / DSP_N;
}

static inline int dspBinMin() {
  return (int)(DSP_FMIN / dspFreqRes());
}

static inline int dspBinMax() {
  return (int)(DSP_FMAX / dspFreqRes());
}

// ── 내부 상태 (static → 전역 오염 없음) ──────────────
static float   _re[DSP_N];
static float   _im[DSP_N];
static float   _hann[DSP_N];
static float   _hannPower = 0.0f;  
static bool    _hannReady = false;
static float   _psdSum[DSP_NBINS]; 
static float   _psdSumSq[DSP_NBINS]; // v0.9: 제곱합 → 분산 계산용
static int     _segCount  = 0;
static int16_t _segBuf[DSP_N];     
static int     _segFill   = 0;

// ── 공개 변수 (main.cpp에서 읽기 전용) ───────────────
float dspPsdAccum[DSP_NBINS];  
float dspPsdVar[DSP_NBINS];       // v0.9: PSD 분산 (빈별 신뢰도)
float dspBgPsd[DSP_NBINS];        // 배경 PSD 스냅샷 (정지 구간)
int   dspBgSegs = 0;              // 배경 세그먼트 수
int   dspSegCount = 0;
int   dspMinValidSegs = 256;

// ── Hann 윈도우 초기화 (1회) ────────────────────────
static void _initHann() {
  if (_hannReady) return;
  _hannPower = 0.0f;
  for (int i = 0; i < DSP_N; i++) {
    _hann[i] = 0.5f * (1.0f - cosf(2.0f * (float)M_PI * i / (DSP_N - 1)));
    _hannPower += _hann[i] * _hann[i];
  }
  _hannReady = true;
}

// ── Bit-Reversal Permutation ─────────────────────────
static void _bitReverse() {
  int j = 0;
  for (int i = 1; i < DSP_N; i++) {
    int bit = DSP_N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      float tr = _re[i]; _re[i] = _re[j]; _re[j] = tr;
      float ti = _im[i]; _im[i] = _im[j]; _im[j] = ti;
    }
  }
}

// ── Radix-2 Cooley-Tukey FFT (in-place) ──────────────
static void _fft() {
  _bitReverse();
  for (int len = 2; len <= DSP_N; len <<= 1) {
    float ang = -2.0f * (float)M_PI / len;
    float wRe = cosf(ang), wIm = sinf(ang);
    for (int i = 0; i < DSP_N; i += len) {
      float uRe = 1.0f, uIm = 0.0f;
      int   half = len >> 1;
      for (int j = 0; j < half; j++) {
        int   a = i + j, b = a + half;
        float tRe = uRe * _re[b] - uIm * _im[b];
        float tIm = uRe * _im[b] + uIm * _re[b];
        _re[b] = _re[a] - tRe;
        _im[b] = _im[a] - tIm;
        _re[a] += tRe;
        _im[a] += tIm;
        float nuRe = uRe * wRe - uIm * wIm;
        uIm = uRe * wIm + uIm * wRe;
        uRe = nuRe;
      }
    }
  }
}

// ── 세그먼트 1개 처리 → _psdSum에 누적 ──────────────
static void _processSegment() {
  const float scale = 0.0039f * 9.80665f;  // raw → m/s²
  for (int i = 0; i < DSP_N; i++) {
    _re[i] = _segBuf[i] * scale * _hann[i];
    _im[i] = 0.0f;
  }
  _fft();
  // 단측 PSD: P(k) = |X(k)|² / (fs × Σw²)
  float norm = dspGetSampleRate() * _hannPower;
  for (int k = 0; k < DSP_NBINS; k++) {
    float p = (_re[k]*_re[k] + _im[k]*_im[k]) / norm;
    if (k > 0 && k < DSP_NBINS - 1) p *= 2.0f;
    _psdSum[k] += p;
    _psdSumSq[k] += p * p;  // v0.9: 분산 계산용
  }
  _segCount++;
}

// ══════════════════════════════════════════════════════
// 공개 API
// ══════════════════════════════════════════════════════

// ── 세그먼트별 에너지 추적 (스윕 자동 감지용) ──
static float _lastSegEnergy = 0.0f;   // 마지막 세그먼트 에너지
static int   _quietSegs     = 0;      // 연속 저에너지 세그먼트 수
static int   _hotSegs       = 0;      // v0.9: 연속 고에너지 세그먼트 수
static bool  _sweepActive   = false;  // 스윕이 감지됐는지
static bool  _sweepDetectOn = true;   // false → 배경 수집 모드 (sweepActive 안 됨)
static float _sweepThreshold = 0.0f;  // 스윕 에너지 임계값 (동적)
static int   _sweepActiveSegs = 0;    // v0.9: sweep active 후 누적 세그먼트
static volatile bool dspLiveNewSeg = false;  // v0.9: 라이브 — 세그먼트 완료 플래그
static float dspBgEnergy = 0.0f;     // v0.9: 부팅 배경 에너지 → threshold 기준
static float _energyEMA = 0.0f;      // v0.9: 에너지 이동평균
#define QUIET_SEGS_LIMIT 40           // 40연속 조용 = 3.2초 → 스윕 종료 판정
#define HOT_SEGS_REQUIRED 5           // v0.9: 5연속 고에너지 → 진짜 스윕
#define MIN_SWEEP_SEGS 40             // v0.9: 최소 40세그먼트(3.2초) sweep해야 종료 허용

// 리셋 (측정 시작 전 호출)
void dspReset() {
  _initHann();
  memset(_psdSum,      0, sizeof(_psdSum));
  memset(_psdSumSq,   0, sizeof(_psdSumSq));
  memset(_segBuf,      0, sizeof(_segBuf));
  memset(dspPsdAccum,  0, sizeof(dspPsdAccum));
  // dspBgPsd는 리셋하지 않음! (배경 PSD 유지)
  _segCount      = 0;
  _segFill       = 0;
  dspSegCount    = 0;
  _lastSegEnergy = 0.0f;
  _quietSegs     = 0;
  _hotSegs       = 0;
  _sweepActive   = false;
  _sweepDetectOn = true;
  _sweepThreshold = 0.0f;
  _sweepActiveSegs = 0;
  _energyEMA = 0.0f;
  // bgEnergy가 있으면 threshold 초기값으로 사용 (배경 대기 시간 단축)
  if (dspBgEnergy > 0) _sweepThreshold = dspBgEnergy;
}

// 샘플 1개 공급 — loop()에서 호출
void dspFeed(int16_t sample) {
  _segBuf[_segFill++] = sample;
  if (_segFill >= DSP_N) {
    _processSegment();
    memmove(_segBuf, _segBuf + DSP_STEP, DSP_OVERLAP * sizeof(int16_t));
    _segFill    = DSP_OVERLAP;
    dspSegCount = _segCount;
    dspLiveNewSeg = true;  // 라이브 SSE 트리거

    // 세그먼트 에너지 계산
    float segE = 0.0f;
    int binMin = dspBinMin();
    int binMax = dspBinMax();
    for (int k = binMin; k <= binMax; k++) {
      segE += _psdSum[k];
    }
    _lastSegEnergy = segE / (_segCount > 0 ? _segCount : 1);

    // v0.9: 에너지 이동평균 (α=0.3 → 노이즈 스파이크 완화)
    _energyEMA = (_segCount <= 1) ? _lastSegEnergy : _energyEMA * 0.7f + _lastSegEnergy * 0.3f;

    // 스윕 감지 로직
    bool hasBgThreshold = (_sweepThreshold > 0 && dspBgEnergy > 0);

    if (!hasBgThreshold && _segCount <= 5) {
      // bgEnergy 없음 → 처음 5 세그먼트로 threshold 학습
      if (_segCount == 1) _sweepThreshold = _lastSegEnergy;
      else _sweepThreshold = (_sweepThreshold * (_segCount-1) + _lastSegEnergy) / _segCount;
      if (_sweepThreshold < 50.0f) _sweepThreshold = 50.0f;
      if (_segCount == 5 && dspBgSegs == 0) {
        dspBgSegs = 5;
        for (int k = 0; k < DSP_NBINS; k++)
          dspBgPsd[k] = _psdSum[k] / 5.0f;
        Serial.printf("[DSP] bg PSD saved (thresh=%.1f)\n", _sweepThreshold);
      }
    } else if (_sweepDetectOn) {
      // v0.9 개선: EMA 기반 스윕 감지
      // bgEnergy 있으면 즉시 감지 가능 (5 세그먼트 대기 불필요)
      float triggerMult = hasBgThreshold ? 3.0f : 5.0f; // bgEnergy 기준이면 더 민감
      if (!_sweepActive) {
        if (_energyEMA > _sweepThreshold * triggerMult) {
          _hotSegs++;
          if (_hotSegs >= HOT_SEGS_REQUIRED) {
            _sweepActive = true;
            _quietSegs = 0;

            // ★ v0.9 핵심: PSD 리셋 — 대기 중 노이즈 세그먼트 전부 버림
            // bgPsd는 유지 (seg 1-5에서 이미 저장됨)
            memset(_psdSum, 0, sizeof(_psdSum));
            memset(_psdSumSq, 0, sizeof(_psdSumSq));
            _segCount = 0;
            dspSegCount = 0;
            _sweepActiveSegs = 0;

            Serial.printf("[DSP] sweepActive! PSD reset (%d hot segs, E=%.1f, thresh=%.1f)\n",
              _hotSegs, _lastSegEnergy, _sweepThreshold);
          }
        } else {
          _hotSegs = 0;
        }
      } else {
        _sweepActiveSegs++;
        if (_lastSegEnergy < _sweepThreshold * 2.0f) {
          _quietSegs++;
        } else {
          _quietSegs = 0;
        }
      }
    }
  }
}

// 스윕 종료 판정 (main.cpp에서 호출)
// v0.9: sweep 시작 후 최소 MIN_SWEEP_SEGS(3.2초) 이상 수집해야 종료 허용
bool dspSweepEnded() {
  return _sweepActive && _quietSegs >= QUIET_SEGS_LIMIT && _sweepActiveSegs >= MIN_SWEEP_SEGS;
}

// 스윕 활성 여부
bool dspSweepActive() {
  return _sweepActive;
}

// 공개 PSD 갱신 — API 응답 직전에 1회 호출
// API 호출 시에만 실행 (성능 최적화)
void dspUpdateAccum() {
  if (_segCount == 0) return;
  for (int k = 0; k < DSP_NBINS; k++) {
    float mean = _psdSum[k] / _segCount;
    dspPsdAccum[k] = mean;
    // v0.9: 분산 = E[X²] - E[X]² (세그먼트 간 변동성)
    float meanSq = _psdSumSq[k] / _segCount;
    dspPsdVar[k] = (meanSq > mean * mean) ? meanSq - mean * mean : 0.0f;
  }
}

// 피크 주파수 추출 (Hz)
// power: 피크 파워 반환 (NULL 가능)
//
// [시뮬레이션 검증 결과]
// 파라볼릭 보간은 Hann 윈도우 spectral leakage로 최대 2.5Hz 오차 발생
// → 5-bin 무게중심법(centroid)으로 교체 → 오차 0.05Hz 이내
//
// centroid 원리:
//   피크 bin ±2 범위에서 PSD 파워를 가중치로 주파수 평균
//   f_peak = Σ(f_k × P_k) / Σ(P_k)
//   Hann 누수 파워 분포가 대칭적이라 자연스럽게 실제 주파수로 수렴
float dspFindPeak(float* power) {
  if (_segCount == 0) { if (power) *power = 0.0f; return 0.0f; }

  // v0.9: 피크 탐색 18.75~150Hz (100~150Hz는 JS filterByBackground가 조건부 필터링)
  float freqRes = dspFreqRes();
  int binMin = dspBinMin();
  int binMax = dspBinMax();
  const int PEAK_BIN_MAX = min(binMax, (int)(150.0f / freqRes));  // bin 48 = 150Hz
  int   peakBin   = binMin;
  float peakPower = dspPsdAccum[binMin];
  for (int k = binMin + 1; k <= PEAK_BIN_MAX; k++) {
    if (dspPsdAccum[k] > peakPower) {
      peakPower = dspPsdAccum[k];
      peakBin   = k;
    }
  }
  if (power) *power = peakPower;

  // 2. 5-bin 무게중심법 (centroid interpolation)
  // 범위: peakBin ±2 (경계 클리핑)
  int lo = (peakBin - 2 > binMin) ? peakBin - 2 : binMin;
  int hi = (peakBin + 2 < binMax) ? peakBin + 2 : binMax;

  float sum_pw = 0.0f, sum_fw = 0.0f;
  for (int k = lo; k <= hi; k++) {
    sum_fw += k * freqRes * dspPsdAccum[k];
    sum_pw += dspPsdAccum[k];
  }
  if (sum_pw > 1e-12f) return sum_fw / sum_pw;
  return peakBin * freqRes;
}

// 노이즈 플로어 추정 (적응형)
// [Round 11 개선] peakFreq 기반 적응형 구간 선택
//
// 문제: 90Hz+ 고정 기준은 120Hz 공진 시 노이즈 구간과 겹침
// 해결: 피크 주파수에서 +25Hz 이상을 노이즈 구간으로 사용
//       max(90Hz, peakHz+25Hz) → 전 대역 공진에서 안정적
//
// [Round 12] DC 오탐 감지 추가
//   peak=DSP_BIN_MIN 이고 bin[MIN] > 5×bin[MIN+1]
//   → 저주파 누수 오탐 → 0.0 반환 (SNR=0, valid=false)
float dspNoiseFloor() {
  if (_segCount == 0) return 0.0f;

  // 피크 위치 파악
  float freqRes = dspFreqRes();
  int binMin = dspBinMin();
  int binMax = dspBinMax();
  int pkBin = binMin;
  for (int k = binMin + 1; k <= binMax; k++)
    if (dspPsdAccum[k] > dspPsdAccum[pkBin]) pkBin = k;

  // [Round 12] DC/저주파 오탐 감지
  // peak=DSP_BIN_MIN이고 단조감소 패턴 → 저주파 누수
  if (pkBin == binMin &&
      dspPsdAccum[binMin] > 5.0f * dspPsdAccum[binMin + 1]) {
    return 0.0f;  // SNR 계산 불가 → 오탐으로 처리
  }

  // 적응형 noiseFloor 구간: max(90Hz, peakHz+25Hz)
  float peakHz = pkBin * freqRes;
  float nfStart = peakHz + 25.0f;
  if (nfStart < 90.0f)  nfStart = 90.0f;
  if (nfStart > 180.0f) nfStart = 90.0f;  // 너무 높으면 90Hz 폴백

  int kMin = (int)(nfStart / freqRes);
  if (kMin < binMin)      kMin = binMin;
  if (kMin > binMax - 4)  kMin = binMax - 4;

  int n = binMax - kMin + 1;
  if (n <= 0 || n > DSP_NBINS) return 0.0f;
  float tmp[DSP_NBINS];
  for (int i = 0; i < n; i++) tmp[i] = dspPsdAccum[kMin + i];
  // 삽입 정렬
  for (int i = 1; i < n; i++) {
    float key = tmp[i]; int j = i - 1;
    while (j >= 0 && tmp[j] > key) { tmp[j+1] = tmp[j]; j--; }
    tmp[j+1] = key;
  }
  return tmp[n / 2];  // 중앙값
}

// SNR (dB)
// 시뮬레이션 결과: SNR > 10dB이면 안정적 검출, < 10dB이면 신뢰 불가
float dspSNRdB(float peakPower, float noiseFloor) {
  if (noiseFloor < 1e-12f || peakPower < 1e-12f) return 0.0f;
  return 10.0f * log10f(peakPower / noiseFloor);
}

// SNR 기반 신뢰도 판단
// 시뮬레이션 기준: > 15dB = 높음, 10~15dB = 보통, < 10dB = 낮음
inline float dspConfidence(float snrDb) {
  if (snrDb >= 15.0f) return 1.0f;
  if (snrDb >= 10.0f) return 0.5f + (snrDb - 10.0f) / 10.0f;
  return 0.0f;
}


// ── 멀티피크 검출 ──────────────────────────────────────
// [Round 3 시뮬레이션 발견]
// 두 공진이 근접하거나 벨트 비대칭 시 centroid가 중간값으로 편향됨
// → prominence 기반 local maxima 검출로 해결
//
// prominence = (peak_val - surrounding_min) / peak_val
// 임계값 0.2 이상인 local maxima를 피크로 인정
// 반환: 파워 내림차순 정렬, 최대 5개
// 근거: 정상 1~2개 + 하모닉 1~2개 + 이상 징후 1개
//       피크 4~5개면 기계 문제 → Diagnostic 안내
#define DSP_MAX_PEAKS 5

struct DspMultiPeak {
  float freq;        // Hz (centroid 보간)
  float power;       // (m/s²)²/Hz
  float prominence;  // 0~1 (돌출도)
};

int dspFindPeaks(DspMultiPeak* peaks, float minProminence) {
  if (_segCount == 0) return 0;
  int count = 0;

  // v0.9: 노이즈 플로어 기반 절대 임계값
  // 하위 30% 중앙값 × 5 — 바닥 대비 5x 미만은 피크 아님
  int binMin = dspBinMin();
  int binMax = dspBinMax();
  float sortBuf[DSP_NBINS];
  int nBins = 0;
  for (int k = binMin; k <= binMax; k++) sortBuf[nBins++] = dspPsdAccum[k];
  // 간이 정렬 (59 bins — 삽입 정렬)
  for (int i = 1; i < nBins; i++) {
    float key = sortBuf[i]; int j = i - 1;
    while (j >= 0 && sortBuf[j] > key) { sortBuf[j+1] = sortBuf[j]; j--; }
    sortBuf[j+1] = key;
  }
  float noiseFloor = sortBuf[(int)(nBins * 0.3f)];
  float absThreshold = noiseFloor * 5.0f;
  if (absThreshold < 50.0f) absThreshold = 50.0f;

  // local maxima 탐색
  float freqRes = dspFreqRes();
  for (int k = binMin + 1; k < binMax && count < DSP_MAX_PEAKS * 2; k++) {
    if (dspPsdAccum[k] <= absThreshold) continue;  // v0.9: 절대 임계값 미달
    if (dspPsdAccum[k] > dspPsdAccum[k-1] && dspPsdAccum[k] > dspPsdAccum[k+1]) {
      // prominence 계산: 좌우 ±4bin 내 최솟값 대비
      int lo4 = (k-4 > binMin) ? k-4 : binMin;
      int hi4 = (k+4 < binMax) ? k+4 : binMax;
      float lMin = dspPsdAccum[lo4];
      for (int i = lo4; i < k; i++) if (dspPsdAccum[i] < lMin) lMin = dspPsdAccum[i];
      float rMin = dspPsdAccum[k+1];
      for (int i = k+1; i <= hi4; i++) if (dspPsdAccum[i] < rMin) rMin = dspPsdAccum[i];
      float surMin = lMin > rMin ? lMin : rMin;
      float prom = dspPsdAccum[k] > 1e-12f
        ? (dspPsdAccum[k] - surMin) / dspPsdAccum[k]
        : 0.0f;
      if (prom >= minProminence && count < DSP_MAX_PEAKS * 2) {
        // centroid 보간
        int plo = (k-2 > binMin) ? k-2 : binMin;
        int phi = (k+2 < binMax) ? k+2 : binMax;
        float sw = 0.0f, sfw = 0.0f;
        for (int i = plo; i <= phi; i++) { sw += dspPsdAccum[i]; sfw += i*freqRes*dspPsdAccum[i]; }
        float freq = sw > 1e-12f ? sfw/sw : k*freqRes;
        // 배열에 저장
        if (count < DSP_MAX_PEAKS) {
          peaks[count++] = {freq, dspPsdAccum[k], prom};
        }
      }
    }
  }
  // 파워 내림차순 정렬 (삽입 정렬)
  for (int i = 1; i < count; i++) {
    DspMultiPeak key = peaks[i]; int j = i-1;
    while (j >= 0 && peaks[j].power < key.power) { peaks[j+1] = peaks[j]; j--; }
    peaks[j+1] = key;
  }
  return count;
}

// 상태 요약
// 멀티피크 구조체 (Phase 2 확장 준비)
// 멀티피크 구조체 (최대 DSP_MAX_PEAKS개)
struct DspPeak {
  float freq;        // Hz
  float power;       // (m/s²)²/Hz
  float prominence;  // 주변 대비 돌출도
  float bandwidth;   // -3dB 폭
};

struct DspStatus {
  int     segCount;
  float   peakFreq;    // Hz
  float   peakPower;   // (m/s²)²/Hz
  float   noiseFloor;
  float   snrDb;
  bool    valid;       // segCount >= 10 AND snrDb >= 10: 추천 가능
  bool    displayable; // segCount >= 3: 그래프 표시 가능
  float   confidence;  // 0.0~1.0: SNR 기반 신뢰도
  DspMultiPeak peaks[DSP_MAX_PEAKS]; // 멀티피크 (최대 5개)
  int           peakCount;              // 실제 검출된 피크 수
};

DspStatus dspGetStatus() {
  dspUpdateAccum();  // [문제2] 조회 시 1회 갱신
  DspStatus s;
  s.segCount   = _segCount;
  s.displayable= (_segCount >= 3);
  s.peakFreq   = dspFindPeak(&s.peakPower);
  s.noiseFloor = dspNoiseFloor();
  s.snrDb      = dspSNRdB(s.peakPower, s.noiseFloor);
  s.confidence = dspConfidence(s.snrDb);
  s.valid      = (_segCount >= dspMinValidSegs) && (s.snrDb >= 6.0f);
  s.peakCount  = dspFindPeaks(s.peaks, 0.2f); // 멀티피크 검출
  return s;
}

// ══════════════════════════════════════════════════════
// v1.0 듀얼 DSP 엔진 — Print & Measure 전용
// X/Y 동시 축적, 독립 FFT, 독립 PSD
//
// v1.0.2 개선:
//   - 에너지 가중 Welch: 세그먼트별 에너지 비례 PSD 가중
//     (가감속 = 고가중, 등속/정지 = 저가중 → 이진 게이트 불필요)
//   - DC 제거: 슬라이딩 평균 차감
//   - 피크 수렴 추적: 누적 피크 주파수 이동 → 수렴 판정
//   - X/Y 교차 상관: 실시간 분리 품질 모니터링
//   - SNR 추정: 축별 피크/노이즈 비율
// ══════════════════════════════════════════════════════

// ── 듀얼 버퍼 ───────────────────────────────────────
static float _dualBufX[DSP_N];
static float _dualBufY[DSP_N];
static float _dualPsdSumX[DSP_NBINS];    // 가중 PSD 누적합
static float _dualPsdSumY[DSP_NBINS];
static float _dualPsdSqX[DSP_NBINS];     // 가중 PSD 제곱합 (분산)
static float _dualPsdSqY[DSP_NBINS];
static float _dualWeightSum = 0.0f;       // 가중치 합 (X/Y 공유)
static int   _dualFill = 0;
static int      _dualSegActive = 0;          // 유효 세그먼트 (가중>0)
static uint32_t _dualSegTotal = 0;  // R21.2: uint32로 변경 + INT_MAX 부근에서 clamp
static volatile bool dspDualNewSeg = false;
#define DUAL_MAX_TOTAL_SEGS 45000         // 최대 ~60분 (float32 정밀도 보호)
static bool  _dualMaxReached = false;

// DC 제거
static float _dcX = 0.0f, _dcY = 0.0f;
static bool  _dcInit = false;

// 에너지 추적
static float _dualEnergyEMA = 0.0f;       // 배경 에너지 EMA
static float _dualLastEnergyX = 0.0f;
static float _dualLastEnergyY = 0.0f;

// 피크 수렴 추적 — 최근 N회 피크 주파수 기록
#define DUAL_PEAK_HISTORY 8
static float _peakHistX[DUAL_PEAK_HISTORY];
static float _peakHistY[DUAL_PEAK_HISTORY];
static int   _peakHistIdx = 0;
static int   _peakHistCount = 0;

// X/Y 교차 상관 (실시간)
static float _corrSumXY = 0.0f;           // Σ(psdX × psdY)
static float _corrSumXX = 0.0f;           // Σ(psdX²)
static float _corrSumYY = 0.0f;           // Σ(psdY²)
static int   _corrCount = 0;

// 듀얼용 공개 PSD
float dspDualPsdX[DSP_NBINS];
float dspDualPsdY[DSP_NBINS];
float dspDualVarX[DSP_NBINS];
float dspDualVarY[DSP_NBINS];

// ══════════════════════════════════════════════════════
// Phase 2: Jerk PSD — 입력 스펙트럼 추정 (OMA → EMA 격상)
// jerk(t) = d/dt(accel(t)) ≈ a[n] - a[n-1]
// F(f) ≈ FFT(jerk), H(f) = X(f) / F(f) 전달함수 추정
// 메모리: 2 × DSP_NBINS × 4B × 2(sum+public) = ~8KB
// ══════════════════════════════════════════════════════
static float _dualJerkPsdSumX[DSP_NBINS];
static float _dualJerkPsdSumY[DSP_NBINS];
float dspJerkPsdX[DSP_NBINS];
float dspJerkPsdY[DSP_NBINS];
static bool  _jerkEnabled = true;   // 런타임 토글 (NVS/설정 연동용)

// ── 내부: float 버퍼 → FFT → PSD 빈 배열 반환 ──────
// 가중 누적은 호출자가 처리
static void _processDualSeg(float* buf, float* psdOut) {
  _initHann();
  for (int i = 0; i < DSP_N; i++) {
    _re[i] = buf[i] * _hann[i];
    _im[i] = 0.0f;
  }
  _fft();
  float norm = dspGetSampleRate() * _hannPower;
  for (int k = 0; k < DSP_NBINS; k++) {
    float p = (_re[k]*_re[k] + _im[k]*_im[k]) / norm;
    if (k > 0 && k < DSP_NBINS - 1) p *= 2.0f;
    psdOut[k] = p;
  }
}

// ── 세그먼트 에너지 (RMS²) ──────────────────────────
static float _calcSegEnergy(float* buf) {
  float e = 0;
  for (int i = 0; i < DSP_N; i++) e += buf[i] * buf[i];
  return e / DSP_N;
}

// ── 전방 선언 ─────────────────────────────────────
float dspDualFindPeak(float* psd, int segCount, float* outPower);

// ── 듀얼 샘플 공급 ──────────────────────────────────
void dspFeedDual(float valX, float valY) {
  // DC 제거
  if (!_dcInit) {
    _dcX = valX; _dcY = valY; _dcInit = true;
  } else {
    _dcX = _dcX * 0.999f + valX * 0.001f;
    _dcY = _dcY * 0.999f + valY * 0.001f;
  }

  _dualBufX[_dualFill] = valX - _dcX;
  _dualBufY[_dualFill] = valY - _dcY;
  _dualFill++;

  if (_dualFill >= DSP_N) {
    // R21.2: INT_MAX 근처에서 clamp - 반복 재정규화는 45000 주기에서 처리됨
    if (_dualSegTotal < 0x7FFFFFFFu) _dualSegTotal++;

    // ── 최대 세그먼트 보호: float32 정밀도 유지 ────
    // 45,000세그먼트(~60분) 도달 시 누적값을 절반으로 재정규화
    // → 최근 데이터가 상대적으로 더 반영됨 (자연스러운 가중)
    if (_dualSegTotal > 0 && (_dualSegTotal % DUAL_MAX_TOTAL_SEGS) == 0) {
      for (int k = 0; k < DSP_NBINS; k++) {
        _dualPsdSumX[k] *= 0.5f; _dualPsdSumY[k] *= 0.5f;
        _dualPsdSqX[k]  *= 0.5f; _dualPsdSqY[k]  *= 0.5f;
      }
      _dualWeightSum *= 0.5f;
      _dualMaxReached = true;
    }

    // 세그먼트 에너지
    float eX = _calcSegEnergy(_dualBufX);
    float eY = _calcSegEnergy(_dualBufY);
    float eSum = eX + eY;
    _dualLastEnergyX = eX;
    _dualLastEnergyY = eY;

    // 배경 에너지 EMA (느린 추적 → 배경 레벨)
    if (_dualSegTotal <= 3) {
      _dualEnergyEMA = eSum;
    } else {
      _dualEnergyEMA = _dualEnergyEMA * 0.97f + eSum * 0.03f;
    }

    // ── 에너지 가중치 계산 ────────────────────────
    // w = max(0, E - Ebg) / Ebg → 배경 대비 초과 에너지
    // 등속/정지: w ≈ 0 (배경 수준) → PSD에 거의 기여 안 함
    // 가감속:    w >> 1 → PSD에 강하게 기여
    float bgE = (_dualEnergyEMA > 1e-15f) ? _dualEnergyEMA : 1e-15f;
    float weight = (eSum - bgE) / bgE;
    if (weight < 0.0f) weight = 0.0f;
    if (weight > 100.0f) weight = 100.0f;  // 클리핑
    // 최소 가중치: 배경 세그먼트도 미량 기여 (완전 무시 방지)
    weight += 0.01f;

    // ── FFT + 가중 PSD 누적 ──────────────────────
    static float _tmpPsd[DSP_NBINS];

    _processDualSeg(_dualBufX, _tmpPsd);
    for (int k = 0; k < DSP_NBINS; k++) {
      _dualPsdSumX[k] += _tmpPsd[k] * weight;
      _dualPsdSqX[k]  += _tmpPsd[k] * _tmpPsd[k] * weight;
    }

    _processDualSeg(_dualBufY, _tmpPsd);
    for (int k = 0; k < DSP_NBINS; k++) {
      _dualPsdSumY[k] += _tmpPsd[k] * weight;
      _dualPsdSqY[k]  += _tmpPsd[k] * _tmpPsd[k] * weight;
    }

    // ── Phase 2: Jerk PSD 누적 (입력 스펙트럼 F(f) 추정) ──
    // jerk[i] = acc[i] - acc[i-1] (first-difference)
    // jerk buffer는 동일 오버랩 구간 활용 (in-place)
    if (_jerkEnabled) {
      static float _tmpJerk[DSP_N];
      // X축 jerk
      _tmpJerk[0] = _dualBufX[0];  // 경계 샘플 (이전 값 없음 → 자기 자신)
      for (int i = 1; i < DSP_N; i++) _tmpJerk[i] = _dualBufX[i] - _dualBufX[i-1];
      _processDualSeg(_tmpJerk, _tmpPsd);
      for (int k = 0; k < DSP_NBINS; k++) _dualJerkPsdSumX[k] += _tmpPsd[k] * weight;
      // Y축 jerk
      _tmpJerk[0] = _dualBufY[0];
      for (int i = 1; i < DSP_N; i++) _tmpJerk[i] = _dualBufY[i] - _dualBufY[i-1];
      _processDualSeg(_tmpJerk, _tmpPsd);
      for (int k = 0; k < DSP_NBINS; k++) _dualJerkPsdSumY[k] += _tmpPsd[k] * weight;
    }

    _dualWeightSum += weight;
    if (weight > 0.1f) _dualSegActive++;

    // ── 교차 상관 업데이트 (PSD 도메인) ──────────
    // 매 세그먼트마다 X/Y PSD 상관 추적
    if (_dualWeightSum > 0) {
      float sumXY=0, sumXX=0, sumYY=0;
      int binMin = dspBinMin();
      int binMax = dspBinMax();
      for (int k = binMin; k <= binMax; k++) {
        float px = _dualPsdSumX[k] / _dualWeightSum;
        float py = _dualPsdSumY[k] / _dualWeightSum;
        sumXY += px * py;
        sumXX += px * px;
        sumYY += py * py;
      }
      _corrSumXY = sumXY; _corrSumXX = sumXX; _corrSumYY = sumYY;
      _corrCount = _dualSegTotal;
    }

    // ── 피크 수렴 추적 (매 10세그먼트) ───────────
    if (_dualSegTotal % 10 == 0 && _dualWeightSum > 0.1f) {
      // 현재 PSD에서 피크 계산
      float tmpPsdX[DSP_NBINS], tmpPsdY[DSP_NBINS];
      for (int k=0; k<DSP_NBINS; k++) {
        tmpPsdX[k] = _dualPsdSumX[k] / _dualWeightSum;
        tmpPsdY[k] = _dualPsdSumY[k] / _dualWeightSum;
      }
      float pwrX=0, pwrY=0;
      _peakHistX[_peakHistIdx] = dspDualFindPeak(tmpPsdX, 1, &pwrX);
      _peakHistY[_peakHistIdx] = dspDualFindPeak(tmpPsdY, 1, &pwrY);
      _peakHistIdx = (_peakHistIdx + 1) % DUAL_PEAK_HISTORY;
      if (_peakHistCount < DUAL_PEAK_HISTORY) _peakHistCount++;
    }

    // 75% 오버랩 슬라이드
    memmove(_dualBufX, _dualBufX + DSP_STEP, DSP_OVERLAP * sizeof(float));
    memmove(_dualBufY, _dualBufY + DSP_STEP, DSP_OVERLAP * sizeof(float));
    _dualFill = DSP_OVERLAP;
    dspDualNewSeg = true;
  }
}

// ── 듀얼 리셋 ───────────────────────────────────────
void dspResetDual() {
  memset(_dualBufX, 0, sizeof(_dualBufX));
  memset(_dualBufY, 0, sizeof(_dualBufY));
  memset(_dualPsdSumX, 0, sizeof(_dualPsdSumX));
  memset(_dualPsdSumY, 0, sizeof(_dualPsdSumY));
  memset(_dualPsdSqX, 0, sizeof(_dualPsdSqX));
  memset(_dualPsdSqY, 0, sizeof(_dualPsdSqY));
  memset(dspDualPsdX, 0, sizeof(dspDualPsdX));
  memset(dspDualPsdY, 0, sizeof(dspDualPsdY));
  memset(_dualJerkPsdSumX, 0, sizeof(_dualJerkPsdSumX));  // Phase 2
  memset(_dualJerkPsdSumY, 0, sizeof(_dualJerkPsdSumY));
  memset(dspJerkPsdX, 0, sizeof(dspJerkPsdX));
  memset(dspJerkPsdY, 0, sizeof(dspJerkPsdY));
  memset(_peakHistX, 0, sizeof(_peakHistX));
  memset(_peakHistY, 0, sizeof(_peakHistY));
  _dualFill = 0;
  _dualWeightSum = 0;
  _dualSegActive = 0;
  _dualSegTotal = 0;
  _dcX = _dcY = 0; _dcInit = false;
  _dualEnergyEMA = 0;
  _peakHistIdx = 0; _peakHistCount = 0;
  _corrSumXY = _corrSumXX = _corrSumYY = 0;
  _corrCount = 0;
  _dualMaxReached = false;
  dspDualNewSeg = false;
}

// ── 듀얼 PSD 갱신 ───────────────────────────────────
void dspUpdateDual() {
  if (_dualWeightSum < 1e-12f) return;
  for (int k = 0; k < DSP_NBINS; k++) {
    float meanX = _dualPsdSumX[k] / _dualWeightSum;
    float meanY = _dualPsdSumY[k] / _dualWeightSum;
    dspDualPsdX[k] = meanX;
    dspDualPsdY[k] = meanY;
    float msqX = _dualPsdSqX[k] / _dualWeightSum;
    float msqY = _dualPsdSqY[k] / _dualWeightSum;
    dspDualVarX[k] = (msqX > meanX*meanX) ? msqX - meanX*meanX : 0.0f;
    dspDualVarY[k] = (msqY > meanY*meanY) ? msqY - meanY*meanY : 0.0f;
    // Phase 2: Jerk PSD (입력 스펙트럼)
    dspJerkPsdX[k] = _dualJerkPsdSumX[k] / _dualWeightSum;
    dspJerkPsdY[k] = _dualJerkPsdSumY[k] / _dualWeightSum;
  }
}

// Phase 2: Jerk 기반 신호 여기 품질 체크
// 반환: 0.0~1.0 (1.0 = 광대역, 0.0 = 편향/저에너지)
float dspJerkBroadness(float* jerkPsd) {
  if (_dualWeightSum < 1e-12f) return 0.0f;
  int binMin = dspBinMin();
  int binMax = dspBinMax();
  float total = 0, maxV = 0;
  for (int k = binMin; k <= binMax; k++) {
    total += jerkPsd[k];
    if (jerkPsd[k] > maxV) maxV = jerkPsd[k];
  }
  int n = binMax - binMin + 1;
  if (maxV < 1e-12f || n <= 0) return 0.0f;
  // Spectral flatness 근사: mean / max (평탄할수록 1에 가까움)
  float meanV = total / n;
  return meanV / maxV;
}

// ── 상태 조회 ────────────────────────────────────────
int dspDualSegCountX()  { return _dualSegActive; }
int dspDualSegCountY()  { return _dualSegActive; }
int dspDualSegTotal()   { return (int)(_dualSegTotal < 0x7FFFFFFFu ? _dualSegTotal : 0x7FFFFFFFu); }
float dspDualGateRatio(){ return _dualSegTotal>0 ? (float)_dualSegActive/_dualSegTotal : 0; }

// X/Y 교차 상관 계수 (0=완벽 분리, 1=동일)
float dspDualCorrelation() {
  if (_corrSumXX < 1e-15f || _corrSumYY < 1e-15f) return 0;
  return _corrSumXY / sqrtf(_corrSumXX * _corrSumYY);
}

// 피크 수렴도: 최근 N회 피크 주파수의 표준편차 (Hz)
// 작을수록 안정 → 측정 신뢰도 ↑
float dspDualConvergence(char axis) {
  if (_peakHistCount < 3) return 999.0f;
  float* hist = (axis == 'x') ? _peakHistX : _peakHistY;
  int n = _peakHistCount;
  // R49: Welford's online variance + min/max range 선행 체크로 float 정밀도 손실 방지
  float maxV = hist[0], minV = hist[0];
  for (int i = 1; i < n; i++) {
    if (hist[i] > maxV) maxV = hist[i];
    if (hist[i] < minV) minV = hist[i];
  }
  float range = maxV - minV;
  // 범위가 0.01Hz 미만이면 수렴된 것으로 간주 (float 잡음 제거)
  if (range < 0.01f) return 0.0f;
  // 일반적인 std 계산 - range 가드 덕분에 numerical instability 위험 낮음
  float sum = 0;
  for (int i = 0; i < n; i++) sum += hist[i];
  float mean = sum / n;
  float sumSqDev = 0;
  for (int i = 0; i < n; i++) { float d = hist[i] - mean; sumSqDev += d * d; }
  float var = sumSqDev / n;
  return (var > 0) ? sqrtf(var) : 0;
}

// 자동 완료 판정: 피크 수렴도 < 1Hz AND 최소 세그먼트 충족
// 자동 완료: 피크 수렴 + 최소 200 유효 세그먼트
bool dspDualAutoReady() {
  return _dualSegActive >= 200
      && _peakHistCount >= 4
      && dspDualConvergence('x') < 1.0f
      && dspDualConvergence('y') < 1.0f;
}
bool dspDualMaxReached() { return _dualMaxReached; }

// 듀얼 피크 검출
float dspDualFindPeak(float* psd, int segCount, float* outPower) {
  if (segCount == 0 && _dualWeightSum < 1e-12f) { if (outPower) *outPower = 0; return 0; }
  float freqRes = dspFreqRes();
  int binMin = dspBinMin();
  int binMax = dspBinMax();
  const int PEAK_BIN_MAX = min(binMax, (int)(150.0f / freqRes));
  int pkBin = binMin;
  float pkV = psd[binMin];
  for (int k = binMin+1; k <= PEAK_BIN_MAX; k++) {
    if (psd[k] > pkV) { pkV = psd[k]; pkBin = k; }
  }
  if (outPower) *outPower = pkV;
  // centroid 보간
  int lo = (pkBin-2 > binMin) ? pkBin-2 : binMin;
  int hi = (pkBin+2 < binMax) ? pkBin+2 : binMax;
  float sw=0, sfw=0;
  for (int k=lo; k<=hi; k++) { sw += psd[k]; sfw += k*freqRes*psd[k]; }
  return sw > 1e-12f ? sfw/sw : pkBin*freqRes;
}
