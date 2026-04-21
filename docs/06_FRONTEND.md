# 06. 프론트엔드 구조

## 파일 목록 (JS 로드 순서 = 의존성)
```html
<script src="/i18n.js"></script>        <!-- 324줄 — EN/KO 다국어 -->
<script src="/led.js"></script>         <!--  14줄 — LED API -->
<script src="/shaper.js"></script>      <!-- 988줄 — ★ Klipper 쉐이퍼 (GPL v3) -->
<script src="/kinematics.js"></script>  <!-- 513줄 — 키네마틱 zone + 진단 규칙 -->
<script src="/chart.min.js"></script>   <!--         Chart.js 4.x (수정 금지) -->
<script src="/charts.js"></script>      <!-- 287줄 — PSD/라이브 렌더링 -->
<script src="/filter.js"></script>      <!-- 246줄 — 피크 검출, 필터링 -->
<script src="/live.js"></script>        <!-- 108줄 — SSE 라이브 -->
<script src="/validator.js"></script>   <!-- 315줄 — 판정 + Apply G-code -->
<script src="/diagnostic.js"></script>  <!-- 488줄 — 진단 -->
<script src="/settings.js"></script>    <!-- 1014줄 — 설정 + 캘리브레이션 -->
<script src="/measure.js"></script>     <!-- 271줄 — 측정 제어 -->
<script src="/app.js"></script>         <!-- 615줄 — 메인 컨트롤러 -->
<script src="/report.js"></script>      <!-- 209줄 — 리포트 -->
```

**로드 순서 변경 금지** — 의존성 위반 시 ReferenceError 발생.

## 전역 변수 (app.js)
```javascript
let lastShaperResult = null;   // {verdict:{verdict,overallScore,...}}
let xAnalysis = null;          // analyzeShaper() X축 결과
let yAnalysis = null;          // analyzeShaper() Y축 결과
let adxlConnected = false;     // ADXL 연결 상태
let realPsdX = null, realPsdY = null;  // 원본 PSD 배열
let peakFreqXGlobal = 0, peakFreqYGlobal = 0;  // 글로벌 피크
let _lastResultForSave = null; // NVS 저장용
```

## 전역 변수 (filter.js)
```javascript
var filterPsdThreshold = 0.01; // 노이즈 floor
var filterPowerHz = 60;        // 전원 주파수
var MAX_DETECT_PEAKS = 8;      // 최대 피크 수
```

## getCfg 함수 (settings.js → shaper.js에서 호출)
```javascript
getCfgScv()       → float    // s_scv DOM
getCfgDamping()   → float    // s_damping
getCfgTargetSm()  → float    // s_targetSm
getCfgAccel()     → int      // s_accel
getCfgFeedrate()  → int      // s_feedrate
getCfgBuildX()    → int      // s_buildX
getCfgBuildY()    → int      // s_buildY
getCfgMinSegs()   → int      // s_minSegs
getCfgKin()       → string   // s_kin
```

## i18n (i18n.js)
```javascript
const LANG = { en: {key:'English text',...}, ko: {key:'한국어',...} };
let curLang = 'en';
t('key') → string         // 번역
setLang('ko')              // 언어 전환 + DOM 업데이트
// data-i18n 속성으로 HTML 자동 번역
```
