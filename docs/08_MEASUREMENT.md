# 08. 측정 플로우

## 캘리브레이션 (1회, 30초)
```
1. 사용자: [📐 Calibrate] 클릭
2. "X축 방향으로 프린터를 움직여주세요"
   → ADXL raw 데이터 수집 (calMinSegs=100 세그먼트)
   → 주성분 분석: 에너지가 가장 큰 방향 = X축 벡터
   → calWx = 정규화된 방향 벡터
3. "Y축 방향으로 프린터를 움직여주세요"
   → 같은 방식으로 Y축 벡터 추출
   → Gram-Schmidt 직교 보정
   → calWy = X에 직교하는 방향
4. [💾 Save] → NVS 저장, useCalWeights = true
```

## 배경 PSD (자동)
```
부팅 후 ADXL OK → 비동기 배경 캡처 (10세그)
→ dspBgPsd[59] → NVS (femto_bg, 236B)
→ JS filterByBackground()에서 차감용
```

## Print Measure (측정)
```
1. [▶ 측정 시작] → POST /api/measure {"cmd":"print_start"}
   → useCalWeights 확인 (없으면 에러)
   → measState = MEAS_PRINT, dspResetDual()
   → UI: pmIdle→pmRunning 전환

2. 사용자: 아무 모델 출력 시작 (별도 조작 없음)

3. [ESP32 loop] 연속 처리
   ADXL FIFO → 벡터 투영 → dspFeedDual
   → FFT → PSD → 에너지 게이트 → 가중 누적

4. [JS 폴링] 2초 간격 GET /api/measure/status
   → 프로그레스바, 세그먼트 카운트
   → autoReady 감지 → 알림

5. [⏹ 측정 완료] → POST {"cmd":"print_stop"}
   → ESP32: measPsdX/Y 백업 + NVS
   → JS: GET /api/psd?mode=print
   → 분석 파이프라인 실행
   → UI: pmRunning→resultSection 전환
```

## 분석 파이프라인 (JS, <100ms)
```
PSD 59빈 (X/Y 독립)
  → filterByBackground: 배경 차감 + max(적응형, 0.01) floor
  → filterFanPeaks: 팬 PSD 빈별 차감 (있으면)
  → detectPeaks: prominence 피크 검출 (최대 8개)
    → 하모닉 최소오차 매칭
    → 키네마틱별 zone 분류
    → Lorentzian sub-bin 정밀도
  → analyzeShaper: 5종 쉐이퍼 × 주파수 스윕
    → practical 메트릭
  → validateResult: 2계층 판정 + 경고
  → updateShaperUI: 차트 + 테이블 + 추천
  → updateDiagOverview: 진단 카드
```

## 자동 완료 조건
```
dspDualAutoReady():
  activeSegs ≥ 200 (pmMinSegs)
  AND convergenceX < pmConvX (기본 1.0Hz)
  AND convergenceY < pmConvY (기본 1.0Hz)
→ JS에서 autoReady 감지 → 사용자에게 알림
```
