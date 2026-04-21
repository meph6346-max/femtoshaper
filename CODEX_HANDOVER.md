# FEMTO SHAPER v1.0 — Codex 개발 인수인계

**이 문서의 목적:** AI 코딩 에이전트가 소스 코드를 즉시 이해하고 수정할 수 있도록 구조, 함수, 변수, 제약사항을 정리한 참조 문서.

---

## 1. 프로젝트 한 줄 요약

ESP32-C3 + ADXL345 독립형 3D프린터 진동 분석기. 프린터와 전기적 연결 없이 인풋쉐이퍼 캘리브레이션 수행. BOM $3.

---

## 2. 빌드 & 배포

```bash
# PlatformIO (필수)
pio run -t erase && pio run -t upload && pio run -t uploadfs

# 테스트 (Node.js)
cd /path/to/femto
node test_v10_integ.js  # 30라운드 통합 테스트
```

**platformio.ini:**
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

## 3. 디렉터리 구조

```
femto/
├── src/
│   ├── main.cpp          # 1,599줄 — WebServer, ADXL345, WiFi, NVS, 상태머신
│   └── dsp.h             #   769줄 — FFT, PSD, 듀얼 투영, 배경 PSD
├── data/                  # LittleFS → ESP32 플래시에 업로드
│   ├── index.html         #   451줄 — 4탭 SPA
│   ├── style.css          #          — 다크 테마 CSS
│   ├── chart.min.js       #          — Chart.js 4.x (201KB, 수정 금지)
│   ├── i18n.js            #   324줄 — EN/KO 다국어
│   ├── led.js             #    14줄 — LED API
│   ├── shaper.js          #   988줄 — ★ Klipper 쉐이퍼 엔진 (GPL v3)
│   ├── kinematics.js      #   513줄 — 키네마틱별 진단 규칙
│   ├── filter.js          #   246줄 — 피크 검출, 배경 차감, 팬 필터, 하모닉
│   ├── charts.js          #   287줄 — Chart.js 렌더링 + 피크홀드 + 히트맵
│   ├── live.js            #   108줄 — SSE 라이브 스펙트럼
│   ├── validator.js       #   315줄 — 2계층 판정 + Apply G-code
│   ├── diagnostic.js      #   488줄 — 텍스트 기반 진단
│   ├── settings.js        # 1,014줄 — 설정 UI + 캘리브레이션 + NVS
│   ├── measure.js         #   271줄 — Print Measure 제어
│   ├── app.js             #   615줄 — 메인 컨트롤러
│   └── report.js          #   209줄 — HTML 리포트
├── platformio.ini
└── partitions.csv
```

**JS 로드 순서 (index.html `<script>` 태그 순서 = 의존성 순서):**
```
i18n → led → shaper → kinematics → chart.min → charts →
filter → live → validator → diagnostic → settings → measure → app → report
```

---

## 4. ESP32 상태머신 (main.cpp)

```
enum MeasState { MEAS_IDLE, MEAS_PRINT, MEAS_DONE };

IDLE ──print_start──→ PRINT ──print_stop──→ DONE
  ↑                                            │
  └─────────reset / stop───────────────────────┘

IDLE + liveMode=true:
  dspFeedDual → 롤링 PSD (30세그 자동 리셋)
  SSE 전송 (cfg.liveSegs 세그마다)

PRINT:
  dspFeedDual → 누적 PSD (리셋 없음, 가속 구간만 유효)

DONE:
  measPsdX/Y ← dspDualPsdX/Y 백업 (라이브 오염 방지)
  NVS 저장 → femto_mpsd (재부팅 후 차트 복원)
```

---

## 5. Config 구조체 (main.cpp)

