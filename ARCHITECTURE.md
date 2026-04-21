# FEMTO SHAPER v1.0 — 아키텍처 & 개발 목적 상세

---

## 1. 개발 목적

### 1-1. 문제 정의

3D프린터는 고속 출력 시 **고스팅**(ringing, ghosting)이 발생한다. 이는 프린터 기계 구조의 **고유 공진 주파수**에서 진동이 증폭되기 때문이다. 인풋쉐이퍼(Input Shaper)는 이 공진을 상쇄하는 디지털 필터를 모터 제어에 삽입하여 고스팅을 제거한다.

**인풋쉐이퍼 적용을 위해서는 프린터의 공진 주파수를 정확히 측정해야 한다.**

### 1-2. 기존 솔루션의 한계

| 기존 방법 | 한계 |
|-----------|------|
| Klipper ShakeTune | Klipper 전용. G-code chirp 스윕 필요. Marlin/RRF 불가 |
| Klipper ADXL (내장) | Klipper 전용. SPI 직접 연결 필요 (프린터 보드 배선) |
| ADXL345 + Raspberry Pi | RPi 필요 ($35+). 설정 복잡. 비전문가 진입장벽 높음 |
| 수동 튜닝 | 테스트큐브 반복 출력. 시간 낭비. 정확도 낮음 |

### 1-3. FEMTO SHAPER의 해결책

```
Zero Coupling (전기적 연결 없음)
  → 프린터 보드에 선 하나 안 꽂는다
  → 센서를 프린터 헤드에 붙이고, USB-C로 전원만 공급
  → WiFi로 결과 확인

펌웨어 무관
  → Marlin, Klipper, RepRapFirmware 전부 지원
  → Apply G-code 4종 자동 생성

$3 BOM
  → ESP32-C3 SuperMini ($1.5) + ADXL345 ($1.5)
  → 기존 솔루션의 1/10 이하 비용

"붙이고 출력하면 끝"
  → 센서 부착 → 캘리브레이션 (30초) → 아무 모델 출력 → 결과 확인
  → G-code 스윕 불필요. 일반 출력 중 측정
```

### 1-4. 핵심 혁신: Print Measure

기존 방식은 **제어된 chirp 스윕** (주파수를 선형 증가시키는 특수 이동)으로 측정한다. FEMTO는 **일반 출력 중 가감속 충격파**를 이용한다.

```
프린터가 코너를 돌 때:
  300mm/s → 감속 → 정지 → 가속 → 300mm/s (새 방향)
  
  감속 종료 순간: 힘이 0으로 급변 → 구조물 자유진동 발생
  = 임펄스 응답 → 고유 주파수에서 진동
  = ADXL345이 감지 → FFT → PSD → 공진 주파수 추출
```

**장점:** 출력을 중단하지 않아도 됨. 실사용 조건에서 측정.
**단점:** 여기(excitation) 품질이 모델(인필 패턴, 속도, 크기)에 의존.

---

## 2. 시스템 아키텍처

### 2-1. 블록 다이어그램

