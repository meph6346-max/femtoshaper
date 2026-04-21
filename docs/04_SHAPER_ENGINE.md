# 04. 쉐이퍼 계산 엔진 (shaper.js)

## 개요
988줄. Klipper `shaper_calibrate.py` (Python, GPL v3) → JavaScript 직접 포팅. 5종 쉐이퍼 전달함수 계산, PSD 기반 잔류 진동 평가, maxAccel/smoothing 산출.

## GPL v3 라이센스
shaper.js는 Klipper GPL v3 코드의 파생물. **통합 프로젝트도 GPL v3를 따르거나, shaper.js를 별도 프로세스로 분리해야 함.**

## 쉐이퍼 5종
| 이름 | 펄스 수 | K 계산 | 특성 |
|------|---------|--------|------|
| ZV | 2 | K=exp(-ζπ/√(1-ζ²)) | 최소 스무딩, 낮은 억제 |
| MZV | 3 | K=exp(-0.75ζπ/√(1-ζ²)) | 균형 (기본 추천) |
| EI | 3 | K=exp(-ζπ/√(1-ζ²)) | 안정적 |
| 2HUMP_EI | 4 | 위와 동일 | 높은 억제 |
| 3HUMP_EI | 5 | 위와 동일 | 최대 억제, 최대 스무딩 |

## 계산 단계
```
1. PSD Catmull-Rom 보간
   3.125Hz → 0.5Hz 해상도 (정밀도 6배)

2. 주파수 스윕 (0.2Hz 스텝)
   각 (freq, shaper)에서:
     shaperDef = getShaperDefs(freq, damping)
     vibrRatio = calcVibrationRemaining(psd, shaper)
       → worst-case ζ = [0.075, 0.1, 0.15]
     smoothing = calcSmoothing(shaper, 5000, scv)
     score = smoothing × (vibr^1.5 + vibr×0.2 + 0.01)

3. 최적 주파수 선택 (Klipper fit_shaper)
   vibr 최소(bestRes) → bestRes.vibr×1.1+0.0005 이내에서 score 최소

4. maxAccel 이분법
   smoothing(shaper, accel) ≤ targetSmoothing
   → 조건 만족하는 최대 accel

5. practical 메트릭 (사용자 설정 기반)
   → 추천 가속도/속도 범위
```

## 핵심 함수
```javascript
analyzeShaper(psdData, peakFreq, damping, peaks) → {
  shapers: [{name,freq,vibrPct,maxAccel,smoothing}×5],
  recommended: {performance, lowVibration, safe, best},
  practical: {userAccel, userFeed, rec:{accelMin,accelMax,speedMin,speedMax,status}},
  confidence, dampingRatio, snrDb, resonanceMode, ...
}

getShaperDefs(freq, damping) → [{name, A:[coeffs], T:[times]}×5]
calcVibrationRemaining(psd, shaper) → float (0~1)
calcSmoothing(shaper, accel, scv) → float (mm)
calcMaxAccel(shaper, scv) → float (mm/s²)
fitLorentzian(psd, peakIdx) → {f0, amplitude, gamma, damping, rSquared}
estimateDampingRatio(psd, peakFreq) → float
```

## 설정 연동
| 설정 | getter | 용도 |
|------|--------|------|
| scv (5.0) | getCfgScv() | smoothing offset 계산 |
| damping (0.1) | getCfgDamping() | 쉐이퍼 계수 K 생성 |
| targetSm (0.12) | getCfgTargetSm() | maxAccel 이분법 기준 |
| accel (5000) | getCfgAccel() | practical.userSmoothing |
| feedrate (300) | getCfgFeedrate() | practical.accelDist |
| buildX/Y | getCfgBuildX/Y() | practical.maxReachSpeed |

## practical 메트릭
```
userSmoothing = calcSmoothing(shaper, userAccel, scv)  // 실제 스무딩
accelHeadroom = maxAccel / userAccel                    // 가속 여유 (>1 좋음)
accelDist = feed² / (2×accel)                           // 속도 도달 거리
accelRatio = min(1, 2×accelDist/buildMin)               // 가감속 비율
maxReachSpeed = √(accel×buildMin)                       // 베드 최고속
measExcitation = accelRatio>0.15?'good':>0.05?'fair':'poor'

rec (추천 범위):
  accelMin = max(1000, maxAccel×50%)
  accelMax = maxAccel
  speedMin = √(0.2×accelMin×buildMin)
  speedMax = min(√(0.4×accelMax×buildMin), maxReachSpeed)
  status: headroom(≥1.5) / tight(1~1.5) / over(<1) / retry(<2000)
```