```c
struct Config {
  int    buildX = 120, buildY = 120;
  int    accel = 3000, feedrate = 200;
  int    sampleRate = 3200;
  char   kin[16] = "corexy";
  char   axesMap[8] = "xyz";
  char   firmware[20] = "marlin_is";
  float  scv = 5.0f, damping = 0.1f, targetSm = 0.12f;
  bool   demoMode = false, eepromSave = false;
  int    pinSCK=9, pinMISO=1, pinMOSI=0, pinCS=4, pinINT1=3, pinLED=8, pinReset=10;
  int    txPower = 8;
  int    minSegs = 256;
  float  calWx[3] = {1,0,0};  // 센서→프린터 X 투영 벡터
  float  calWy[3] = {0,1,0};  // 센서→프린터 Y 투영 벡터
  bool   useCalWeights = false;
  char   wifiMode[8] = "ap";
  char   staSSID[33] = "";
  char   staPass[65] = "";
  char   hostname[32] = "femto";
  int    powerHz = 60;
  int    liveSegs = 2;
} cfg;
```

---

## 6. DSP 파라미터 (dsp.h)

```c
#define DSP_N        1024        // FFT 크기
#define DSP_OVERLAP  768         // 75% 오버랩
#define DSP_STEP     256         // 스텝 = 1세그먼트 = ~80ms
#define DSP_FS       3200.0f     // 샘플레이트
#define DSP_FRES     3.125f      // 주파수 해상도 (Hz/bin)
#define DSP_NBINS    513         // FFT 출력 빈 수
#define DSP_FMIN     18.75f      // 관심 최저 주파수
#define DSP_FMAX     200.0f      // 관심 최고 주파수
#define DSP_BIN_MIN  6           // FMIN/FRES
#define DSP_BIN_MAX  64          // FMAX/FRES
// 유효 빈 수 = 64 - 6 + 1 = 59
```

---

## 7. REST API 전체

### 설정
| Method | Endpoint | 요청 | 응답 |
|--------|----------|------|------|
| GET | `/api/config` | — | Config 전체 JSON |
| POST | `/api/config` | Config JSON | `{"ok":true}` |

### 센서
| Method | Endpoint | 응답 |
|--------|----------|------|
| GET | `/api/adxl/status` | `{devId, dataRate, range, hwFifo, ok}` |
| GET | `/api/adxl/raw` | `{x,y,z,mg,gForce}` |
| GET | `/api/adxl/rate` | `{rate}` |
| GET | `/api/adxl/fifo` | `{entries, triggered}` |

### 측정
| Method | Endpoint | 요청 | 응답 |
|--------|----------|------|------|
| POST | `/api/measure` | `{"cmd":"print_start"}` | `{"ok":true,"state":"print"}` |
| POST | `/api/measure` | `{"cmd":"print_stop"}` | `{ok,state:"done",peakX,peakY,segsX,segsY,segTotal,gateRatio,correlation,convergenceX,convergenceY}` |
| POST | `/api/measure` | `{"cmd":"stop"}` | `{ok,state:"idle"}` |
| POST | `/api/measure` | `{"cmd":"reset"}` | `{ok,state:"idle"}` |
| GET | `/api/measure/status` | — | `{state,segsX,segsY,segTotal,gateRatio,peakX,peakY,correlation,convergenceX,convergenceY,autoReady}` |
| GET | `/api/psd?mode=print` | — | `{ok,binsX:[{f,v,var}×59],binsY:[...],bgPsd:[...]}` |

### 라이브 SSE
| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/api/live/stream` | SSE 스트림, `data: {"bx":[59],"by":[59],"pk":42.5}` |
| POST | `/api/live/stop` | SSE 종료 |
| POST | `/api/live/axis` | `{"axis":"x"|"y"|"all"}` |

### 결과 저장
| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/api/result` | NVS 결과 `{freqX,freqY,shaperTypeX,shaperTypeY,confidence}` |
| POST | `/api/result` | 결과 NVS 저장 |

### 기타
| Method | Endpoint | 설명 |
|--------|----------|------|
| POST | `/api/led` | `{"state":"on|off|blink"}` |
| GET | `/api/noise` | 배경 PSD |
| GET | `/api/debug` | 디버그 설정 |
| POST | `/api/debug` | 디버그 설정 저장 |
| POST | `/api/reboot` | ESP32 재부팅 |
| GET | `/api/wifi/scan` | WiFi 네트워크 스캔 결과 |

---

