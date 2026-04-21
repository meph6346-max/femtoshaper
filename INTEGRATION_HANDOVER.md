# FEMTO SHAPER v1.0 — 통합 인수인계 서류

**프로젝트:** 3D프린터 독립형 진동 분석기 (인풋쉐이퍼 캘리브레이션)
**하드웨어:** ESP32-C3 SuperMini + ADXL345 (BOM $3)
**목적:** TinyBee ESP32 Web UI 통합을 위한 기술 문서
**버전:** v1.0 (2026-04-15)
**코드베이스:** 8,231줄 + Chart.js 201KB

---

## 1. 아키텍처 개요

```
┌─────────────────────────────────────────────────┐
│  브라우저 (모바일/PC)                             │
│  ┌──────────────────────────────────────────┐    │
│  │  index.html + 15개 JS 모듈 + CSS         │    │
│  │  Chart.js (바/라인 차트)                  │    │
│  │  SSE (라이브 스펙트럼)                    │    │
│  └───────────┬──────────────────────────────┘    │
└──────────────│──────────────────────────────────┘
               │ HTTP/SSE (WiFi AP 또는 STA)
┌──────────────│──────────────────────────────────┐
│  ESP32-C3    │                                   │
│  ┌───────────▼───────────┐ ┌──────────────────┐ │
│  │  WebServer (port 80)  │ │  DSP Engine      │ │
│  │  REST API (JSON)      │ │  1024-pt FFT     │ │
│  │  SSE (라이브)         │ │  75% overlap     │ │
│  │  LittleFS (파일)      │ │  듀얼 X/Y 투영   │ │
│  └───────────────────────┘ └────────┬─────────┘ │
│  ┌─────────────────────────────────┐│           │
│  │  SPI → ADXL345 (3200Hz 12bit)   ││           │
│  └─────────────────────────────────┘│           │
│  ┌──────────────────────────────────┘           │
│  │  NVS (설정 + 결과 + PSD 백업)                 │
│  └──────────────────────────────────────────────┘
└──────────────────────────────────────────────────┘
```

**핵심 설계 원칙:**
- Zero Coupling: 프린터와 전기적 연결 없음 (G-code는 SD카드)
- "붙이고 출력하면 끝" UX
- 펌웨어 무관: Marlin, Klipper, RRF 모두 지원

---

## 2. 파일 구조

### ESP32 펌웨어
| 파일 | 줄수 | 역할 |
|------|------|------|
| `src/main.cpp` | 1,599 | WebServer, ADXL345 드라이버, WiFi, NVS, 상태머신 |
| `src/dsp.h` | 769 | FFT, PSD, 듀얼 축 투영, 배경 PSD |

### 프론트엔드 (LittleFS `/data/`)
| 파일 | 줄수 | 역할 | 의존성 |
|------|------|------|--------|
| `index.html` | 451 | 4탭 SPA (쉐이퍼/진단/라이브/설정) | — |
| `style.css` | — | 다크 테마, 반응형 | — |
| `i18n.js` | 324 | EN/KO 다국어 | — |
| `led.js` | 14 | LED 제어 API | — |
| `shaper.js` | 988 | Klipper 쉐이퍼 엔진 (GPL v3 포팅) | — |
| `kinematics.js` | 513 | 키네마틱별 zone map + 진단 규칙 | — |
| `filter.js` | 246 | 배경 차감, 팬 필터, 하모닉, 피크 검출 | — |
| `charts.js` | 287 | PSD/라이브 Chart.js 렌더링 | Chart.js |
| `live.js` | 108 | SSE 라이브 스펙트럼 | charts.js |
| `validator.js` | 315 | 2계층 품질평가 + 3단계 판정 | — |
| `diagnostic.js` | 488 | 텍스트 기반 진단 (키네마틱별) | kinematics.js |
| `settings.js` | 1,014 | 설정 UI + NVS 저장/로드 + 캘리브레이션 | — |
| `measure.js` | 271 | Print Measure 제어 (시작/정지/폴링) | — |
| `app.js` | 615 | 탭 전환, 분석 파이프라인, UI 업데이트 | 전체 |
| `report.js` | 209 | HTML 리포트 생성 (새 창) | — |
| `chart.min.js` | 20 | Chart.js 4.x (minified 201KB) | — |

### JS 로드 순서 (의존성)
```html
i18n → led → shaper → kinematics → chart.min → charts →
filter → live → validator → diagnostic → settings → measure → app → report
```

---

## 3. REST API

