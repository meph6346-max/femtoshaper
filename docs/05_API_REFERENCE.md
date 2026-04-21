# 05. REST API 레퍼런스

## 설정
### GET /api/config
전체 설정 JSON 반환.
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

### POST /api/config
설정 저장 (NVS). 같은 JSON 형식. 부분 업데이트 가능.
응답: `{"ok":true}`

## 센서 (ADXL345)
### GET /api/adxl/status
```json
{"devId":229, "devIdHex":"0xE5", "dataRate":3200, "range":16,
 "hwFifo":5, "ok":true, "fifoMode":"stream"}
```

### GET /api/adxl/raw
```json
{"x":-12, "y":45, "z":1024, "mg":1001.2, "gForce":1.001}
```

### GET /api/adxl/fifo
```json
{"entries":12, "triggered":false}
```

## 측정 (Print Measure)
### POST /api/measure
```json
// 요청
{"cmd": "print_start" | "print_stop" | "stop" | "reset"}

// print_start 응답
{"ok":true, "state":"print"}

// print_stop 응답
{"ok":true, "state":"done",
 "peakX":42.5, "peakY":55.3,
 "segsX":280, "segsY":250, "segTotal":530,
 "gateRatio":0.28, "correlation":0.15,
 "convergenceX":0.8, "convergenceY":1.2}

// 에러 (캘리브레이션 미완료)
{"ok":false, "error":"calibration_required"}
```

### GET /api/measure/status
폴링용. 측정 중 2초 간격으로 호출.
```json
{"state":"print",
 "segsX":150, "segsY":130, "segTotal":280,
 "gateRatio":0.22, "peakX":42.3, "peakY":55.1,
 "correlation":0.18, "convergenceX":1.2, "convergenceY":2.1,
 "autoReady":false}
```

### GET /api/psd?mode=print
측정 PSD (백업 배열, 라이브 무관). measPsdValid=false이면 에러.
```json
{"ok":true, "mode":"print", "freqRes":3.125,
 "binsX":[{"f":18.75,"v":0.5,"var":0.02}, ...],  // 59빈
 "binsY":[{"f":18.75,"v":0.3,"var":0.01}, ...],  // 59빈
 "bgPsd":[0.1, 0.08, ...]}                        // 59값
```

## 라이브 SSE
### GET /api/live/stream
SSE 스트림 시작. `text/event-stream`.
```
data: {"bx":[0,0,5.2,8.1,...], "by":[0,0,3.1,...], "pk":42.5}
```
- bx: X축 PSD 59빈
- by: Y축 PSD 59빈
- pk: 피크 주파수
- 전송 주기: cfg.liveSegs 세그마다 (기본 2 = ~160ms = 6fps)

### POST /api/live/stop
SSE 종료. 응답: `{"ok":true}`

### POST /api/live/axis
```json
{"axis": "x" | "y" | "all"}
```

## 결과 저장
### GET /api/result
```json
{"freqX":42.5, "freqY":55.3, "shaperTypeX":"mzv", "shaperTypeY":"ei",
 "confidence":0.85, "ok":true}
```

### POST /api/result
같은 형식. NVS 저장 (femto_res).

## 기타
### GET /api/noise
```json
{"bgPsd":[0.1, 0.08, ...], "bgSegs":10, "bgValid":true}
```

### POST /api/led
```json
{"state": "on" | "off" | "blink"}
```

### POST /api/reboot
ESP32 재부팅. 응답 후 5초 뒤 리셋.

### GET /api/wifi/scan
```json
{"networks":[{"ssid":"MyWiFi","rssi":-45,"enc":true}, ...]}
```

### GET /api/debug
디버그 설정.

### POST /api/debug
디버그 설정 저장.
