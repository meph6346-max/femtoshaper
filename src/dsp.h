#pragma once
// ============================================================
// dsp.h FEMTO SHAPER Welch PSD v1.2
//
// [v1.2 ] N=512 1024, 75%
// : 6.25Hz 3.125Hz/bin
// : 256 (75% , COLA )
// : 257 513
// : 18.75~200Hz (bin 6~64)
// RAM: 9KB 18KB (ESP32-C3 140KB 13%)
// FFT : ~2ms ~5ms
//
// : 28Hz 6.25Hz 4(25Hz)/ 5(31.25Hz)
// 3Hz 3.125Hz 9(28.125Hz) 0.125Hz
//
// [ v1.0~v1.1 ]
//
// :
// _re/_im: 1024 2 4B = 8192B
// _hann: 1024 4B = 4096B
// _psdSum: 513 4B = 2052B
// _segBuf: 1024 2B = 2048B
// dspPsdAccum:513 4B = 2052B
// : ~18.4KB
// ============================================================

#include <Arduino.h>
#include <math.h>
#include <string.h>

//
#define DSP_N        1024
#define DSP_OVERLAP  768                               // 75%
#define DSP_STEP     (DSP_N - DSP_OVERLAP)             // 256 ( )
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

// (static )
static float   _re[DSP_N];
static float   _im[DSP_N];
static float   _hann[DSP_N];
static float   _hannPower = 0.0f;  
static bool    _hannReady = false;
static float   _psdSum[DSP_NBINS]; 
static float   _psdSumSq[DSP_NBINS]; // v0.9:
static int     _segCount  = 0;
static int16_t _segBuf[DSP_N];     
static int     _segFill   = 0;

// (main.cpp )
float dspPsdAccum[DSP_NBINS];  
float dspPsdVar[DSP_NBINS];       // v0.9: PSD ( )
float dspBgPsd[DSP_NBINS];        // PSD ( )
int   dspBgSegs = 0;              //
int   dspSegCount = 0;
int   dspMinValidSegs = 256;

// Hann (1 )
static void _initHann() {
  if (_hannReady) return;
  _hannPower = 0.0f;
  for (int i = 0; i < DSP_N; i++) {
    _hann[i] = 0.5f * (1.0f - cosf(2.0f * (float)M_PI * i / (DSP_N - 1)));
    _hannPower += _hann[i] * _hann[i];
  }
  _hannReady = true;
}

// Bit-Reversal Permutation
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

// Radix-2 Cooley-Tukey FFT (in-place)
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

// 1 _psdSum
static void _processSegment() {
  const float scale = 0.0039f * 9.80665f;  // raw m/s
  for (int i = 0; i < DSP_N; i++) {
    _re[i] = _segBuf[i] * scale * _hann[i];
    _im[i] = 0.0f;
  }
  _fft();
  // PSD: P(k) = |X(k)| / (fs w )
  float norm = dspGetSampleRate() * _hannPower;
  for (int k = 0; k < DSP_NBINS; k++) {
    float p = (_re[k]*_re[k] + _im[k]*_im[k]) / norm;
    if (k > 0 && k < DSP_NBINS - 1) p *= 2.0f;
    _psdSum[k] += p;
    _psdSumSq[k] += p * p;  // v0.9:
  }
  _segCount++;
}

//
// API
//

// ( )
static float _lastSegEnergy = 0.0f;   //
static int   _quietSegs     = 0;      //
static int   _hotSegs       = 0;      // v0.9:
static bool  _sweepActive   = false;  //
static bool  _sweepDetectOn = true;   // false (sweepActive )
static float _sweepThreshold = 0.0f;  // ( )
static int   _sweepActiveSegs = 0;    // v0.9: sweep active
static volatile bool dspLiveNewSeg = false;  // v0.9:
static float dspBgEnergy = 0.0f;     // v0.9: threshold
static float _energyEMA = 0.0f;      // v0.9:
#define QUIET_SEGS_LIMIT 40           // 40 = 3.2
#define HOT_SEGS_REQUIRED 5           // v0.9: 5
#define MIN_SWEEP_SEGS 40             // v0.9: 40 (3.2 ) sweep