### 설정
| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/api/config` | 전체 설정 JSON |
| POST | `/api/config` | 설정 저장 (NVS) |

**GET /api/config 응답:**
```json
{
  "buildX":250, "buildY":250, "accel":5000, "feedrate":300,
  "kin":"corexy", "firmware":"klipper", "sampleRate":3200,
  "scv":5.0, "damping":0.1, "targetSm":0.12,
  "calWx":[0.7,0.7,0], "calWy":[-0.7,0.7,0], "useCalWeights":true,
  "wifiMode":"sta", "staSSID":"MyWiFi", "hostname":"femto",
  "powerHz":60, "liveSegs":2, "txPower":8,
  "demoMode":false, "eepromSave":false
}
```

### ADXL345
| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/api/adxl/status` | 센서 상태 (devId, dataRate, range, fifo) |
| GET | `/api/adxl/raw` | 생 가속도 (x,y,z,mg,gForce) |
| GET | `/api/adxl/rate` | 현재 샘플레이트 |
| GET | `/api/adxl/fifo` | FIFO 상태 |

### 측정 (Print Measure)
| Method | Endpoint | 설명 |
|--------|----------|------|
| POST | `/api/measure` | `{"cmd":"print_start\|print_stop\|stop\|reset"}` |
| GET | `/api/measure/status` | 측정 상태 (state, segsX/Y, gateRatio, correlation) |
| GET | `/api/psd?mode=print` | 측정 PSD (백업 배열, 라이브 무관) |

**print_stop 응답:**
```json
{
  "ok":true, "state":"done",
  "peakX":42.5, "peakY":55.3,
  "segsX":280, "segsY":250, "segTotal":530,
  "gateRatio":0.28, "correlation":0.15,
  "convergenceX":0.8, "convergenceY":1.2
}
```

**GET /api/psd?mode=print 응답:**
```json
{
  "ok":true, "mode":"print", "freqRes":3.125,
  "binsX":[{"f":18.75,"v":0.5,"var":0.02}, ...],  // 59 bins
  "binsY":[{"f":18.75,"v":0.3,"var":0.01}, ...],  // 59 bins
  "bgPsd":[0.1, 0.08, ...]                         // 59 values
}
```

### 라이브 스펙트럼 (SSE)
| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/api/live/stream` | SSE 스트림 시작 |
| POST | `/api/live/stop` | SSE 스트림 중지 |

**SSE 데이터 형식:**
```
data: {"bx":[0,0,5.2,8.1,...], "by":[0,0,3.1,4.5,...], "pk":42.5}
```
- `bx`: X축 PSD 59빈 (18.75~200Hz, 3.125Hz 간격)
- `by`: Y축 PSD 59빈
- `pk`: 피크 주파수
- 전송 주기: `cfg.liveSegs` 세그먼트마다 (기본 2 = ~160ms = 6fps)

### 결과 저장/로드
| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/api/result` | NVS 저장된 결과 (freqX/Y, shaperType, confidence) |
| POST | `/api/result` | 결과 NVS 저장 |

### 기타
| Method | Endpoint | 설명 |
|--------|----------|------|
| POST | `/api/led` | `{"state":"on\|off\|blink"}` |
| GET | `/api/noise` | 배경 PSD (bgPsd, bgSegs) |
| POST | `/api/reboot` | ESP32 재부팅 |
| GET | `/api/wifi/scan` | WiFi 네트워크 스캔 |

---

## 4. 데이터 처리 파이프라인

```
ADXL345 (3200Hz, 3축)
  ↓ SPI FIFO (32샘플 배치)
  ↓ 캘리브레이션 벡터 투영 (printerX = Wx·sensor)
  ↓
DSP (dsp.h)
  ↓ DC 제거 (고정소수점 IIR)
  ↓ Hanning 윈도우
  ↓ 1024-pt FFT (Cooley-Tukey, float32)
  ↓ PSD = |FFT|² / (fs·N)
  ↓ 세그먼트 누적 평균 + 분산
  ↓ 듀얼 축 독립 (dspDualPsdX/Y)
  ↓
JS 분석 (filter.js → shaper.js)
  ↓ filterByBackground: 배경 차감 (적응형 + 0.01 floor)
  ↓ filterFanPeaks: 팬 피크 빈별 차감
  ↓ detectPeaks: 통합 피크 검출 (하모닉/존/팬 분류)
  ↓ analyzeShaper: 5종 쉐이퍼 스윕 (0.2Hz 스텝)
  ↓   calcSmoothing (Klipper 포팅)
  ↓   calcMaxAccel (이분법)
  ↓   _estimate_remaining_vibrations (worst-case ζ)
  ↓ practical: 사용자 설정 기반 추천
  ↓
판정 (validator.js)
  ↓ Layer 1: 측정 품질 (calibration, gateRatio, correlation)
  ↓ Layer 2: 결과 신뢰도 (SNR, confidence, peak quality)
  ↓ → APPLY / REVIEW / RETRY + accel/smoothing 경고
  ↓
UI (app.js → charts.js)
  ↓ PSD 차트, 쉐이퍼 테이블, 판정 표시
  ↓ 추천 설정 범위 (가속도/속도)
  ↓ 진단 (diagnostic.js)
```