## 8. JS 전역 변수 & 함수 맵

### app.js — 메인 컨트롤러
```javascript
// 전역 상태
let lastShaperResult = null;   // {verdict:{verdict,overallScore,reason_ko,reason_en,...}}
let xAnalysis = null;          // analyzeShaper() 결과 (X축)
let yAnalysis = null;          // analyzeShaper() 결과 (Y축)
let adxlConnected = false;
let realPsdX = null, realPsdY = null;  // 원본 PSD 배열
let peakFreqXGlobal = 0, peakFreqYGlobal = 0;
let _lastResultForSave = null; // NVS 저장용 {freqX,freqY,shaperTypeX,shaperTypeY,confidence}

// 핵심 함수
switchTab(id)                  // 탭 전환 ('shaper'|'diag'|'live'|'settings')
updateShaperUI(peakX, peakY, xAn, yAn, psdX, psdY)  // 결과 UI 업데이트
toggleApplyPanel()             // Apply G-code 패널 토글
```

### filter.js — 필터 + 피크 검출
```javascript
// 설정
var filterPsdThreshold = 0.01; // 노이즈 floor
var filterPowerHz = 60;        // 전원 주파수

// 핵심 함수
filterByBackground(psd, bgPsd) → [{f,v,var}×59]   // 배경 차감
filterFanPeaks(psd) → [{f,v,var}×59]              // 팬 빈별 차감
detectPeaks(psd, opts) → [{f,v,prom,snr,isHarmonic,isFan,harmonicOf,harmonicOrder,zone}]
  // opts: {kin:'corexy', axis:'x'}
  // 최대 8피크 반환
  // ★ 시스템 유일 피크 검출 경로
loadFanPeaks(fanData)          // 팬 PSD 로드 {hotend:[{f,v}], parts:[{f,v}]}
zoomPeakRefine(psd, approxFreq) → {f0, amplitude, gamma, damping, rSquared}
```

### shaper.js — 쉐이퍼 엔진 (Klipper GPL v3)
```javascript
// 상수
DEFAULT_DAMPING = 0.1;
TARGET_SMOOTHING = 0.12;
DEFAULT_SCV = 5.0;

// 설정 연동 (settings.js getCfg* 호출)
_scv()       → getCfgScv()      || 5.0
_damping()   → getCfgDamping()  || 0.1
_targetSm()  → getCfgTargetSm() || 0.12

// 핵심 함수
analyzeShaper(psdData, peakFreq, damping, peaks) → {
  shapers: [{name,freq,vibrPct,maxAccel,smoothing,duration,_A,_T}×5],
  recommended: {performance, lowVibration, safe, best},
  practical: {userAccel,userFeed,buildX,buildY,userSmoothing,targetSmoothing,
              accelHeadroom,accelDist,accelOk,smoothingOk,
              accelRatio,maxReachSpeed,feedReachable,measExcitation,
              rec:{accelMin,accelMax,speedMin,speedMax,status}},
  confidence, dampingRatio, snrDb, resonanceMode, noResonance, ...
}

calcSmoothing(shaper, accel, scv) → float (mm)
calcMaxAccel(shaper, scv) → float (mm/s²)
estimateDampingRatio(psdData, peakFreq) → float
fitLorentzian(psd, peakIdx) → {f0, amplitude, gamma, damping, rSquared}
```

### validator.js — 판정 엔진
```javascript
// 판정 3단계
VERDICT_APPLY  = 'apply'   // 적용 가능
VERDICT_REVIEW = 'review'  // 확인 후 적용
VERDICT_RETRY  = 'retry'   // 재측정 필요

// 핵심 함수
validateResult(opts) → {verdict, overallScore, reason_ko, reason_en, mq, rc}
  // opts: {calibrated,gateRatio,correlation,convergenceX/Y,activeSegs,segTotal,xAnalysis,yAnalysis,peaksX,peaksY}
  // Layer 1: 측정 품질 (calibration,gateRatio,correlation,convergence)
  // Layer 2: 결과 신뢰도 (SNR,confidence,peak quality)
  // + accel_limit / smoothing_exceed / speed_unreachable / low_excitation 경고

generateApplyGcode(opts) → string
  // opts: {firmware,freqX,freqY,shaperTypeX,shaperTypeY,damping,saveToEeprom}
  // 4종 펌웨어: marlin_is, marlin_ftm, klipper, rrf
```