// ( )
void dspReset() {
  _initHann();
  memset(_psdSum,      0, sizeof(_psdSum));
  memset(_psdSumSq,   0, sizeof(_psdSumSq));
  memset(_segBuf,      0, sizeof(_segBuf));
  memset(dspPsdAccum,  0, sizeof(dspPsdAccum));
  // dspBgPsd ! ( PSD )
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
  // bgEnergy threshold ( )
  if (dspBgEnergy > 0) _sweepThreshold = dspBgEnergy;
}

// 1 loop()
void dspFeed(int16_t sample) {
  _segBuf[_segFill++] = sample;
  if (_segFill >= DSP_N) {
    _processSegment();
    memmove(_segBuf, _segBuf + DSP_STEP, DSP_OVERLAP * sizeof(int16_t));
    _segFill    = DSP_OVERLAP;
    dspSegCount = _segCount;
    dspLiveNewSeg = true;  // SSE

    //
    float segE = 0.0f;
    int binMin = dspBinMin();
    int binMax = dspBinMax();
    for (int k = binMin; k <= binMax; k++) {
      segE += _psdSum[k];
    }
    _lastSegEnergy = segE / (_segCount > 0 ? _segCount : 1);

    // v0.9: ( =0.3 )
    _energyEMA = (_segCount <= 1) ? _lastSegEnergy : _energyEMA * 0.7f + _lastSegEnergy * 0.3f;

    //
    bool hasBgThreshold = (_sweepThreshold > 0 && dspBgEnergy > 0);

    if (!hasBgThreshold && _segCount <= 5) {
      // bgEnergy 5 threshold
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
      // v0.9 : EMA
      // bgEnergy (5 )
      float triggerMult = hasBgThreshold ? 3.0f : 5.0f; // bgEnergy
      if (!_sweepActive) {
        if (_energyEMA > _sweepThreshold * triggerMult) {
          _hotSegs++;
          if (_hotSegs >= HOT_SEGS_REQUIRED) {
            _sweepActive = true;
            _quietSegs = 0;

            // v0.9 : PSD
            // bgPsd (seg 1-5 )
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

// (main.cpp )
// v0.9: sweep MIN_SWEEP_SEGS(3.2 )
bool dspSweepEnded() {
  return _sweepActive && _quietSegs >= QUIET_SEGS_LIMIT && _sweepActiveSegs >= MIN_SWEEP_SEGS;
}

//
bool dspSweepActive() {
  return _sweepActive;
}

// PSD API 1
// API ( )
void dspUpdateAccum() {
  if (_segCount == 0) return;
  for (int k = 0; k < DSP_NBINS; k++) {
    float mean = _psdSum[k] / _segCount;
    dspPsdAccum[k] = mean;
    // v0.9: = E[X ] - E[X] ( )
    float meanSq = _psdSumSq[k] / _segCount;
    dspPsdVar[k] = (meanSq > mean * mean) ? meanSq - mean * mean : 0.0f;
  }
}

// (Hz)
// power: (NULL )
//
// [ ]
// Hann spectral leakage 2.5Hz
// 5-bin (centroid) 0.05Hz
//
// centroid :
// bin 2 PSD
// f_peak = (f_k P_k) / (P_k)
// Hann
float dspFindPeak(float* power) {
  if (_segCount == 0) { if (power) *power = 0.0f; return 0.0f; }

  // v0.9: 18.75~150Hz (100~150Hz JS filterByBackground )
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

  // 2. 5-bin (centroid interpolation)
  // : peakBin 2 ( )
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

// ( )
// [Round 11 ] peakFreq
//
// : 90Hz+ 120Hz
// : +25Hz
// max(90Hz, peakHz+25Hz)
//
// [Round 12] DC
// peak=DSP_BIN_MIN bin[MIN] > 5 bin[MIN+1]
// 0.0 (SNR=0, valid=false)
float dspNoiseFloor() {
  if (_segCount == 0) return 0.0f;

  //
  float freqRes = dspFreqRes();
  int binMin = dspBinMin();
  int binMax = dspBinMax();
  int pkBin = binMin;
  for (int k = binMin + 1; k <= binMax; k++)
    if (dspPsdAccum[k] > dspPsdAccum[pkBin]) pkBin = k;

  // [Round 12] DC/
  // peak=DSP_BIN_MIN
  if (pkBin == binMin &&
      dspPsdAccum[binMin] > 5.0f * dspPsdAccum[binMin + 1]) {
    return 0.0f;  // SNR
  }

  // noiseFloor : max(90Hz, peakHz+25Hz)
  float peakHz = pkBin * freqRes;
  float nfStart = peakHz + 25.0f;
  if (nfStart < 90.0f)  nfStart = 90.0f;
  if (nfStart > 180.0f) nfStart = 90.0f;  // 90Hz

  int kMin = (int)(nfStart / freqRes);
  if (kMin < binMin)      kMin = binMin;
  if (kMin > binMax - 4)  kMin = binMax - 4;

  int n = binMax - kMin + 1;
  if (n <= 0 || n > DSP_NBINS) return 0.0f;
  float tmp[DSP_NBINS];
  for (int i = 0; i < n; i++) tmp[i] = dspPsdAccum[kMin + i];
  //
  for (int i = 1; i < n; i++) {
    float key = tmp[i]; int j = i - 1;
    while (j >= 0 && tmp[j] > key) { tmp[j+1] = tmp[j]; j--; }
    tmp[j+1] = key;
  }
  return tmp[n / 2];  //
}

// SNR (dB)
// : SNR > 10dB , < 10dB
float dspSNRdB(float peakPower, float noiseFloor) {
  if (noiseFloor < 1e-12f || peakPower < 1e-12f) return 0.0f;
  return 10.0f * log10f(peakPower / noiseFloor);
}

// SNR
// : > 15dB = , 10~15dB = , < 10dB =
inline float dspConfidence(float snrDb) {
  if (snrDb >= 15.0f) return 1.0f;
  if (snrDb >= 10.0f) return 0.5f + (snrDb - 10.0f) / 10.0f;
  return 0.0f;
}


//
// [Round 3 ]
// centroid
// prominence local maxima
//
// prominence = (peak_val - surrounding_min) / peak_val
// 0.2 local maxima
// : , 5
// : 1~2 + 1~2 + 1
// 4~5 Diagnostic
#define DSP_MAX_PEAKS 5

struct DspMultiPeak {
  float freq;        // Hz (centroid )
  float power;       // (m/s ) /Hz
  float prominence;  // 0~1 ( )
};

int dspFindPeaks(DspMultiPeak* peaks, float minProminence) {
  if (_segCount == 0) return 0;
  int count = 0;

  // v0.9:
  // 30% 5 5x
  int binMin = dspBinMin();
  int binMax = dspBinMax();
  float sortBuf[DSP_NBINS];
  int nBins = 0;
  for (int k = binMin; k <= binMax; k++) sortBuf[nBins++] = dspPsdAccum[k];
  // (59 bins )
  for (int i = 1; i < nBins; i++) {
    float key = sortBuf[i]; int j = i - 1;
    while (j >= 0 && sortBuf[j] > key) { sortBuf[j+1] = sortBuf[j]; j--; }
    sortBuf[j+1] = key;
  }
  float noiseFloor = sortBuf[(int)(nBins * 0.3f)];
  float absThreshold = noiseFloor * 5.0f;
  if (absThreshold < 50.0f) absThreshold = 50.0f;

  // local maxima
  float freqRes = dspFreqRes();
  for (int k = binMin + 1; k < binMax && count < DSP_MAX_PEAKS * 2; k++) {
    if (dspPsdAccum[k] <= absThreshold) continue;  // v0.9:
    if (dspPsdAccum[k] > dspPsdAccum[k-1] && dspPsdAccum[k] > dspPsdAccum[k+1]) {
      // prominence : 4bin
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
        // centroid
        int plo = (k-2 > binMin) ? k-2 : binMin;
        int phi = (k+2 < binMax) ? k+2 : binMax;
        float sw = 0.0f, sfw = 0.0f;
        for (int i = plo; i <= phi; i++) { sw += dspPsdAccum[i]; sfw += i*freqRes*dspPsdAccum[i]; }
        float freq = sw > 1e-12f ? sfw/sw : k*freqRes;
        //
        if (count < DSP_MAX_PEAKS) {
          peaks[count++] = {freq, dspPsdAccum[k], prom};
        }
      }
    }
  }
  // ( )
  for (int i = 1; i < count; i++) {
    DspMultiPeak key = peaks[i]; int j = i-1;
    while (j >= 0 && peaks[j].power < key.power) { peaks[j+1] = peaks[j]; j--; }
    peaks[j+1] = key;
  }
  return count;
}

//
// (Phase 2 )
// ( DSP_MAX_PEAKS )
struct DspPeak {
  float freq;        // Hz
  float power;       // (m/s ) /Hz
  float prominence;  //
  float bandwidth;   // -3dB
};

struct DspStatus {
  int     segCount;
  float   peakFreq;    // Hz
  float   peakPower;   // (m/s ) /Hz
  float   noiseFloor;
  float   snrDb;
  bool    valid;       // segCount >= 10 AND snrDb >= 10:
  bool    displayable; // segCount >= 3:
  float   confidence;  // 0.0~1.0: SNR
  DspMultiPeak peaks[DSP_MAX_PEAKS]; // ( 5 )
  int           peakCount;              //
};

DspStatus dspGetStatus() {
  dspUpdateAccum();  // [ 2] 1
  DspStatus s;
  s.segCount   = _segCount;
  s.displayable= (_segCount >= 3);
  s.peakFreq   = dspFindPeak(&s.peakPower);
  s.noiseFloor = dspNoiseFloor();
  s.snrDb      = dspSNRdB(s.peakPower, s.noiseFloor);
  s.confidence = dspConfidence(s.snrDb);
  s.valid      = (_segCount >= dspMinValidSegs) && (s.snrDb >= 6.0f);
  s.peakCount  = dspFindPeaks(s.peaks, 0.2f); //
  return s;
}

//
// v1.0 DSP Print & Measure
// X/Y , FFT, PSD
//
// v1.0.2 :
// - Welch: PSD
// ( = , / = )
// - DC :
// - :
// - X/Y :
// - SNR : /
//

//
static float _dualBufX[DSP_N];
static float _dualBufY[DSP_N];
static float _dualPsdSumX[DSP_NBINS];    // PSD
static float _dualPsdSumY[DSP_NBINS];
static float _dualPsdSqX[DSP_NBINS];     // PSD ( )
static float _dualPsdSqY[DSP_NBINS];
static float _dualWeightSum = 0.0f;       // (X/Y )
static int   _dualFill = 0;
static int      _dualSegActive = 0;          // ( >0)
static uint32_t _dualSegTotal = 0;  // R21.2: uint32 + INT_MAX clamp
static volatile bool dspDualNewSeg = false;
#define DUAL_MAX_TOTAL_SEGS 45000         // ~60 (float32 )
static bool  _dualMaxReached = false;

// DC
static float _dcX = 0.0f, _dcY = 0.0f;
static bool  _dcInit = false;

//
static float _dualEnergyEMA = 0.0f;       // EMA
static float _dualLastEnergyX = 0.0f;
static float _dualLastEnergyY = 0.0f;

// N
#define DUAL_PEAK_HISTORY 8
static float _peakHistX[DUAL_PEAK_HISTORY];
static float _peakHistY[DUAL_PEAK_HISTORY];
static int   _peakHistIdx = 0;
static int   _peakHistCount = 0;

// X/Y ( )
static float _corrSumXY = 0.0f;           // (psdX psdY)
static float _corrSumXX = 0.0f;           // (psdX )
static float _corrSumYY = 0.0f;           // (psdY )
static int   _corrCount = 0;

// PSD
float dspDualPsdX[DSP_NBINS];
float dspDualPsdY[DSP_NBINS];
float dspDualVarX[DSP_NBINS];
float dspDualVarY[DSP_NBINS];

//
// Phase 2: Jerk PSD (OMA EMA )
// jerk(t) = d/dt(accel(t)) a[n] - a[n-1]
// F(f) FFT(jerk), H(f) = X(f) / F(f)
// : 2 DSP_NBINS 4B 2(sum+public) = ~8KB
//
static float _dualJerkPsdSumX[DSP_NBINS];
static float _dualJerkPsdSumY[DSP_NBINS];
float dspJerkPsdX[DSP_NBINS];
float dspJerkPsdY[DSP_NBINS];
static bool  _jerkEnabled = true;   // (NVS/ )

// : float FFT PSD
//
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

// (RMS )
static float _calcSegEnergy(float* buf) {
  float e = 0;
  for (int i = 0; i < DSP_N; i++) e += buf[i] * buf[i];
  return e / DSP_N;
}

//
float dspDualFindPeak(float* psd, int segCount, float* outPower);

//
void dspFeedDual(float valX, float valY) {
  // DC tracker - time constant tied to sample rate so transient response is
  // consistent across rates. Previously alpha was a fixed 0.001, giving ~0.3s
  // at 3200Hz but 2.5s at 400Hz - the latter leaves significant DC leakage
  // in the low-frequency bins of the first few segments after a quiet->active
  // transition. Using ~0.3s nominal at any rate:
  //   alpha = 1 / (0.3 * fs)   i.e. ~0.001 at 3200Hz, ~0.008 at 400Hz.
  const float fs = dspGetSampleRate();
  const float dcAlpha = (fs > 1.0f) ? (1.0f / (0.3f * fs)) : 0.001f;
  const float dcOneM  = 1.0f - dcAlpha;
  if (!_dcInit) {
    _dcX = valX; _dcY = valY; _dcInit = true;
  } else {
    _dcX = _dcX * dcOneM + valX * dcAlpha;
    _dcY = _dcY * dcOneM + valY * dcAlpha;
  }

  _dualBufX[_dualFill] = valX - _dcX;
  _dualBufY[_dualFill] = valY - _dcY;
  _dualFill++;

  if (_dualFill >= DSP_N) {
    // R21.2: INT_MAX clamp - 45000
    if (_dualSegTotal < 0x7FFFFFFFu) _dualSegTotal++;

    // : float32
    // 45,000 (~60 )
    // ( )
    if (_dualSegTotal > 0 && (_dualSegTotal % DUAL_MAX_TOTAL_SEGS) == 0) {
      // Scale-preserving halving: every accumulator divided by weight sum below
      // must halve together, otherwise its normalised value jumps at the boundary.
      // The jerk PSD sums were missed in the original code, making the published
      // jerkPsdX/Y double after every ~60-second rollover.
      for (int k = 0; k < DSP_NBINS; k++) {
        _dualPsdSumX[k]      *= 0.5f; _dualPsdSumY[k]      *= 0.5f;
        _dualPsdSqX[k]       *= 0.5f; _dualPsdSqY[k]       *= 0.5f;
        _dualJerkPsdSumX[k]  *= 0.5f; _dualJerkPsdSumY[k]  *= 0.5f;
      }
      _dualWeightSum *= 0.5f;
      _dualMaxReached = true;
    }

    //
    float eX = _calcSegEnergy(_dualBufX);
    float eY = _calcSegEnergy(_dualBufY);
    float eSum = eX + eY;
    _dualLastEnergyX = eX;
    _dualLastEnergyY = eY;

    // Energy EMA with sample-rate-aware alpha so the smoothing time constant
    // is ~2.6 s of real time at every rate. Previously alpha was a fixed 0.03
    // per segment, which is 2.6 s at 3200Hz but 21 s at 400Hz - the latter
    // makes the adaptive-weight logic nearly static. alpha = dt / tau where
    // dt = DSP_STEP / fs (seconds between segments) and tau = 2.6 s.
    if (_dualSegTotal <= 3) {
      _dualEnergyEMA = eSum;
    } else {
      float fsLocal = dspGetSampleRate();
      float dt = (fsLocal > 1.0f) ? ((float)DSP_STEP / fsLocal) : 0.08f;
      float eAlpha = dt / 2.6f;
      if (eAlpha > 0.5f) eAlpha = 0.5f;   // safety cap at very low fs
      if (eAlpha < 0.001f) eAlpha = 0.001f;
      _dualEnergyEMA = _dualEnergyEMA * (1.0f - eAlpha) + eSum * eAlpha;
    }

    //
    // w = max(0, E - Ebg) / Ebg
    // / : w 0 ( ) PSD
    // : w >> 1 PSD
    float bgE = (_dualEnergyEMA > 1e-15f) ? _dualEnergyEMA : 1e-15f;
    float weight = (eSum - bgE) / bgE;
    if (weight < 0.0f) weight = 0.0f;
    if (weight > 100.0f) weight = 100.0f;  //
    // : ( )
    weight += 0.01f;

    // FFT + PSD
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

    // Phase 2: Jerk PSD ( F(f) )
    // jerk[i] = acc[i] - acc[i-1] (first-difference)
    // jerk buffer (in-place)
    if (_jerkEnabled) {
      static float _tmpJerk[DSP_N];
      // X jerk
      _tmpJerk[0] = _dualBufX[0];  // ( )
      for (int i = 1; i < DSP_N; i++) _tmpJerk[i] = _dualBufX[i] - _dualBufX[i-1];
      _processDualSeg(_tmpJerk, _tmpPsd);
      for (int k = 0; k < DSP_NBINS; k++) _dualJerkPsdSumX[k] += _tmpPsd[k] * weight;
      // Y jerk
      _tmpJerk[0] = _dualBufY[0];
      for (int i = 1; i < DSP_N; i++) _tmpJerk[i] = _dualBufY[i] - _dualBufY[i-1];
      _processDualSeg(_tmpJerk, _tmpPsd);
      for (int k = 0; k < DSP_NBINS; k++) _dualJerkPsdSumY[k] += _tmpPsd[k] * weight;
    }

    _dualWeightSum += weight;
    if (weight > 0.1f) _dualSegActive++;

    // (PSD )
    // X/Y PSD
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

    // ( 10 )
    if (_dualSegTotal % 10 == 0 && _dualWeightSum > 0.1f) {
      // PSD
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

    // 75%
    memmove(_dualBufX, _dualBufX + DSP_STEP, DSP_OVERLAP * sizeof(float));
    memmove(_dualBufY, _dualBufY + DSP_STEP, DSP_OVERLAP * sizeof(float));
    _dualFill = DSP_OVERLAP;
    dspDualNewSeg = true;
  }
}

//
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

// PSD
void dspUpdateDual() {
  if (_dualWeightSum < 1e-12f) return;
  for (int k = 0; k < DSP_NBINS; k++) {
    float meanX = _dualPsdSumX[k] / _dualWeightSum;
    float meanY = _dualPsdSumY[k] / _dualWeightSum;
    // R70: NaN/Inf sanity check - 0 (JSON "null" )
    if (!isfinite(meanX)) { meanX = 0; _dualPsdSumX[k] = 0; }
    if (!isfinite(meanY)) { meanY = 0; _dualPsdSumY[k] = 0; }
    dspDualPsdX[k] = meanX;
    dspDualPsdY[k] = meanY;
    float msqX = _dualPsdSqX[k] / _dualWeightSum;
    float msqY = _dualPsdSqY[k] / _dualWeightSum;
    if (!isfinite(msqX)) msqX = 0;
    if (!isfinite(msqY)) msqY = 0;
    dspDualVarX[k] = (msqX > meanX*meanX) ? msqX - meanX*meanX : 0.0f;
    dspDualVarY[k] = (msqY > meanY*meanY) ? msqY - meanY*meanY : 0.0f;
    // Phase 2: Jerk PSD
    float jx = _dualJerkPsdSumX[k] / _dualWeightSum;
    float jy = _dualJerkPsdSumY[k] / _dualWeightSum;
    dspJerkPsdX[k] = isfinite(jx) ? jx : 0;
    dspJerkPsdY[k] = isfinite(jy) ? jy : 0;
  }
}

// Phase 2: Jerk
// : 0.0~1.0 (1.0 = , 0.0 = / )
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
  // Spectral flatness : mean / max ( 1 )
  float meanV = total / n;
  return meanV / maxV;
}

//
int dspDualSegCountX()  { return _dualSegActive; }
int dspDualSegCountY()  { return _dualSegActive; }
int dspDualSegTotal()   { return (int)(_dualSegTotal < 0x7FFFFFFFu ? _dualSegTotal : 0x7FFFFFFFu); }
float dspDualGateRatio(){ return _dualSegTotal>0 ? (float)_dualSegActive/_dualSegTotal : 0; }

// X/Y (0= , 1= )
float dspDualCorrelation() {
  if (_corrSumXX < 1e-15f || _corrSumYY < 1e-15f) return 0;
  return _corrSumXY / sqrtf(_corrSumXX * _corrSumYY);
}

// : N (Hz)
//
float dspDualConvergence(char axis) {
  if (_peakHistCount < 3) return 999.0f;
  float* hist = (axis == 'x') ? _peakHistX : _peakHistY;
  int n = _peakHistCount;
  // R49: Welford's online variance + min/max range float
  float maxV = hist[0], minV = hist[0];
  for (int i = 1; i < n; i++) {
    if (hist[i] > maxV) maxV = hist[i];
    if (hist[i] < minV) minV = hist[i];
  }
  float range = maxV - minV;
  // 0.01Hz (float )
  if (range < 0.01f) return 0.0f;
  // std - range numerical instability
  float sum = 0;
  for (int i = 0; i < n; i++) sum += hist[i];
  float mean = sum / n;
  float sumSqDev = 0;
  for (int i = 0; i < n; i++) { float d = hist[i] - mean; sumSqDev += d * d; }
  float var = sumSqDev / n;
  return (var > 0) ? sqrtf(var) : 0;
}

// : < 1Hz AND
// : + 200
bool dspDualAutoReady() {
  return _dualSegActive >= 200
      && _peakHistCount >= 4
      && dspDualConvergence('x') < 1.0f
      && dspDualConvergence('y') < 1.0f;
}
bool dspDualMaxReached() { return _dualMaxReached; }

//
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
  // centroid
  int lo = (pkBin-2 > binMin) ? pkBin-2 : binMin;
  int hi = (pkBin+2 < binMax) ? pkBin+2 : binMax;
  float sw=0, sfw=0;
  for (int k=lo; k<=hi; k++) { sw += psd[k]; sfw += k*freqRes*psd[k]; }
  return sw > 1e-12f ? sfw/sw : pkBin*freqRes;
}
