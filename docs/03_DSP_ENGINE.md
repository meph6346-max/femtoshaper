# 03. DSP 엔진 (dsp.h)

## 개요
769줄. ESP32에서 실시간 FFT + PSD 계산. 듀얼 X/Y 독립 축적, 에너지 게이트, 배경 PSD, 교차 상관, 수렴 추적.

## 핵심 파라미터
```c
#define DSP_N        1024      // FFT 크기
#define DSP_OVERLAP  768       // 75% 오버랩
#define DSP_STEP     256       // 1세그먼트 = 256샘플 = 80ms
#define DSP_FS       3200.0f   // 샘플레이트
#define DSP_FRES     3.125f    // 주파수 해상도 (Hz/bin)
#define DSP_NBINS    513       // FFT 출력 빈 수
#define DSP_FMIN     18.75f    // 관심 최저 주파수 (bin 6)
#define DSP_FMAX     200.0f    // 관심 최고 주파수 (bin 64)
// 유효 빈 수 = 64 - 6 + 1 = 59
```

## 처리 흐름
```
ADXL345 raw (3축 int16)
  ↓ 벡터 투영: projX = calWx·sensor
  ↓
dspFeedDual(projX, projY)
  ↓ DC 제거: IIR α=0.001 (dc = dc×0.999 + val×0.001)
  ↓ 1024샘플 버퍼 채움
  ↓ 버퍼 full → 1세그먼트 완료
  ↓
  ├─ 세그먼트 에너지 계산: eX = Σ|x|², eY = Σ|y|²
  ├─ 배경 에너지 EMA: bgE = bgE×0.97 + e×0.03
  ├─ 가중치: weight = (e - bgE) / bgE
  │   가감속: weight >> 1 (강하게 기여)
  │   등속:   weight ≈ 0 (약하게 기여)
  │
  ├─ Hanning 윈도우 적용
  ├─ 1024-pt FFT (Cooley-Tukey radix-2, float32, in-place)
  ├─ PSD = |FFT|² / (fs × N)
  ├─ 가중 누적: psdSum[k] += weight × psd[k]
  ├─ 분산 누적: psdSqSum[k] += weight × psd²[k]
  │
  ├─ X/Y 교차 상관 업데이트
  ├─ 피크 히스토리 업데이트 (수렴 추적)
  │
  └─ 75% 오버랩: 버퍼 뒤 768샘플 보존 → 앞으로 이동
```

## 에너지 게이트 — 핵심 메커니즘
```
3D프린터 출력 중 시간 구성:
  가속 │ 등속 │ 감속 │ 가속 │ 등속 │ 감속
  ████ │░░░░░│ ████ │ ████ │░░░░░│ ████
  진동! │조용 │진동! │진동! │조용 │진동!

등속: 진동 없음 → PSD에 노이즈만
가감속: 충격 → 공진 여기 → PSD에 피크

게이트 없으면: 등속 노이즈가 피크 희석
게이트 있으면: 가감속만 강하게 기여

구현: 이진 게이트가 아닌 연속 가중치
  weight = max(0, (segEnergy - bgEnergy) / bgEnergy)
  → 가감속은 자연스럽게 높은 가중치
  → 등속도 미량 기여 (완전 무시보다 안정)
```

## 배경 PSD
```
부팅 후 첫 5세그 (프린터 정지 상태):
  → 환경 노이즈 PSD 캡처
  → dspBgPsd[59] (18.75~200Hz)
  → NVS 저장 (femto_bg, 236B)
  → JS filterByBackground()에서 차감
```

## 듀얼 DSP — X/Y 독립
```
캘리브레이션 벡터 투영:
  printerX = calWx[0]·sensorX + calWx[1]·sensorY + calWx[2]·sensorZ
  printerY = calWy[0]·sensorX + calWy[1]·sensorY + calWy[2]·sensorZ

dspFeedDual(projX, projY):
  → X/Y 독립 FFT + PSD + 가중 누적
  → dspDualPsdX[513], dspDualPsdY[513]
  → dspDualVarX[513], dspDualVarY[513]
```

## 교차 상관
```
dspDualCorrelation():
  corr = ΣXY / √(ΣXX × ΣYY)
  0 = 완벽 분리 (좋음)
  1 = X/Y 동일 (분리 실패)
  > 0.8이면 경고 (캘리브레이션 불량)
```

## 수렴 추적
```
dspDualConvergence(axis):
  최근 N회 피크 주파수의 표준편차
  < 1.0Hz → 수렴 완료 (안정)
  > 5.0Hz → 아직 수렴 안 됨

autoReady: activeSegs ≥ 200 && convergence OK
```

## 롤링 리셋 (라이브 모드)
```
30세그마다 dspResetDual()
→ PSD 신선도 유지 (2.4초 윈도우)
→ 라이브에서 현재 진동만 반영

측정 모드에서는 리셋 없음 → 전체 출력 누적
```

## 오버플로우 보호
```
45,000세그(~60분) 도달 시:
  psdSum *= 0.5, psdSqSum *= 0.5, weightSum *= 0.5
  → 최근 데이터 상대적 가중 ↑
  → float32 정밀도 유지
```

## 주요 함수
| 함수 | 설명 |
|------|------|
| `dspFeedDual(valX, valY)` | 샘플 입력 + FFT + PSD 누적 |
| `dspUpdateDual()` | 가중 평균 계산 → dspDualPsdX/Y |
| `dspResetDual()` | 누적 초기화 (라이브 리셋) |
| `dspDualFindPeak(psd, segs, &power)` | PSD 피크 주파수 |
| `dspDualCorrelation()` | X/Y 교차 상관 |
| `dspDualConvergence(axis)` | 피크 수렴도 (Hz) |
| `dspDualGateRatio()` | 유효 세그먼트 비율 |
| `dspDualAutoReady()` | 자동 완료 조건 충족? |
| `dspReset()` | 단일 PSD 리셋 |

## RAM 사용
```
FFT 버퍼: 1024×4B×2축 = 8KB
PSD 누적: 513×4B×4배열 = 8KB
히스토리: 20×4B×2축 = 160B
합계: ~18KB / 400KB (4.5%)
```