### diagnostic.js — 진단
```javascript
// 전역 상태
const diagState = {belt:{}, ...};

// 핵심 함수
updateDiagOverview()  // 진단 UI 업데이트 (peakFreqXGlobal, xAnalysis._peaks 참조)
  // diagEmpty ↔ diagResults 토글
  // 종합 아이콘: 🟢양호 / 🟡주의 / 🔵공진없음
  // 피크별 카드: zone + 키네마틱 맥락 + 💡액션
```

### charts.js — 렌더링
```javascript
// 라이브 상태
let _peakHold = new Array(59).fill(0);  // 피크 홀드 (0.97 감쇠)
let _hitMap = new Array(59).fill(0);    // 히트 강도 (0.985 감쇠)
let _peakHoldOn = true;

// 핵심 함수
drawPSD(canvasId, data, peakHz, color, extraPeaks)
drawLiveFrame(liveData, dataY)  // 피크홀드 + 히트맵 색상 + 상태 라인
togglePeakHold()                // Hold ON/OFF
resetLiveHistory()              // 히트맵 + 홀드 초기화
shaperTable(containerId, analysis)
```

### settings.js — 설정
```javascript
// getCfg 함수 (shaper.js/validator.js에서 호출)
getCfgScv()       → float   // s_scv DOM 값
getCfgDamping()   → float   // s_damping
getCfgTargetSm()  → float   // s_targetSm
getCfgAccel()     → int     // s_accel
getCfgFeedrate()  → int     // s_feedrate
getCfgBuildX()    → int     // s_buildX
getCfgBuildY()    → int     // s_buildY
getCfgMinSegs()   → int     // s_minSegs
getCfgKin()       → string  // s_kin

// 설정 저장/로드
saveSettings(silent)   // POST /api/config
loadSettings(retryCount)  // GET /api/config → UI 동기화
```

### measure.js — 측정 제어
```javascript
function setPrintMeasBtn(phase)  // 'idle'|'running'|'done'
  // pmIdle / pmRunning / resultSection 토글
function startPrintPolling()     // /api/measure/status 폴링 시작
function stopPrintPolling()      // 폴링 중지
function appLog(id, html)        // 로그 영역에 메시지 추가
```

### i18n.js — 다국어
```javascript
const LANG = { en: {...}, ko: {...} };
let curLang = 'en';
function t(key) → string        // 번역 키 → 텍스트
function setLang(lang)           // 언어 전환 + DOM 업데이트
```

---

## 9. NVS 네임스페이스

| 네임스페이스 | 키 | 크기 | 설명 |
|-------------|-----|------|------|
| `femto` | kin, buildX, buildY, accel, ... | ~500B | 전체 설정 |
| `femto_res` | freqX, freqY, shaperTypeX, confidence | ~100B | 측정 결과 |
| `femto_bg` | psd (59빈 float) | 236B | 배경 PSD |
| `femto_mpsd` | px, py, vx, vy, valid | 944B | 측정 PSD 백업 |
| `femto_belt` | delta, freqA, freqB | ~50B | 벨트 진단 |
| `femto_diag` | 진단 상태 | ~50B | 진단 |

---

## 10. 데이터 흐름 (분석 파이프라인)

```
[측정 완료] → /api/psd?mode=print
  → binsX/binsY (59빈)
    → filterByBackground(psd, bgPsd)   // 배경 차감 + 0.01 floor
    → filterFanPeaks(filtered)          // 팬 빈별 차감
    → detectPeaks(filtered, {kin,axis}) // 피크 검출 (8개 max)
    → analyzeShaper(filtered, peakFreq, null, peaks)
        → 5종 쉐이퍼 스윕 (0.2Hz 스텝)
        → practical 메트릭 계산
    → validateResult(...)               // APPLY/REVIEW/RETRY
    → updateShaperUI(...)               // 차트 + 테이블 + 추천
    → updateDiagOverview()              // 진단 카드
```

