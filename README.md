# FEMTO SHAPER

Low-cost input shaper measurement tool for 3D printers using `ESP32-C3 + ADXL345`.

FEMTO SHAPER measures printer resonance without wiring into the printer mainboard, recommends input shaper settings, and serves a browser-based UI over Wi-Fi. The project is designed around a "stick it on, print, and read the result" workflow.

## English

### What It Is

FEMTO SHAPER is a standalone vibration analysis device for 3D printers.

- Hardware: `ESP32-C3 SuperMini + ADXL345`
- Approximate BOM: `$3`
- Target use: resonance measurement and input shaper recommendation
- Printer connection model: no direct coupling to the printer control board
- Supported firmware targets for generated settings: `Marlin`, `Klipper`, `RepRapFirmware`

### Why It Exists

Most input shaper workflows require one of these:

- direct wiring into the printer board
- Klipper-specific tooling
- a Raspberry Pi or another external computer
- dedicated chirp/sweep test prints

FEMTO SHAPER is built to reduce that friction.

- No board wiring required
- No Raspberry Pi required
- Works as a standalone Wi-Fi device
- Uses normal print motion instead of requiring a dedicated chirp test

### Core Idea

Instead of depending on a special sweep command, FEMTO SHAPER captures vibration during real print acceleration/deceleration events.

High-level flow:

1. Attach the sensor to the printhead or carriage.
2. Run X/Y calibration from the web UI.
3. Start a normal print.
4. Trigger `Print Measure`.
5. Let the device collect ADXL345 samples, compute FFT/PSD on the ESP32, and analyze the result in the browser.
6. Review recommended shaper parameters and generated apply commands.

### Main Features

- `Zero Coupling`: no electrical integration with the printer mainboard
- Browser UI served directly from the ESP32 via LittleFS
- Real-time live spectrum via SSE
- Print-based measurement mode with X/Y dual-axis PSD accumulation
- Background PSD capture and subtraction
- Peak detection, harmonic/fan filtering, and resonance diagnostics
- Input shaper recommendation engine ported from Klipper logic
- Final verdict engine: `APPLY`, `REVIEW`, or `RETRY`
- Saved measurement/result data in NVS
- Generated apply commands for multiple firmware ecosystems
- English/Korean UI support

### Architecture Overview

Project layout:

```text
src/
  main.cpp      ESP32 firmware: web server, ADXL345, Wi-Fi, NVS, measurement state machine
  dsp.h         FFT/PSD engine, dual-axis accumulation, peak/convergence helpers

data/
  index.html    single-page web UI
  *.js          analysis, charts, diagnostics, settings, live mode, reporting
  style.css     UI styling

docs/
  project, architecture, API, DSP, UI/UX, measurement, and diagnosis notes
```

Runtime split:

- ESP32:
  - ADXL345 sampling over SPI
  - 1024-point FFT / Welch PSD processing
  - X/Y projection using calibration weights
  - measurement state machine
  - REST API + SSE + LittleFS hosting
  - NVS persistence
- Browser:
  - PSD filtering and peak classification
  - shaper recommendation and validation logic
  - diagnostics and result presentation
  - charts and report rendering

### Measurement Pipeline

- Sensor samples are collected from the ADXL345 FIFO.
- Calibrated X/Y projection weights map sensor axes to printer axes.
- The ESP32 computes FFT/PSD windows and accumulates dual-axis spectra.
- Background energy and gating help emphasize acceleration-driven segments.
- The browser fetches measured PSD, filters background/fan content, detects peaks, and evaluates shaper candidates.
- The UI shows recommendations, diagnostics, and firmware apply commands.

### Web API Summary

Important endpoints:

- `GET /api/config`
- `POST /api/config`
- `GET /api/adxl/status`
- `POST /api/measure`
- `GET /api/measure/status`
- `GET /api/psd?mode=print`
- `GET /api/live/stream`
- `POST /api/live/stop`
- `GET /api/result`
- `POST /api/result`
- `GET /api/noise`
- `POST /api/reboot`
- `GET /api/wifi/scan`

See [docs/05_API_REFERENCE.md](./docs/05_API_REFERENCE.md) for the full interface.

### Build and Flash

Requirements:

- PlatformIO
- ESP32-C3 board compatible with `esp32-c3-devkitm-1`

Build and upload:

```bash
pio run -t erase
pio run -t upload
pio run -t uploadfs
```

### PlatformIO Target

```ini
[env:esp32c3]
platform = espressif32
board = esp32-c3-devkitm-1
framework = arduino
board_build.filesystem = littlefs
board_build.partitions = partitions.csv
monitor_speed = 115200
```

### Notes

- The web assets in `data/` are expected to be uploaded to LittleFS.
- `chart.min.js` is a bundled dependency and should be treated as a vendor file.
- The shaper logic in `data/shaper.js` is described in the handover docs as a Klipper-derived port.

### Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [CODEX_HANDOVER.md](./CODEX_HANDOVER.md)
- [INTEGRATION_HANDOVER.md](./INTEGRATION_HANDOVER.md)
- [docs/00_PROJECT_OVERVIEW.md](./docs/00_PROJECT_OVERVIEW.md)
- [docs/02_SYSTEM_ARCHITECTURE.md](./docs/02_SYSTEM_ARCHITECTURE.md)
- [docs/05_API_REFERENCE.md](./docs/05_API_REFERENCE.md)

---

## 한국어

### 프로젝트 소개

FEMTO SHAPER는 `ESP32-C3 + ADXL345` 기반의 독립형 3D 프린터 진동 분석기입니다.