---

## 5. 쉐이퍼 계산 엔진 (shaper.js)

**Klipper GPL v3 Python → JavaScript 포팅.**

### 지원 쉐이퍼 5종
| 이름 | 펄스 | 특성 |
|------|------|------|
| ZV | 2 | 최소 스무딩, 낮은 진동 억제 |
| MZV | 3 | 균형 (기본 추천) |
| EI | 3 | 안정적, 중간 스무딩 |
| 2HUMP_EI | 4 | 높은 진동 억제 |
| 3HUMP_EI | 5 | 최대 진동 억제, 최대 스무딩 |

### 핵심 함수
```javascript
analyzeShaper(psdData, peakFreq, damping, peaks)
→ {
    shapers: [{name, freq, vibrPct, maxAccel, smoothing, duration}],
    recommended: {performance, lowVibration, safe, best},
    practical: {
      userAccel, userFeed, buildX, buildY,
      userSmoothing, targetSmoothing,
      accelHeadroom, accelDist,
      accelOk, smoothingOk, feedReachable,
      accelRatio, maxReachSpeed, measExcitation,
      rec: {accelMin, accelMax, speedMin, speedMax, status}
    },
    confidence, dampingRatio, snrDb, ...
  }
```

### 설정값 → 계산 연동
| 설정 | 함수 | 용도 |
|------|------|------|
| scv (5.0) | `_scv()` → `getCfgScv()` | smoothing offset |
| damping (0.1) | `_damping()` → `getCfgDamping()` | 쉐이퍼 계수 K |
| targetSm (0.12) | `_targetSm()` → `getCfgTargetSm()` | maxAccel 이분법 기준 |
| accel (5000) | `getCfgAccel()` | practical.userSmoothing |
| feedrate (300) | `getCfgFeedrate()` | practical.accelDist |
| buildX/Y (250) | `getCfgBuildX/Y()` | practical.maxReachSpeed |

---

## 6. ESP32 상태머신

```
enum MeasState { MEAS_IDLE, MEAS_PRINT, MEAS_DONE };

IDLE ──print_start──▶ PRINT ──print_stop──▶ DONE
  ▲                                            │
  └───────────────reset/stop───────────────────┘

IDLE + liveMode:
  dspFeedDual → 롤링 PSD (30세그 리셋)
  SSE 전송 (cfg.liveSegs 세그마다)

PRINT:
  dspFeedDual → 누적 PSD (리셋 없음)
  폴링 (JS measure.js)

DONE:
  PSD 백업 → measPsdX/Y (라이브 오염 방지)
  NVS 저장 → femto_mpsd (재부팅 후 차트 복원)
```

---

## 7. NVS 스토리지

| 네임스페이스 | 내용 | 크기 |
|-------------|------|------|
| `femto` | 전체 설정 (Config 구조체) | ~500B |
| `femto_res` | 측정 결과 (freqX/Y, shaperType, confidence) | ~100B |
| `femto_bg` | 배경 PSD (59빈 float) | 236B |
| `femto_mpsd` | 측정 PSD 백업 (X/Y PSD + Var, 59빈×4) | 944B |
| `femto_belt` | 벨트 진단 결과 | ~50B |
| `femto_diag` | 진단 상태 | ~50B |

**파티션:**
```csv
nvs, data, nvs, 0x9000, 0x8000   # 32KB NVS
app0, app, ota_0, 0x10000, 0x1C0000   # 1.75MB 앱
spiffs, data, spiffs, 0x1D0000, 0x230000  # 2.19MB LittleFS
```

---

## 8. 캘리브레이션 시스템

**목적:** ADXL345 센서 축 → 프린터 축 매핑 (부착 각도 무관)

```
프린터X = calWx[0]×sensorX + calWx[1]×sensorY + calWx[2]×sensorZ
프린터Y = calWy[0]×sensorX + calWy[1]×sensorY + calWy[2]×sensorZ
```

**캘리브레이션 플로우:**
1. 사용자: X축 이동 (수동 or G-code)
2. ESP32: PSD 에너지 방향 분석 → 주성분 추출
3. 사용자: Y축 이동
4. ESP32: 직교 보정 → calWx/calWy 계산
5. NVS 저장 → `useCalWeights = true`

**useCalWeights = false면:** 측정/라이브 X/Y 분리 불가 → 기능 제한

---

## 9. 하드웨어 핀 배치 (v2 일렬 연결)