---

## 11. 주요 제약 & 규칙

### 절대 규칙
1. **피크 검출은 `detectPeaks()` 하나뿐** — 다른 경로 추가 금지
2. **shaper.js는 GPL v3** — 수정 시 라이센스 전파
3. **chart.min.js 수정 금지** — Chart.js 원본
4. **JS 로드 순서 변경 금지** — 의존성 순서
5. **NVS 18KB 이상 사용 금지** — WiFi 불안정 유발

### 상수 (변경 시 전체 시스템 재캘리브레이션 필요)
```
ESP32 SSE 노이즈 floor: 0.01f (4곳, 대역폭 최적화)
롤링 리셋: 30세그 (PSD 신선도 최적)
피크홀드 감쇠: 0.97 (2초 반감기)
히트맵 감쇠: 0.985 (5초 반감기)
라이브 EMA: 0.3/0.7 (UI 부드러움)
```

### HTML 구조
- div depth=0 (현재 정상)
- settingsLog/System은 pg-settings 내부
- switchTab()에 강제 숨김 안전장치 있음

### 캘리브레이션 필수
- `useCalWeights=false`이면 X/Y 분리 불가
- 측정/라이브 전에 캘리브레이션 필요
- 캘리브레이션 결과: calWx[3], calWy[3] 벡터

---

## 12. 이 세션 변경사항 (v1.0 최종)

| 변경 | 파일 | 설명 |
|------|------|------|
| mDNS 수정 | main.cpp | STA 전용, WiFi.setHostname(), cfg.hostname NVS |
| hostname UI | index.html, settings.js | 호스트명 변경 + .local 프리뷰 |
| PSD 백업 | main.cpp | measPsdX/Y → femto_mpsd NVS, 라이브 오염 방지 |
| practical 메트릭 | shaper.js | accel/feed/build 유효 활용, 추천 범위 |
| verdict 경고 | validator.js | accel_limit, smoothing_exceed, speed_unreachable, low_excitation |
| 라이브 청진기 | charts.js, index.html | 피크홀드, 히트맵 색상, Hold/Reset 버튼 |
| SSE 전송 주기 | main.cpp, settings.js, index.html | cfg.liveSegs (설정 가능, 기본 2) |
| HTML 구조 | index.html | div depth=0 정상화, 디버그→details, 데모모드 이동 |
| getCfg 6종 | settings.js | Accel, Feedrate, BuildX, BuildY, Damping, TargetSm |

---

## 13. PENDING (다음 작업)

- [ ] S1 실기 재테스트 (JSON/라이브/NVS/mDNS/청진기/추천설정)
- [ ] corr 95~97% 원인 분석 (센서 위치 or 캘리브레이션)
- [ ] 라이브 실기 버벅임 확인 (2세그)
- [ ] TinyBee 통합 (API 연동, SSE, 설정 동기화)
- [ ] v2.0: 배터리, ML 진단, golden dataset

---

## 14. 테스트 실행

```bash
# 단일 테스트
node test_v10_integ.js

# 전체 13개
for t in test_esp32_pm40 test_bughunt20 test_bugfinal30 \
         test_v10_30r test_v10_uiux test_v10_attack \
         test_v10_full test_v10_calc test_v10_zero \
         test_v10_field test_v10_final test_v10_halluc \
         test_v10_integ; do
  echo -n "$t: " && timeout 60 node $t.js 2>&1 | grep '통과율'
done
```

테스트는 Node.js VM으로 실행. DOM 목업 포함. ESP32 없이 JS 로직 검증.
Chart.js는 목업 (`global.Chart = function(){...}`).

---

## 15. 설계 원칙

```
"확진 아닌 방향 제시"  — 진단
"붙이고 출력하면 끝"   — UX
"잘 맞추는 능력보다, 틀렸을 때 적용하지 않는 능력" — 판정
"라이브 = 청진기"      — 추천 없음, 판단은 사용자가
```
