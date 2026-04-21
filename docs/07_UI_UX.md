# 07. UI/UX 설계

## 4탭 SPA 구조
```
⚡ 쉐이퍼  │  🔍 진단  │  📡 라이브  │  ⚙ 설정
```

## 쉐이퍼 탭 (메인)
```
┌─ 측정 카드 (최상단, 가장 먼저 보임) ──────────┐
│  [pmIdle]    📊 진동 측정                     │
│              안내 텍스트 + [▶ 측정 시작]       │
│  [pmRunning] ● 측정 중... [⏹ 측정 완료]       │
│              프로그레스바 + 세그먼트 카운트     │
└───────────────────────────────────────────────┘

┌─ resultSection (측정 완료 후 나타남) ─────────┐
│  Peak X: 42.5Hz   Peak Y: 55.3Hz             │
│  Shaper: MZV      MaxAccel: 8,500            │
│  ✅ APPLY (85%)                               │
│                                               │
│  📊 추천 설정                                  │
│    가속도: 4,200 ~ 8,500 mm/s²                │
│    속도: 229 ~ 463 mm/s                       │
│    ✅ 현재 5,000 / 300 — 여유 있음             │
│                                               │
│  [X축 PSD 차트]  Peak: 42.5Hz → MZV           │
│  쉐이퍼 테이블 (ZV/MZV/EI/2HUMP/3HUMP)        │
│  [Y축 PSD 차트]                                │
│  쉐이퍼 테이블                                  │
│                                               │
│  [💾 Save] [📄 Report] [⚡ Apply]              │
│  Apply 패널 (G-code 복사/다운로드)              │
└───────────────────────────────────────────────┘

<details> ▸ Log </details>  ← 접힘
```

## 상태 전환 (setPrintMeasBtn)
```
'idle'    → pmIdle 표시, pmRunning 숨김
'running' → pmIdle 숨김, pmRunning 표시
'done'    → pmIdle 표시, resultSection 표시
```

## 진단 탭
```
[diagEmpty]  (측정 전)
  🔍 측정 후 진단 결과가 여기에 표시됩니다

[diagResults] (측정 후)
  ┌─ 종합 상태 ─────────────────────────────┐
  │ 🟢 프린터 상태 양호  (or 🟡주의 / 🔵없음)│
  │ border-left 색상으로 상태 표시            │
  └─────────────────────────────────────────┘
  
  ┌─ 피크별 카드 (경고 우선 정렬) ───────────┐
  │ ⚠ X축 42Hz — belt/carriage zone        │
  │   CoreXY: A/B 벨트 텐션 차이 의심       │
  │   💡 양쪽 벨트 텐션을 비교해보세요        │
  ├─────────────────────────────────────────┤
  │ ℹ Y축 55Hz — belt zone                 │
  │   정상 범위 공진                         │
  └─────────────────────────────────────────┘
```

## 라이브 탭 (청진기)
```
┌─────────────────────────────────────────┐
│ Live Spectrum    X: 43Hz  Y: —          │
│                                          │
│ [바 차트 260px]                           │
│  히트맵 색상 + 피크홀드 점선              │
│  "▶ 시작을 누르고 프린터를 만져보세요"     │
│                                          │
│ 📍 44Hz · 87Hz                           │ ← 5초마다
└─────────────────────────────────────────┘
[▶ 시작]              [📌 Hold] [↺ 리셋]

<details> 💡 사용법 (접힘) </details>
```

## 설정 탭 (4 서브탭)
```
⚙ Basic │ 🔧 Advanced │ 📋 Log │ 🖥 System

Basic:
  🖨 프린터 설정 (buildX/Y, accel, feedrate)
  ⚙ 키네마틱 (corexy/cartesian/corexz/delta)
  🎯 펌웨어 (marlin_is/ftm/klipper/rrf)
  📐 캘리브레이션 (시작/저장)
  [💾 Save]

Advanced:
  📊 측정 설정 (수렴, 세그먼트, EMA, 상관도)
  📐 캘리브레이션 파라미터
  ⚡ 쉐이퍼 분석 (SCV, 감쇠비, 목표 스무딩)
  🔍 노이즈 필터 (전원Hz, PSD floor)
  ✅ 결과 판정 + 데모 모드
  <details> 🔧 디버그 </details>
  [💾 Save]

Log:
  🔬 ADXL345 Status (Status/Raw/Clear)
  🐛 Debug Log

System:
  📶 WiFi (AP/STA + hostname.local)
  🔌 GPIO 핀 배치
  ℹ System Info (버전/힙/업타임/mDNS)
  [💾 Save] [🔄 Reboot] [⚠ Reset]
```

## 다크 테마
style.css (230줄). CSS 변수 기반:
```css
--bg1: #2E3440;  --bg2: #3B4252;  --bg3: #434C5E;
--tx1: #ECEFF4;  --tx2: #D8DEE9;  --tx3: #8892A3;
--pri: #88C0D0;  --suc: #A3BE8C;  --wrn: #EBCB8B;  --err: #BF616A;
```
Nord 팔레트 기반. 반응형 (모바일 우선).