| 신호 | GPIO | 비고 |
|------|------|------|
| SCK | 9 | SPI Clock |
| MISO (SDO) | 1 | SPI Data Out |
| MOSI (SDA) | 0 | SPI Data In |
| CS | 4 | SPI Chip Select |
| INT1 | 3 | 인터럽트 (현재 폴링) |
| INT2 | 2 | 미사용 |
| LED | 8 | Built-in LED (Active Low) |
| EN | — | 딥슬립 웨이크 (EN-GND 택트 스위치) |

**SPI:** 5MHz, Mode 3, MSB First

---

## 10. WiFi 모드

| 모드 | SSID | IP | mDNS |
|------|------|----|------|
| AP (기본) | FEMTO-SHAPER | 192.168.4.1 | — (캡티브 포털) |
| STA | 사용자 WiFi | DHCP | `hostname.local` |

**STA 실패 → AP 자동 폴백.**
**mDNS:** STA 모드에서만 활성, `WiFi.setHostname()` + `MDNS.begin()`.

---

## 11. 통합 시 주의사항

### 11-1. JS 모듈 분리 가능성
```
독립 사용 가능 (ESP32 없이):
  shaper.js    — PSD 배열 넣으면 쉐이퍼 결과 반환
  filter.js    — PSD 필터링 (배경 차감, 하모닉, 팬)
  validator.js — 판정 엔진

ESP32 의존:
  measure.js   — /api/measure 호출
  live.js      — /api/live/stream SSE
  settings.js  — /api/config GET/POST
```

### 11-2. API 연동 포인트
TinyBee가 FEMTO의 API를 호출하려면:
```
1. WiFi STA 모드로 같은 네트워크 접속
2. mDNS (femto.local) 또는 IP로 접근
3. REST API 호출 (JSON)

예: TinyBee → GET http://femto.local/api/psd?mode=print
   → 59빈 PSD 데이터 수신
   → TinyBee 자체 UI에서 표시
```

### 11-3. SSE 라이브 연동
```javascript
const sse = new EventSource('http://femto.local/api/live/stream');
sse.onmessage = (e) => {
  const d = JSON.parse(e.data);
  // d.bx = X축 PSD [59 floats]
  // d.by = Y축 PSD [59 floats]
  // d.pk = 피크 주파수
};
```

### 11-4. 설정 동기화
TinyBee에서 FEMTO 설정 변경:
```javascript
fetch('http://femto.local/api/config', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({accel: 5000, feedrate: 300, kin: 'corexy'})
});
```

### 11-5. GPL v3 라이센스
`shaper.js`는 Klipper 코드 포팅 → **GPL v3 적용**.
통합 프로젝트도 GPL v3를 따라야 함 (또는 shaper.js를 별도 프로세스로 분리).

---

## 12. 알려진 제한/특이사항

| 항목 | 상태 | 설명 |
|------|------|------|
| HTML div 구조 | ⚠ | switchTab() JS 우회로 동작. HTML 정적 분석 시 depth 깨질 수 있음 |
| PSD 해상도 | 3.125Hz | Lorentzian 피팅으로 sub-bin ±0.1Hz 정밀도 |
| 주파수 범위 | 18.75~200Hz | 3D프린터 공진 대역 |
| ESP32 RAM | ~18KB/400KB | 여유 충분 |
| LittleFS | ~420KB 사용 | Chart.js 201KB가 대부분 |
| NVS | ~2KB 사용 / 32KB | 여유 충분 |
| 동시 접속 | 1 | SSE + WebServer 동시는 1클라이언트만 |
| CORS | 없음 | 같은 ESP32에서 서빙하므로 불필요 |

---

## 13. 배포

```bash
# 필수: 레거시 NVS 손상 방지
pio run -t erase && pio run -t upload && pio run -t uploadfs
```

**PlatformIO 설정:**
```ini
[env:esp32c3]
platform = espressif32
board = esp32-c3-devkitm-1
framework = arduino
board_build.filesystem = littlefs
board_build.partitions = partitions.csv
monitor_speed = 115200
```

---

## 14. 테스트 현황

13개 스위트, 390라운드, 1,200+ 어설션, 100% 통과.

| 스위트 | 라운드 | 범위 |
|--------|--------|------|
| test_esp32_pm40 | 40 | ESP32 목업 |
| test_bughunt20 | 20 | 경계값 |
| test_bugfinal30 | 30 | 통합 검증 |
| test_v10_30r | 30 | 파이프라인 |
| test_v10_uiux | 30 | UI/UX 플로우 |
| test_v10_attack | 30 | 공격적 엣지 |
| test_v10_full | 30 | 전체 통합 |
| test_v10_calc | 30 | 계산 정확도 |
| test_v10_zero | 30 | 무결점 |
| test_v10_field | 30 | 실기 수정 |
| test_v10_final | 30 | 최종 전체 |
| test_v10_halluc | 30 | 환각 검증 |
| test_v10_integ | 30 | 통합 (practical+live+PSD) |