- 하드웨어: `ESP32-C3 SuperMini + ADXL345`
- 예상 BOM: 약 `$3`
- 목적: 공진 주파수 측정 및 입력 셰이퍼 추천
- 연결 방식: 프린터 메인보드에 직접 배선하지 않음
- 결과 적용 대상: `Marlin`, `Klipper`, `RepRapFirmware`

### 이 프로젝트가 해결하는 문제

기존 입력 셰이퍼 측정 방식은 보통 아래 제약이 있습니다.

- 프린터 보드에 직접 배선해야 함
- Klipper 전용 도구에 의존함
- Raspberry Pi 같은 외부 컴퓨터가 필요함
- 별도의 chirp/sweep 테스트가 필요함

FEMTO SHAPER는 이런 진입 장벽을 낮추는 것을 목표로 합니다.

- 메인보드 배선 불필요
- Raspberry Pi 불필요
- ESP32 단독 Wi-Fi 장치로 동작
- 별도 sweep 테스트 대신 실제 출력 중 가감속 이벤트를 활용

### 핵심 사용 흐름

1. 센서를 헤드 또는 캐리지에 부착합니다.
2. 웹 UI에서 X/Y 보정을 실행합니다.
3. 일반 출력물을 시작합니다.
4. `Print Measure`를 시작합니다.
5. ESP32가 ADXL345 데이터를 수집하고 FFT/PSD를 계산합니다.
6. 브라우저가 공진 피크를 분석하고 입력 셰이퍼를 추천합니다.
7. 결과와 적용용 명령을 확인합니다.

### 주요 기능

- `Zero Coupling`: 프린터 메인보드와 전기적으로 직접 연결하지 않음
- LittleFS 기반 웹 UI 내장
- SSE 기반 라이브 스펙트럼 표시
- 실제 출력 기반 `Print Measure` 모드
- X/Y 듀얼 PSD 누적 및 공진 분석
- 배경 PSD 캡처 및 차감
- 팬/고조파 필터링과 진단 로직
- Klipper 계열 로직 기반 셰이퍼 추천 엔진
- 최종 판정 엔진: `APPLY`, `REVIEW`, `RETRY`
- NVS 기반 설정/결과/PSD 저장
- 다중 펌웨어용 Apply 명령 생성
- 영어/한국어 UI 지원

### 구조 요약

프로젝트 구성:

```text
src/
  main.cpp      ESP32 펌웨어: 웹서버, ADXL345, Wi-Fi, NVS, 측정 상태머신
  dsp.h         FFT/PSD 엔진, 듀얼축 누적, 피크/수렴 계산

data/
  index.html    SPA 웹 UI
  *.js          분석, 차트, 진단, 설정, 라이브, 리포트
  style.css     UI 스타일

docs/
  프로젝트 개요, 아키텍처, API, DSP, UI/UX, 측정/진단 문서
```

역할 분담:

- ESP32:
  - SPI 기반 ADXL345 샘플링
  - 1024-point FFT / Welch PSD 처리
  - 보정 벡터를 이용한 X/Y 축 투영
  - 측정 상태머신
  - REST API, SSE, 정적 파일 서빙
  - NVS 저장
- 브라우저:
  - PSD 필터링 및 피크 분류
  - 셰이퍼 추천/검증
  - 진단 결과 표시
  - 차트 및 리포트 렌더링

### 측정 파이프라인

- ADXL345 FIFO에서 가속도 샘플을 읽습니다.
- 보정 벡터로 센서 좌표계를 프린터 X/Y 축으로 투영합니다.
- ESP32가 FFT/PSD 윈도우를 계산하고 듀얼축 스펙트럼을 누적합니다.
- 배경 에너지와 게이팅으로 실제 가감속 구간을 강조합니다.
- 브라우저가 측정 PSD를 가져와 배경/팬 성분을 필터링하고 공진 피크를 검출합니다.
- 최종적으로 추천 셰이퍼, 진단 결과, 적용용 명령을 보여줍니다.

### 주요 API

- `GET /api/config`
- `POST /api/config`
- `GET /api/adxl/status`
- `POST /api/measure`
- `GET /api/measure/status`
- `GET /api/psd?mode=print`
- `GET /api/live/stream`
- `POST /api/live/stop`
- `GET /api/result`
- `POST /api/result`
- `GET /api/noise`
- `POST /api/reboot`
- `GET /api/wifi/scan`

전체 인터페이스는 [docs/05_API_REFERENCE.md](./docs/05_API_REFERENCE.md)를 참고하세요.

### 빌드 및 업로드

필수 도구:

- PlatformIO
- `esp32-c3-devkitm-1` 호환 ESP32-C3 보드

빌드/플래시:

```bash
pio run -t erase
pio run -t upload
pio run -t uploadfs
```

### 참고 사항

- `data/` 아래 파일들은 LittleFS로 업로드되어야 합니다.
- `chart.min.js`는 번들된 외부 의존성입니다.
- `data/shaper.js`는 인수인계 문서 기준 Klipper 계열 로직 포팅본입니다.

### 관련 문서

- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [CODEX_HANDOVER.md](./CODEX_HANDOVER.md)
- [INTEGRATION_HANDOVER.md](./INTEGRATION_HANDOVER.md)
- [docs/00_PROJECT_OVERVIEW.md](./docs/00_PROJECT_OVERVIEW.md)
- [docs/02_SYSTEM_ARCHITECTURE.md](./docs/02_SYSTEM_ARCHITECTURE.md)
- [docs/05_API_REFERENCE.md](./docs/05_API_REFERENCE.md)