```
┌──────────────────────────────────────────────────────────────┐
│  브라우저 (모바일/PC)                                          │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ index.html — 4탭 SPA                                   │  │
│  │                                                        │  │
│  │ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │  │
│  │ │ 쉐이퍼   │ │ 진단     │ │ 라이브   │ │ 설정      │  │  │
│  │ │ (측정+   │ │ (텍스트  │ │ (청진기  │ │ (NVS+     │  │  │
│  │ │  분석+   │ │  기반    │ │  실시간  │ │  캘리     │  │  │
│  │ │  추천)   │ │  진단)   │ │  FFT)    │ │  브레이션)│  │  │
│  │ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬──────┘  │  │
│  │      │            │            │             │          │  │
│  │ ┌────▼────────────▼────────────▼─────────────▼────────┐│  │
│  │ │ JS 모듈 (15개)                                       ││  │
│  │ │ shaper.js ← filter.js ← charts.js ← validator.js   ││  │
│  │ │ diagnostic.js ← kinematics.js ← i18n.js            ││  │
│  │ │ settings.js ← measure.js ← live.js ← app.js        ││  │
│  │ └────────────────────┬────────────────────────────────┘│  │
│  └──────────────────────│────────────────────────────────┘│  │
└─────────────────────────│────────────────────────────────┘   │
                          │ HTTP REST (JSON) + SSE              │
┌─────────────────────────│────────────────────────────────────┐
│  ESP32-C3 SuperMini     │                                     │
│  ┌──────────────────────▼──────────────────────────────────┐ │
│  │ WebServer (port 80)                                      │ │
│  │  ├─ LittleFS: 15 JS + HTML + CSS + Chart.js (서빙)      │ │
│  │  ├─ REST API: 25개 엔드포인트 (JSON)                     │ │
│  │  ├─ SSE: 라이브 스펙트럼 스트림                           │ │
│  │  └─ 캡티브 포털: AP 모드 자동 리다이렉트                   │ │
│  └─────────────────────────────────┬───────────────────────┘ │
│  ┌─────────────────────────────────▼───────────────────────┐ │
│  │ 상태머신 (MEAS_IDLE → MEAS_PRINT → MEAS_DONE)           │ │
│  │  ├─ IDLE+live: 롤링 PSD (30세그 리셋, 6fps SSE)         │ │
│  │  ├─ PRINT: 누적 PSD (가감속 가중치, 리셋 없음)            │ │
│  │  └─ DONE: PSD 백업 → measPsdX/Y → NVS                  │ │
│  └─────────────────────────────────┬───────────────────────┘ │
│  ┌─────────────────────────────────▼───────────────────────┐ │
│  │ DSP 엔진 (dsp.h, 769줄)                                  │ │
│  │  ├─ DC 제거: IIR α=0.001                                │ │
│  │  ├─ 윈도우: Hanning 1024-pt                              │ │
│  │  ├─ FFT: Cooley-Tukey radix-2 (float32, in-place)       │ │
│  │  ├─ PSD: |FFT|²/(fs×N), 세그먼트 가중 평균 + 분산        │ │
│  │  ├─ 듀얼 투영: calWx·sensor → printerX, calWy → Y       │ │
│  │  ├─ 에너지 게이트: 가감속 세그먼트 고가중, 등속 저가중      │ │
│  │  ├─ X/Y 교차 상관: 분리 품질 실시간 모니터링               │ │
│  │  ├─ 피크 수렴: 누적 피크 주파수 표준편차 추적              │ │
│  │  └─ 배경 PSD: 첫 5세그 = 정지 배경 캡처                  │ │
│  └─────────────────────────────────┬───────────────────────┘ │
│  ┌─────────────────────────────────▼───────────────────────┐ │
│  │ ADXL345 드라이버                                          │ │
│  │  ├─ SPI 5MHz, Mode 3, FIFO Stream (32샘플 배치)          │ │
│  │  ├─ ±16g 범위, 3200Hz 샘플레이트                         │ │
│  │  └─ 폴링 방식 (인터럽트 미사용, ESP32-C3 GPIO 제약)       │ │
│  └───────────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ NVS (6개 네임스페이스, ~2KB/32KB 사용)                    │ │
│  │  femto: 설정 | femto_res: 결과 | femto_bg: 배경PSD      │ │
│  │  femto_mpsd: 측정PSD백업 | femto_belt | femto_diag      │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### 2-2. 데이터 흐름 — 측정 전체 과정

```
사용자: 센서 부착 → 캘리브레이션 → 출력 시작 → 측정 버튼

Phase 1: 캘리브레이션 (30초, 1회)
  "X축 방향으로 프린터를 움직여주세요"
   → ADXL raw 수집 → 주성분(에너지 방향) 추출
   → calWx = [0.71, 0.71, 0]
  "Y축 방향으로 프린터를 움직여주세요"
   → 직교 보정 → calWy = [-0.71, 0.71, 0]
   → NVS 저장, useCalWeights = true

Phase 2: 배경 PSD 캡처 (자동, 0.4초)
  프린터 정지 상태 첫 5세그 → dspBgPsd[59] → NVS 저장

Phase 3: Print Measure (출력 중, 1~5분)
  POST /api/measure {"cmd":"print_start"}
  → measState = MEAS_PRINT, dspResetDual()
  
  [ESP32 loop — 연속]
   ADXL FIFO 폴링 (20ms) → raw x,y,z
   → 벡터 투영: projX = calWx·sensor, projY = calWy·sensor
   → dspFeedDual(projX, projY):
     DC 제거 → 1024버퍼 → FFT → PSD
     → 에너지 게이트 (가감속=고가중, 등속=저가중)
     → X/Y 독립 PSD 가중 평균 누적
     → 교차 상관 + 수렴 추적
  
  [JS 폴링 — 2초 주기]
   GET /api/measure/status
   → 프로그레스바, autoReady 감지

Phase 4: 분석 (JS, <100ms)
  POST {"cmd":"print_stop"}
  → ESP32: measPsdX/Y 백업 + NVS
  GET /api/psd?mode=print
  → JS 파이프라인:
    filterByBackground → filterFanPeaks → detectPeaks
    → analyzeShaper (5종×스윕) → validateResult → UI
```

### 2-3. 에너지 게이트 — 왜 필요한가

```
3D프린터 출력 중:
  가감속 구간: 충격 → 공진 여기 → PSD에 피크
  등속 구간:   진동 없음 → PSD에 노이즈만

게이트 없으면: 등속 노이즈가 피크를 희석
게이트 있으면: 가감속만 강하게 기여

구현: weight = (segEnergy - bgEnergy) / bgEnergy
  가감속: weight >> 1  → PSD 기여↑
  등속:   weight ≈ 0   → PSD 기여↓

gateRatio = 유효세그먼트 / 전체
  ≥20%: 양호 | <3%: RETRY
```

### 2-4. X/Y 분리 — 벡터 투영

```
ADXL345 출력: 센서 좌표계 (sX, sY, sZ)
센서가 비스듬히 부착 → sX ≠ printerX

투영:
  printerX = calWx[0]·sX + calWx[1]·sY + calWx[2]·sZ
  printerY = calWy[0]·sX + calWy[1]·sY + calWy[2]·sZ

dspFeedDual()에서 실시간 수행 → X/Y PSD 독립 축적
```

### 2-5. 쉐이퍼 엔진 — Klipper 포팅

```
원본: Klipper shaper_calibrate.py (Python, GPL v3)
포팅: shaper.js (JavaScript, GPL v3 전파)

1. 쉐이퍼 전달함수 H(f) (ZV/MZV/EI/2HUMP/3HUMP)
2. 잔류 진동: vibrRatio = Σ PSD·|H|² / Σ PSD
   worst-case ζ = [0.075, 0.1, 0.15]
3. 스무딩: calcSmoothing(shaper, accel, scv)
4. 점수: score = smoothing × (vibr^1.5 + vibr×0.2 + 0.01)
5. 최적 선택: vibr 최소 근처에서 score 최소
6. maxAccel: smoothing(accel) ≤ targetSm 이분법
```

---

## 3. 라이브 = 청진기

```
설계 철학:
  모든 주파수를 보여준다 (배경 차감 안 함, 0.01 floor만)
  판단은 사용자가 한다
  추천/경고/진단 없음

시각 신호:
  히트 색상: hitMap × 0.985 감쇠, 파랑→초록→노랑→주황
  피크 홀드: peakHold × 0.97 감쇠 (2초 반감기, 점선)
  상태 라인: 5초마다 상위 3빈 "📍 44Hz · 87Hz"
```

---

## 4. 진단 시스템

```
원칙: "확진 아닌 방향 제시"
키네마틱별 맥락:
  CoreXY: X/Y 차이 → A/B 벨트 텐션
  Cartesian: Y 저주파 → 베드 질량 (정상)
  Delta: 벨트/캐리지 N/A

종합 아이콘: 🟢양호 / 🟡주의 / 🔵공진없음
피크별 카드: zone + 맥락 + 💡액션
```

---

## 5. 판정 엔진

```
Layer 1 — 측정 품질: calibration, gateRatio, correlation, convergence
Layer 2 — 결과 신뢰도: SNR, confidence, peaks, maxAccel
경고: accel_limit, smoothing_exceed, speed_unreachable, low_excitation
판정: APPLY / REVIEW / RETRY
```

---

## 6. practical 메트릭

```
accelHeadroom = maxAccel / userAccel
userSmoothing = calcSmoothing(shaper, userAccel)
accelDist = feed² / (2×accel)
accelRatio = min(1, 2×accelDist/buildMin)
maxReachSpeed = √(accel × buildMin)

추천 범위:
  accelMin = max(1000, maxAccel×50%)
  accelMax = maxAccel
  speedMin = √(0.2 × accelMin × buildMin)
  speedMax = min(√(0.4×accelMax×buildMin), maxReachSpeed)

상태: headroom(≥1.5) / tight(1.0~1.5) / over(<1.0) / retry(<2000)
```

---

## 7. PSD 백업

```
문제: 라이브 시작 → dspDualPsdX/Y 오염 → 측정 차트 소멸
해결: print_stop → measPsdX/Y[59] 독립 복사 → NVS 944B
      /api/psd?mode=print → 백업 반환
      부팅 → NVS 복원
```

---

## 8. 설계 결정 기록 (ADR)

| 결정 | 이유 | 대안 |
|------|------|------|
| G-code 스윕 삭제 | Zero Coupling. 사용자가 G-code 만들 필요 없어야 | chirp 유지 → Klipper 전용 |
| 1024-pt FFT | 3.125Hz 해상도. ESP32-C3 RAM 한계 | 2048-pt → RAM 부족 |
| 에너지 게이트 (가중치) | 등속도 미량 기여 → 이진보다 안정 | 이진 게이트 → 경계 불안정 |
| PSD 백업 배열 | 라이브 오염 방지 | NVS만 → 재부팅 전 복원 불가 |
| 피크 검출 1곳 | 다중 경로 → 불일치 버그 | 탭별 독립 → 결과 불일치 |
| JS에서 분석 | ESP32 RAM으로 5종 스윕 불가 | ESP32 분석 → RAM 부족 |
| Catmull-Rom 보간 | 3.125→0.5Hz. 정밀도 6배 | 선형 → 피크 오차 |
| 하모닉 최소오차 | first-match → 오분류 | break → 120Hz를 42Hz의 3차로 잘못 분류 |
| 라이브 필터 없음 | 청진기 = 모든 소리 들려야 | 배경 차감 → 원인 추적 불가 |
| mDNS STA 전용 | AP에서 DNS서버가 전 도메인 가로챔 | AP mDNS → 충돌 |
| 2세그 SSE | 1세그=12fps → ESP32 WiFi 버벅 | cfg.liveSegs 변수화 |
| NVS 2KB 제한 | 18KB 이상 → WiFi 불안정 실경험 | 무제한 → 불안정 |
