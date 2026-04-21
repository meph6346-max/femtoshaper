// ============================================================
// FEMTO SHAPER ESP32-C3 Firmware v0.8
// 버그 수정 목록:
//   1. CS pinMode를 SPI.begin() 이전에 설정 (글리치 방지)
//   2. FIFO bypass→stream 전환 시 리셋 추가
//   3. GPIO0 INT1: INPUT_PULLUP 적용 (부트핀 안정성)
//   4. adxl_test.js 라우트 추가
//   5. 함수명 handleSaveBelt/LoadBelt 통일
//   6. adxlFifoReady ISR에서만 쓰기 (경쟁조건 제거)
//   7. INT_SOURCE 클리어 후 ISR 등록
//
// 확정 배선 (납땜):
//   SCL → GPIO4 (SCK/MISO)
//   SDO → GPIO2 (MISO)
//   SDA → GPIO3 (MOSI)
//   CS  → GPIO1
//   INT1→ GPIO0
// ============================================================

#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <FS.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <SPI.h>
#include <DNSServer.h>
#include <ESPmDNS.h>
#include <esp_log.h>
#include "esp_sleep.h"
#include "dsp.h"

const char*     AP_SSID = "FEMTO-SHAPER";
const IPAddress AP_IP(192, 168, 4, 1);

WebServer   server(80);

// v0.9: String 제거 — 공유 JSON 응답 버퍼 (힙 단편화 방지)
static char _jbuf[8192];  // v1.0: 듀얼 PSD (binsX+binsY+bgPsd) ~6.2KB
inline void sendJson(JsonDocument& doc) {
  size_t len = serializeJson(doc, _jbuf, sizeof(_jbuf));
  if (len >= sizeof(_jbuf)) {
    // 버퍼 오버플로우 — 잘린 JSON 대신 에러 반환
    server.send(500, "application/json", "{\"ok\":false,\"err\":\"JSON too large\"}");
    return;
  }
  server.send(200, "application/json", _jbuf);
}
DNSServer   dnsServer;
Preferences prefs;

// ── Config (전역 — 모든 함수에서 사용) ──────────────
struct Config {
  int    buildX = 120, buildY = 120, accel = 3000, feedrate = 200, sampleRate = 3200;
  char kin[16] = "corexy"; char axesMap[8] = "xyz"; char firmware[20] = "marlin_is";
  float  scv      = 5.0f;
  float  damping  = 0.1f;
  float  targetSm = 0.12f;
  bool   demoMode = false;
  bool   eepromSave = false;
  int    pinSCK = 9, pinMISO = 1, pinMOSI = 0, pinCS = 4, pinINT1 = 3, pinLED = 8, pinReset = 10;
  int    txPower = 8;
  int    minSegs = 256;
  // v0.9: 축 캘리브레이션 가중치 (벡터 투영)
  // printerX = calWx[0]*ax + calWx[1]*ay + calWx[2]*az
  float  calWx[3] = {1, 0, 0};  // 기본: ADXL X → 프린터 X
  float  calWy[3] = {0, 1, 0};  // 기본: ADXL Y → 프린터 Y
  bool   useCalWeights = false;
  // v0.9: WiFi STA 모드
  char wifiMode[8] = "ap";
  char staSSID[33] = "";
  char staPass[65] = "";
  char hostname[32] = "femto";  // v1.0: mDNS 호스트명 (hostname.local)
  int    powerHz  = 60;  // 전원 주파수 (60/50/0)
  int    liveSegs = 2;   // 라이브 SSE 전송 주기 (세그먼트)
} cfg;

// ── LED (Active Low, GPIO8 = BUILTIN LED) ───────────
#define LED_PIN 8
enum LedState { LED_OFF, LED_ON, LED_BLINK };
LedState      ledState    = LED_OFF;
unsigned long lastBlink   = 0;
bool          blinkToggle = false;

void updateLed() {
  switch (ledState) {
    case LED_OFF:   digitalWrite(cfg.pinLED, HIGH); break;
    case LED_ON:    digitalWrite(cfg.pinLED, LOW);  break;
    case LED_BLINK:
      if (millis() - lastBlink > 300) {
        blinkToggle = !blinkToggle;
        digitalWrite(cfg.pinLED, blinkToggle ? LOW : HIGH);
        lastBlink = millis();
      }
      break;
  }
}

// ══════════════════════════════════════════════════════
// ADXL345 드라이버
// ══════════════════════════════════════════════════════

// ── 확정 핀 배선 ────────────────────────────────────
#define ADXL_SCK   4   // GPIO4 = SCK  (SCL선)
#define ADXL_MISO  2   // GPIO2 = MISO (SDO선)
#define ADXL_MOSI  3   // GPIO3 = MOSI (SDA선)
#define ADXL_CS    1   // GPIO1 = CS
#define ADXL_INT1  0   // GPIO0 = INT1 (RISING만 사용)

// ── 레지스터 주소 ────────────────────────────────────
#define REG_DEVID       0x00
#define REG_BW_RATE     0x2C
#define REG_POWER_CTL   0x2D
#define REG_INT_ENABLE  0x2E
#define REG_INT_MAP     0x2F
#define REG_INT_SOURCE  0x30
#define REG_DATA_FORMAT 0x31
#define REG_DATAX0      0x32
#define REG_FIFO_CTL    0x38
#define REG_FIFO_STATUS 0x39

#define SPI_READ  0x80
#define SPI_MULTI 0x40

// ── 샘플 구조체 ─────────────────────────────────────
struct AdxlSample { int16_t x, y, z; };

// ── 상태 변수 ───────────────────────────────────────
static bool    adxlOK    = false;
static bool    bootNoiseDone = false;
static int     bootNoiseSamples = 0;
static uint8_t adxlDevId = 0;

#define ADXL_BUF_SIZE 64
static AdxlSample adxlBuf[ADXL_BUF_SIZE];
static uint8_t    adxlHead  = 0;
static uint8_t    adxlCount = 0;

static volatile bool adxlFifoReady = false;  // ISR에서만 쓰기

// 샘플레이트 측정
static uint32_t adxlRateSamples   = 0;
static uint32_t adxlRateStart     = 0;
static float    adxlRateHz        = 0.0f;
static bool     adxlRateMeasuring = false;

// ── ISR ──────────────────────────────────────────────
void IRAM_ATTR adxlISR() {
  adxlFifoReady = true;
}

// ── SPI R/W ─────────────────────────────────────────
static uint8_t spiRead(uint8_t reg) {
  digitalWrite(cfg.pinCS, LOW);
  SPI.transfer(reg | SPI_READ);
  uint8_t v = SPI.transfer(0x00);
  digitalWrite(cfg.pinCS, HIGH);
  return v;
}

static void spiWrite(uint8_t reg, uint8_t val) {
  digitalWrite(cfg.pinCS, LOW);
  SPI.transfer(reg & 0x7F);
  SPI.transfer(val);
  digitalWrite(cfg.pinCS, HIGH);
}

static void spiReadXYZ(int16_t &x, int16_t &y, int16_t &z) {
  uint8_t b[6];
  digitalWrite(cfg.pinCS, LOW);
  SPI.transfer(REG_DATAX0 | SPI_READ | SPI_MULTI);
  for (int i = 0; i < 6; i++) b[i] = SPI.transfer(0x00);
  digitalWrite(cfg.pinCS, HIGH);
  x = (int16_t)((b[1] << 8) | b[0]);
  y = (int16_t)((b[3] << 8) | b[2]);
  z = (int16_t)((b[5] << 8) | b[4]);
}

// ── 초기화 ──────────────────────────────────────────
bool adxlInit() {
  Serial.printf("[ADXL] 핀: SCK=%d MISO=%d MOSI=%d CS=%d INT1=%d\n",
    cfg.pinSCK, cfg.pinMISO, cfg.pinMOSI, cfg.pinCS, cfg.pinINT1);

  // CS를 먼저 HIGH로 (SPI 비활성 상태)
  pinMode(cfg.pinCS, OUTPUT);
  digitalWrite(cfg.pinCS, HIGH);
  delay(10);

  // SPI 시작 — SS=-1로 수동 CS 전용
  SPI.end();  // 혹시 이전 상태 클리어
  SPI.begin(cfg.pinSCK, cfg.pinMISO, cfg.pinMOSI, -1);
  SPI.setFrequency(1000000);  // 초기화 시 1MHz (안정성 우선)
  SPI.setDataMode(SPI_MODE3);
  delay(50);  // SPI 안정화 대기

  // INT1 핀 설정
  pinMode(cfg.pinINT1, INPUT_PULLUP);
  delay(10);

  // DevID 읽기 — 3회 재시도
  adxlDevId = 0;
  for (int attempt = 1; attempt <= 3; attempt++) {
    // CS 토글로 ADXL345 SPI 상태 리셋
    digitalWrite(cfg.pinCS, HIGH);
    delay(5);
    digitalWrite(cfg.pinCS, LOW);
    delay(1);
    digitalWrite(cfg.pinCS, HIGH);
    delay(5);

    adxlDevId = spiRead(REG_DEVID);
    Serial.printf("[ADXL] 시도 %d/3: DevID=0x%02X %s\n",
      attempt, adxlDevId, adxlDevId == 0xE5 ? "OK" : "FAIL");

    if (adxlDevId == 0xE5) break;
    delay(50);
  }

  if (adxlDevId != 0xE5) {
    Serial.println("[ADXL] 초기화 실패 — 배선 확인:");
    Serial.printf("  SCK→GPIO%d  MISO→GPIO%d  MOSI→GPIO%d  CS→GPIO%d\n",
      cfg.pinSCK, cfg.pinMISO, cfg.pinMOSI, cfg.pinCS);
    return false;
  }

  // SPI 속도를 5MHz로 올림 (정상 통신 속도)
  SPI.setFrequency(5000000);

  spiWrite(REG_POWER_CTL, 0x00);  // Standby
  delay(5);

  // BW_RATE: Settings sampleRate → ADXL BW_RATE 레지스터 매핑
  uint8_t bwRate = 0x0F; // 기본 3200Hz
  if      (cfg.sampleRate <= 400)  bwRate = 0x0C;
  else if (cfg.sampleRate <= 800)  bwRate = 0x0D;
  else if (cfg.sampleRate <= 1600) bwRate = 0x0E;
  else                             bwRate = 0x0F;
  spiWrite(REG_BW_RATE, bwRate);
  Serial.printf("[ADXL] BW_RATE=0x%02X (%dHz)\n", bwRate, cfg.sampleRate);
  spiWrite(REG_DATA_FORMAT, 0x08);  // Full Res, ±2g

  // FIFO: bypass → stream (리셋)
  spiWrite(REG_FIFO_CTL, 0x00);  // bypass
  delay(1);
  spiWrite(REG_FIFO_CTL, 0x99);  // Stream + WM=25

  spiWrite(REG_INT_MAP,    0x00);  // 모두 INT1
  spiWrite(REG_INT_ENABLE, 0x02);  // 워터마크 활성화

  // ISR 등록 전 INT_SOURCE 클리어
  spiRead(REG_INT_SOURCE);

  attachInterrupt(digitalPinToInterrupt(cfg.pinINT1), adxlISR, RISING);

  spiWrite(REG_POWER_CTL, 0x08);  // Measurement ON
  delay(5);

  // 검증: 데이터 레지스터 읽기 테스트
  int16_t tx, ty, tz;
  spiReadXYZ(tx, ty, tz);
  Serial.printf("[ADXL] 초기 데이터: X=%d Y=%d Z=%d\n", tx, ty, tz);
  Serial.printf("[ADXL] 초기화 완료: %dHz / ±2g FR / Stream(WM=25)\n", cfg.sampleRate);
  return true;
}

// ── FIFO 드레인 ──────────────────────────────────────
static void adxlDrainFifo() {
  uint8_t hwCnt = spiRead(REG_FIFO_STATUS) & 0x3F;
  for (uint8_t i = 0; i < hwCnt; i++) {
    int16_t x, y, z;
    spiReadXYZ(x, y, z);
    uint8_t idx = (adxlHead + adxlCount) % ADXL_BUF_SIZE;
    adxlBuf[idx] = {x, y, z};
    if (adxlCount < ADXL_BUF_SIZE) {
      adxlCount++;
    } else {
      adxlHead = (adxlHead + 1) % ADXL_BUF_SIZE;
    }
  }
  if (adxlRateMeasuring) adxlRateSamples += hwCnt;
}

static void adxlUpdate() {
  // GPIO0 ISR 불안정 대비: FIFO STATUS 레지스터 직접 폴링
  // ISR이 작동하면 빠르게, 안 하면 폴링으로 폴백
  if (adxlFifoReady) {
    adxlFifoReady = false;
    adxlDrainFifo();
  } else {
    // 폴링: FIFO에 워터마크(25) 이상 쌓였으면 드레인
    uint8_t entries = spiRead(REG_FIFO_STATUS) & 0x3F;
    if (entries >= 25) {
      adxlDrainFifo();
    }
  }
}

static float toMs2(int16_t raw) {
  return raw * 0.0039f * 9.80665f;
}

static AdxlSample adxlLatest() {
  if (adxlCount == 0) return {0, 0, 0};
  return adxlBuf[(adxlHead + adxlCount - 1) % ADXL_BUF_SIZE];
}

// ══════════════════════════════════════════════════════
// ADXL API
// ══════════════════════════════════════════════════════

// ── 디버그 설정 API ────────────────────────────────────
void handleDebugGet() {
  JsonDocument doc;
  doc["minValidSegs"] = dspMinValidSegs;
  doc["sweepThreshold"] = 5.0;
  doc["quietSegsLimit"] = QUIET_SEGS_LIMIT;
  doc["bgPsdSegs"] = dspBgSegs;
  doc["bgPsdValid"] = (dspBgSegs > 0);
  doc["bootNoiseDone"] = bootNoiseDone;
  doc["bootNoiseSamples"] = bootNoiseSamples;
  doc["freeHeap"] = ESP.getFreeHeap();
  sendJson(doc);
}

void handleDebugPost() {
  JsonDocument doc;
  deserializeJson(doc, server.arg("plain"));
  if (doc["minValidSegs"].is<int>()) {
    dspMinValidSegs = constrain(doc["minValidSegs"].as<int>(), 10, 500);
  }
  JsonDocument res;
  res["ok"] = true;
  res["minValidSegs"] = dspMinValidSegs;
  sendJson(res);
  Serial.printf("[DEBUG] minValidSegs=%d\n", dspMinValidSegs);
}

void handleAdxlStatus() {
  JsonDocument doc;
  doc["ok"]         = adxlOK;
  doc["devId"]      = adxlDevId;
  { char hex[8]; snprintf(hex, sizeof(hex), "0x%02X", adxlDevId); doc["devIdHex"] = hex; }
  doc["expect"]     = "0xe5";
  doc["pinSCK"]     = cfg.pinSCK;
  doc["pinMISO"]    = cfg.pinMISO;
  doc["pinMOSI"]    = cfg.pinMOSI;
  doc["pinCS"]      = cfg.pinCS;
  doc["pinINT1"]    = cfg.pinINT1;
  doc["bufCount"]   = adxlCount;
  doc["sampleRate"] = cfg.sampleRate;
  doc["freeHeap"]   = ESP.getFreeHeap();
  doc["uptime"]     = millis();
  sendJson(doc);
}

void handleAdxlRaw() {
  JsonDocument doc;
  if (!adxlOK) {
    doc["ok"] = false; doc["error"] = "ADXL not initialized";
    sendJson(doc); return;
  }
  // ISR 우회: SPI에서 직접 최신 XYZ 읽기
  int16_t rx, ry, rz;
  spiReadXYZ(rx, ry, rz);
  float ax = toMs2(rx), ay = toMs2(ry), az = toMs2(rz);
  doc["ok"]  = true;
  doc["x"] = rx; doc["y"] = ry; doc["z"] = rz;
  doc["xg"] = ax / 9.80665f; doc["yg"] = ay / 9.80665f; doc["zg"] = az / 9.80665f;
  doc["bufCount"] = adxlCount;
  doc["fifoReady"] = adxlFifoReady;
  doc["int1State"] = digitalRead(cfg.pinINT1);
  doc["hwFifo"] = spiRead(REG_FIFO_STATUS) & 0x3F;
  sendJson(doc);
}

void handleAdxlRate() {
  if (server.method() == HTTP_POST) {
    adxlRateSamples = 0; adxlRateStart = millis(); adxlRateMeasuring = true;
    server.send(200, "application/json", "{\"ok\":true,\"msg\":\"측정 시작\"}");
    return;
  }
  JsonDocument doc;
  if (adxlRateMeasuring) {
    uint32_t elapsed = millis() - adxlRateStart;
    if (elapsed >= 1000) {
      adxlRateHz = adxlRateSamples * 1000.0f / (float)elapsed;
      adxlRateMeasuring = false;
      doc["done"] = true; doc["hz"] = adxlRateHz;
      doc["samples"] = adxlRateSamples; doc["elapsed"] = elapsed;
      doc["ok"] = (adxlRateHz > 2800.0f && adxlRateHz < 3400.0f);
    } else {
      doc["done"] = false; doc["elapsed"] = elapsed; doc["samples"] = adxlRateSamples;
    }
  } else {
    doc["done"] = true; doc["hz"] = adxlRateHz;
    doc["ok"] = (adxlRateHz > 2800.0f && adxlRateHz < 3400.0f);
  }
  sendJson(doc);
}

void handleAdxlFifo() {
  JsonDocument doc;
  doc["ok"]        = adxlOK;
  doc["bufCount"]  = adxlCount;
  doc["bufMax"]    = ADXL_BUF_SIZE;
  doc["watermark"] = 25;
  doc["fifoReady"] = adxlFifoReady;
  uint8_t hw = adxlOK ? spiRead(REG_FIFO_STATUS) : 0;
  doc["hwCount"]   = hw & 0x3F;
  sendJson(doc);
}

// ══════════════════════════════════════════════════════
// Config
// ══════════════════════════════════════════════════════
// Config는 파일 상단에 선언됨
void saveConfig();  // 전방 선언 (loadConfig에서 첫 부팅 시 호출)

void loadConfig() {
  // 첫 부팅 감지: NVS에 "femto" 네임스페이스가 없으면 기본값 저장
  bool firstBoot = false;
  if (!prefs.begin("femto", true)) {  // read-only로 열어서 존재 확인
    prefs.end();
    firstBoot = true;
    Serial.println("[NVS] 첫 부팅 — 기본 설정 저장");
    saveConfig();  // 기본값으로 NVS 생성
  } else {
    prefs.end();
  }

  // 정상 로드
  prefs.begin("femto", false);
  cfg.buildX     = prefs.getInt("buildX",    cfg.buildX);
  cfg.buildY     = prefs.getInt("buildY",    cfg.buildY);
  cfg.accel      = prefs.getInt("accel",     cfg.accel);
  cfg.feedrate   = prefs.getInt("feedrate",  cfg.feedrate);
  cfg.sampleRate = prefs.getInt("sampleRate",cfg.sampleRate);
  prefs.getString("kin", cfg.kin, sizeof(cfg.kin));
  prefs.getString("axesMap", cfg.axesMap, sizeof(cfg.axesMap));
  // v0.9: 캘리브레이션 가중치 로드
  cfg.useCalWeights = prefs.getBool("useCal", false);
  cfg.calWx[0] = prefs.getFloat("cwx0", 1); cfg.calWx[1] = prefs.getFloat("cwx1", 0); cfg.calWx[2] = prefs.getFloat("cwx2", 0);
  cfg.calWy[0] = prefs.getFloat("cwy0", 0); cfg.calWy[1] = prefs.getFloat("cwy1", 1); cfg.calWy[2] = prefs.getFloat("cwy2", 0);
  cfg.scv        = prefs.getFloat("scv",      cfg.scv);
  cfg.damping    = prefs.getFloat("damping",  cfg.damping);
  cfg.targetSm   = prefs.getFloat("targetSm", cfg.targetSm);
  cfg.demoMode   = prefs.getBool("demoMode",  cfg.demoMode);
  prefs.getString("firmware", cfg.firmware, sizeof(cfg.firmware));
  cfg.eepromSave = prefs.getBool("eepromSave",cfg.eepromSave);
  cfg.pinSCK     = prefs.getInt("pinSCK",    cfg.pinSCK);
  cfg.pinMISO    = prefs.getInt("pinMISO",   cfg.pinMISO);
  cfg.pinMOSI    = prefs.getInt("pinMOSI",   cfg.pinMOSI);
  cfg.pinCS      = prefs.getInt("pinCS",     cfg.pinCS);
  cfg.pinINT1    = prefs.getInt("pinINT1",   cfg.pinINT1);
  cfg.pinLED     = prefs.getInt("pinLED",    cfg.pinLED);
  cfg.pinReset   = prefs.getInt("pinReset",  cfg.pinReset);
  cfg.txPower    = prefs.getInt("txPower",   cfg.txPower);
  cfg.minSegs    = prefs.getInt("minSegs",   cfg.minSegs);
  prefs.getString("wifiMode", cfg.wifiMode, sizeof(cfg.wifiMode));
  prefs.getString("staSSID", cfg.staSSID, sizeof(cfg.staSSID));
  prefs.getString("staPass", cfg.staPass, sizeof(cfg.staPass));
  prefs.getString("hostname", cfg.hostname, sizeof(cfg.hostname));
  if (cfg.hostname[0] == '\0') strncpy(cfg.hostname, "femto", sizeof(cfg.hostname)-1);
  cfg.powerHz    = prefs.getInt("powerHz",    cfg.powerHz);
  cfg.liveSegs   = prefs.getInt("liveSegs",   cfg.liveSegs);
  if (cfg.liveSegs < 1) cfg.liveSegs = 1;
  if (cfg.liveSegs > 10) cfg.liveSegs = 10;
  prefs.end();

  // DSP 엔진에 minSegs 동기화
  dspMinValidSegs = cfg.minSegs;

  dspMinValidSegs = cfg.minSegs;
  dspSetSampleRate((float)cfg.sampleRate);
  if (firstBoot) {
    Serial.println("[NVS] 기본값 로드 완료");
  }
  Serial.printf("[CFG] %dx%d accel=%d scv=%.1f fw=%s\n",
    cfg.buildX, cfg.buildY, cfg.accel, cfg.scv, cfg.firmware);
}

void saveConfig() {
  prefs.begin("femto", false);
  prefs.putInt("buildX",     cfg.buildX);
  prefs.putInt("buildY",     cfg.buildY);
  prefs.putInt("accel",      cfg.accel);
  prefs.putInt("feedrate",   cfg.feedrate);
  prefs.putInt("sampleRate", cfg.sampleRate);
  prefs.putString("kin",      cfg.kin);
  prefs.putString("axesMap",  cfg.axesMap);
  prefs.putBool("useCal",    cfg.useCalWeights);
  prefs.putFloat("cwx0", cfg.calWx[0]); prefs.putFloat("cwx1", cfg.calWx[1]); prefs.putFloat("cwx2", cfg.calWx[2]);
  prefs.putFloat("cwy0", cfg.calWy[0]); prefs.putFloat("cwy1", cfg.calWy[1]); prefs.putFloat("cwy2", cfg.calWy[2]);
  prefs.putFloat("scv",       cfg.scv);
  prefs.putFloat("damping",   cfg.damping);
  prefs.putFloat("targetSm",  cfg.targetSm);
  prefs.putBool("demoMode",   cfg.demoMode);
  prefs.putString("firmware", cfg.firmware);
  prefs.putBool("eepromSave", cfg.eepromSave);
  prefs.putInt("pinSCK",     cfg.pinSCK);
  prefs.putInt("pinMISO",    cfg.pinMISO);
  prefs.putInt("pinMOSI",    cfg.pinMOSI);
  prefs.putInt("pinCS",      cfg.pinCS);
  prefs.putInt("pinINT1",    cfg.pinINT1);
  prefs.putInt("pinLED",     cfg.pinLED);
  prefs.putInt("pinReset",   cfg.pinReset);
  prefs.putInt("txPower",    cfg.txPower);
  prefs.putInt("minSegs",    cfg.minSegs);
  prefs.putString("wifiMode", cfg.wifiMode);
  prefs.putString("staSSID",  cfg.staSSID);
  prefs.putString("staPass",  cfg.staPass);
  prefs.putString("hostname", cfg.hostname);
  prefs.putInt("powerHz",     cfg.powerHz);
  prefs.putInt("liveSegs",    cfg.liveSegs);
  prefs.end();
}

void serveFile(const char* path, const char* ct) {
  File f = LittleFS.open(path, "r");
  if (!f) { server.send(404, "text/plain", "Not found"); return; }
  server.streamFile(f, ct);
  f.close();
}

void handleGetConfig() {
  JsonDocument doc;
  doc["buildX"]=cfg.buildX; doc["buildY"]=cfg.buildY;
  doc["accel"]=cfg.accel;   doc["feedrate"]=cfg.feedrate;
  doc["kin"]=cfg.kin;       doc["sampleRate"]=cfg.sampleRate;
  doc["axesMap"]=cfg.axesMap; doc["firmware"]=cfg.firmware;
  doc["scv"]=cfg.scv; doc["damping"]=cfg.damping;
  doc["targetSm"]=cfg.targetSm; doc["demoMode"]=cfg.demoMode;
  doc["eepromSave"]=cfg.eepromSave;
  doc["pinSCK"]=cfg.pinSCK; doc["pinMISO"]=cfg.pinMISO;
  doc["pinMOSI"]=cfg.pinMOSI; doc["pinCS"]=cfg.pinCS;
  doc["pinINT1"]=cfg.pinINT1; doc["pinLED"]=cfg.pinLED; doc["pinReset"]=cfg.pinReset;
  doc["txPower"]=cfg.txPower;
  doc["minSegs"]=cfg.minSegs;
  doc["wifiMode"]=cfg.wifiMode; doc["staSSID"]=cfg.staSSID;
  doc["hostname"]=cfg.hostname;
  // 현재 WiFi 상태
  doc["wifiConnected"]=(WiFi.status()==WL_CONNECTED);
  doc["wifiIP"]= (WiFi.status()==WL_CONNECTED) ? WiFi.localIP().toString() : WiFi.softAPIP().toString();
  doc["wifiActiveMode"]= (WiFi.status()==WL_CONNECTED) ? "sta" : "ap";
  doc["powerHz"]=cfg.powerHz;
  doc["liveSegs"]=cfg.liveSegs;
  doc["useCalWeights"]=cfg.useCalWeights;
  JsonArray cwx=doc["calWx"].to<JsonArray>(); cwx.add(cfg.calWx[0]); cwx.add(cfg.calWx[1]); cwx.add(cfg.calWx[2]);
  JsonArray cwy=doc["calWy"].to<JsonArray>(); cwy.add(cfg.calWy[0]); cwy.add(cfg.calWy[1]); cwy.add(cfg.calWy[2]);
  doc["freeHeap"]=ESP.getFreeHeap();
  sendJson(doc);
}

void handlePostConfig() {
  if (!server.hasArg("plain")) { server.send(400,"text/plain","No body"); return; }
  JsonDocument doc;
  if (deserializeJson(doc,server.arg("plain"))) { server.send(400,"text/plain","JSON error"); return; }
  if (doc["buildX"].is<int>())      cfg.buildX     = doc["buildX"];
  if (doc["buildY"].is<int>())      cfg.buildY     = doc["buildY"];
  if (doc["accel"].is<int>())       cfg.accel      = doc["accel"];
  if (doc["feedrate"].is<int>())    cfg.feedrate   = doc["feedrate"];
  if (doc["sampleRate"].is<int>())  cfg.sampleRate = doc["sampleRate"];
  if (doc["kin"].is<const char*>()) strncpy(cfg.kin, doc["kin"] | "corexy", sizeof(cfg.kin)-1);
  if (doc["axesMap"].is<const char*>()) strncpy(cfg.axesMap, doc["axesMap"] | "xyz", sizeof(cfg.axesMap)-1);
  // v0.9: 캘리브레이션 가중치 (JS 위저드에서 전송)
  if (doc["calWx"].is<JsonArray>() && doc["calWx"].size() == 3) {
    cfg.calWx[0] = doc["calWx"][0]; cfg.calWx[1] = doc["calWx"][1]; cfg.calWx[2] = doc["calWx"][2];
    cfg.calWy[0] = doc["calWy"][0]; cfg.calWy[1] = doc["calWy"][1]; cfg.calWy[2] = doc["calWy"][2];
    cfg.useCalWeights = true;
  }
  // Phase 5: SCV / damping / targetSm 저장
  if (doc["scv"].is<float>())      cfg.scv        = doc["scv"].as<float>();
  if (doc["damping"].is<float>())  cfg.damping    = doc["damping"].as<float>();
  if (doc["targetSm"].is<float>()) cfg.targetSm   = doc["targetSm"].as<float>();
  if (doc["demoMode"].is<bool>())  cfg.demoMode   = doc["demoMode"].as<bool>();
  if (doc["firmware"].is<const char*>()) strncpy(cfg.firmware, doc["firmware"] | "marlin_is", sizeof(cfg.firmware)-1);
  if (doc["eepromSave"].is<bool>()) cfg.eepromSave = doc["eepromSave"];
  // GPIO 핀 배정 (재시작 후 적용)
  if (doc["pinSCK"].is<int>())   cfg.pinSCK   = doc["pinSCK"];
  if (doc["pinMISO"].is<int>())  cfg.pinMISO  = doc["pinMISO"];
  if (doc["pinMOSI"].is<int>())  cfg.pinMOSI  = doc["pinMOSI"];
  if (doc["pinCS"].is<int>())    cfg.pinCS    = doc["pinCS"];
  if (doc["pinINT1"].is<int>())  cfg.pinINT1  = doc["pinINT1"];
  if (doc["pinLED"].is<int>())   cfg.pinLED   = doc["pinLED"];
  if (doc["pinReset"].is<int>()) cfg.pinReset = doc["pinReset"];
  if (doc["txPower"].is<int>())  cfg.txPower  = doc["txPower"];
  if (doc["minSegs"].is<int>()) {
    cfg.minSegs = constrain(doc["minSegs"].as<int>(), 10, 500);
    dspMinValidSegs = cfg.minSegs;  // DSP 엔진에 즉시 반영
  }
  if (doc["wifiMode"].is<const char*>()) strncpy(cfg.wifiMode, doc["wifiMode"] | "ap", sizeof(cfg.wifiMode)-1);
  if (doc["staSSID"].is<const char*>()) strncpy(cfg.staSSID, doc["staSSID"] | "", sizeof(cfg.staSSID)-1);
  if (doc["staPass"].is<const char*>()) strncpy(cfg.staPass, doc["staPass"] | "", sizeof(cfg.staPass)-1);
  if (doc["hostname"].is<const char*>()) {
    strncpy(cfg.hostname, doc["hostname"] | "femto", sizeof(cfg.hostname)-1);
    // 호스트명 유효성: 영숫자+하이픈만, 첫글자 영문
    for (int i=0; cfg.hostname[i]; i++) {
      char c = cfg.hostname[i];
      if (!((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='-')) cfg.hostname[i] = '-';
    }
    if (cfg.hostname[0]=='\0' || !(cfg.hostname[0]>='a'&&cfg.hostname[0]<='z') && !(cfg.hostname[0]>='A'&&cfg.hostname[0]<='Z'))
      strncpy(cfg.hostname, "femto", sizeof(cfg.hostname)-1);
  }
  if (doc["powerHz"].is<int>())      cfg.powerHz  = doc["powerHz"].as<int>();
  if (doc["liveSegs"].is<int>()) {
    cfg.liveSegs = doc["liveSegs"].as<int>();
    if (cfg.liveSegs < 1) cfg.liveSegs = 1;
    if (cfg.liveSegs > 10) cfg.liveSegs = 10;
  }
  dspSetSampleRate((float)cfg.sampleRate);
  saveConfig();
  server.send(200,"application/json","{\"ok\":true}");
}

// ── 배경 PSD NVS 로드 (부팅 시) ──
void loadBgPsdFromNVS() {
  prefs.begin("femto_bg", true);  // read-only
  if (prefs.getBool("valid", false)) {
    // v0.8.1: blob 방식 우선 → 개별 키 폴백
    size_t len = prefs.getBytesLength("psd");
    if (len == 59 * sizeof(float)) {
      float buf[59];
      prefs.getBytes("psd", buf, len);
      int binMin = dspBinMin();
      for (int i = 0; i < 59; i++) dspBgPsd[i + binMin] = buf[i];
      dspBgSegs = 5;
      Serial.println("[NVS] bgPsd restored (blob 236B)");
    } else if (prefs.isKey("b6")) {
      // 개별 키 폴백 (v0.8.0 호환)
      for (int k = DSP_BIN_MIN; k <= DSP_BIN_MAX; k++) {
        char key[8]; snprintf(key, sizeof(key), "b%d", k);
        dspBgPsd[k] = prefs.getFloat(key, 0.0f);
      }
      dspBgSegs = 5;
      Serial.println("[NVS] bgPsd restored (legacy 59 keys)");
    }
  }
  prefs.end();
}

// bgPsd를 NVS에 blob으로 저장 (59 floats = 236 bytes = 1키)
void saveBgPsdToNVS() {
  float buf[59];
  int binMin = dspBinMin();
  for (int i = 0; i < 59; i++) buf[i] = dspBgPsd[i + binMin];
  prefs.begin("femto_bg", false);
  prefs.clear();  // 이전 개별 키 정리
  prefs.putBool("valid", true);
  prefs.putBytes("psd", buf, sizeof(buf));  // 236B = ~8 NVS 엔트리
  prefs.end();
  Serial.println("[NVS] bgPsd saved (blob 236B, 2 writes)");
}

// ── 배경 PSD API ──
void handleGetNoise() {
  JsonDocument doc;
  float freqRes = dspFreqRes();
  int binMin = dspBinMin();
  int binMax = dspBinMax();
  JsonArray bins = doc["bins"].to<JsonArray>();
  for (int k = binMin; k <= binMax; k++) {
    JsonObject b = bins.add<JsonObject>();
    b["f"] = k * freqRes;
    b["v"] = dspBgPsd[k];
  }
  doc["valid"] = (dspBgSegs > 0);
  doc["segs"] = dspBgSegs;
  doc["source"] = (dspBgSegs >= 5) ? "boot" : "none";
  sendJson(doc);
}

void handleLed() {
  if (!server.hasArg("plain")) { server.send(400,"text/plain","No body"); return; }
  JsonDocument doc;
  if (deserializeJson(doc,server.arg("plain"))) { server.send(400,"text/plain","JSON error"); return; }
  const char* st = doc["state"] | "off";
  if      (st=="on")    ledState=LED_ON;
  else if (st=="blink") ledState=LED_BLINK;
  else                  ledState=LED_OFF;
  server.send(200,"application/json","{\"ok\":true}");
}

void handleSaveResult() {
  if (!server.hasArg("plain")) { server.send(400,"text/plain","No body"); return; }
  JsonDocument doc;
  if (deserializeJson(doc,server.arg("plain"))) { server.send(400,"text/plain","JSON error"); return; }
  prefs.begin("femto_res",false);
  if (doc["freqX"].is<float>())        prefs.putFloat("freqX",      doc["freqX"]);
  if (doc["freqY"].is<float>())        prefs.putFloat("freqY",      doc["freqY"]);
  if (doc["shaperType"].is<const char*>())  prefs.putString("shaperType",doc["shaperType"].as<const char*>());
  if (doc["shaperTypeX"].is<const char*>()) prefs.putString("shaperTypeX",doc["shaperTypeX"].as<const char*>());
  if (doc["shaperTypeY"].is<const char*>()) prefs.putString("shaperTypeY",doc["shaperTypeY"].as<const char*>());
  if (doc["confidence"].is<float>())   prefs.putFloat("confidence", doc["confidence"]);
  prefs.putULong("savedAt",millis());
  prefs.end();
  server.send(200,"application/json","{\"ok\":true}");
}

void handleLoadResult() {
  JsonDocument doc;
  if (!prefs.begin("femto_res",true)) {
    prefs.end();
    doc["hasResult"]=false;doc["freqX"]=0;doc["freqY"]=0;doc["shaperType"]="";doc["confidence"]=0;
  } else {
    float freqX=prefs.getFloat("freqX",0), freqY=prefs.getFloat("freqY",0);
    char shType[16]=""; prefs.getString("shaperType",shType,sizeof(shType));
    char shTypeX[16]; prefs.getString("shaperTypeX",shTypeX,sizeof(shTypeX)); if(!shTypeX[0]) strncpy(shTypeX,shType,sizeof(shTypeX)-1);
    char shTypeY[16]; prefs.getString("shaperTypeY",shTypeY,sizeof(shTypeY)); if(!shTypeY[0]) strncpy(shTypeY,shType,sizeof(shTypeY)-1);
    float conf=prefs.getFloat("confidence",0);
    prefs.end();
    doc["freqX"]=freqX; doc["freqY"]=freqY;
    doc["shaperType"]=shType;
    doc["shaperTypeX"]=shTypeX; doc["shaperTypeY"]=shTypeY;
    doc["confidence"]=conf;
    doc["hasResult"]=(freqX>0&&freqY>0);
  }
  sendJson(doc);
}

void handleSaveBelt() {
  if (!server.hasArg("plain")) { server.send(400,"text/plain","No body"); return; }
  JsonDocument doc;
  if (deserializeJson(doc,server.arg("plain"))) { server.send(400,"text/plain","JSON error"); return; }
  prefs.begin("femto_belt",false);
  if (doc["freqA"].is<float>()) prefs.putFloat("freqA",doc["freqA"]);
  if (doc["freqB"].is<float>()) prefs.putFloat("freqB",doc["freqB"]);
  if (doc["delta"].is<float>()) prefs.putFloat("delta",doc["delta"]);
  prefs.end();
  server.send(200,"application/json","{\"ok\":true}");
}

void handleLoadBelt() {
  JsonDocument doc;
  if (!prefs.begin("femto_belt",true)) {
    prefs.end();
    doc["hasResult"]=false;doc["freqA"]=0;doc["freqB"]=0;doc["delta"]=0;
  } else {
    float freqA=prefs.getFloat("freqA",0), freqB=prefs.getFloat("freqB",0), delta=prefs.getFloat("delta",0);
    prefs.end();
    doc["freqA"]=freqA; doc["freqB"]=freqB; doc["delta"]=delta;
    doc["hasResult"]=(freqA>0&&freqB>0);
  }
  sendJson(doc);
}

void handleSaveDiag() {
  if (!server.hasArg("plain")) { server.send(400,"text/plain","No body"); return; }
  JsonDocument doc;
  if (deserializeJson(doc,server.arg("plain"))) { server.send(400,"text/plain","JSON error"); return; }
  prefs.begin("femto_diag",false);
  if (doc["belt_status"].is<const char*>()) prefs.putString("belt_st", doc["belt_status"].as<const char*>());
  if (doc["carriage_status"].is<const char*>()) prefs.putString("car_st", doc["carriage_status"].as<const char*>());
  if (doc["frame_status"].is<const char*>()) prefs.putString("frame_st", doc["frame_status"].as<const char*>());
  if (doc["symmetry_status"].is<const char*>()) prefs.putString("sym_st", doc["symmetry_status"].as<const char*>());
  if (doc["complexity"].is<int>())         prefs.putInt("complexity",   doc["complexity"]);
  prefs.end();
  server.send(200,"application/json","{\"ok\":true}");
}

void handleLoadDiag() {
  JsonDocument doc;
  if (!prefs.begin("femto_diag",true)) {
    prefs.end();
    doc["belt"]="";doc["carriage"]="";doc["frame"]="";doc["symmetry"]="";doc["complexity"]=0;doc["hasResult"]=false;
  } else {
    char belt[16]="",car[16]="",frm[16]="",sym[16]="";
    prefs.getString("belt_st",belt,sizeof(belt)); prefs.getString("car_st",car,sizeof(car));
    prefs.getString("frame_st",frm,sizeof(frm)); prefs.getString("sym_st",sym,sizeof(sym));
    int cplx=prefs.getInt("complexity",0);
    prefs.end();
    doc["belt_status"]=belt; doc["carriage_status"]=car;
    doc["frame_status"]=frm; doc["symmetry_status"]=sym;
    doc["complexity"]=cplx; doc["hasResult"]=(strlen(belt)>0);
  }
  sendJson(doc);
}

// ── AP 워치독 ────────────────────────────────────────
unsigned long lastApCheck = 0;
int apFailCount = 0;  // 3단계 복구용 카운터
static wifi_power_t txPower = WIFI_POWER_8_5dBm; // WiFi TX 파워 (전역 — 복구 시 재사용)

// ── 측정 상태 ────────────────────────────────────────
// [BUG-6 수정] 세그먼트 버퍼/오버랩 로직은 dsp.h의 dspFeed()로 캡슐화
// main.cpp는 샘플만 공급하면 됨
enum MeasState { MEAS_IDLE, MEAS_PRINT, MEAS_DONE };
static MeasState measState = MEAS_IDLE;

// v1.0: 라이브 = 공진 검출의 실시간 뷰
static WiFiClient liveSSEClient;
static bool  liveMode = false;
static int   liveSegReset = 0;

// v1.0: 결과 (듀얼 DSP에서 직접 사용)
static float peakFreqX = 0.0f, peakFreqY = 0.0f;
static float peakPowerX = 0.0f, peakPowerY = 0.0f;
static int   segCountX = 0, segCountY = 0;

// v1.0: 측정 PSD 백업 (라이브에 의한 오염 방지)
#define MEAS_BINS 59  // DSP_BIN_MIN(6) ~ DSP_BIN_MAX(64)
static float measPsdX[MEAS_BINS], measPsdY[MEAS_BINS];
static float measVarX[MEAS_BINS], measVarY[MEAS_BINS];
static bool  measPsdValid = false;

void saveMeasPsdToNVS() {
  prefs.begin("femto_mpsd", false);
  prefs.putBytes("px", measPsdX, sizeof(measPsdX));
  prefs.putBytes("py", measPsdY, sizeof(measPsdY));
  prefs.putBytes("vx", measVarX, sizeof(measVarX));
  prefs.putBytes("vy", measVarY, sizeof(measVarY));
  prefs.putBool("valid", true);
  prefs.end();
  Serial.println("[NVS] measPsd saved (944B)");
}

void loadMeasPsdFromNVS() {
  if (!prefs.begin("femto_mpsd", true)) { prefs.end(); return; }
  measPsdValid = prefs.getBool("valid", false);
  if (measPsdValid) {
    prefs.getBytes("px", measPsdX, sizeof(measPsdX));
    prefs.getBytes("py", measPsdY, sizeof(measPsdY));
    prefs.getBytes("vx", measVarX, sizeof(measVarX));
    prefs.getBytes("vy", measVarY, sizeof(measVarY));
    Serial.println("[NVS] measPsd restored");
  }
  prefs.end();
}

// ── GET /api/psd — PSD 데이터 + 피크 반환 ────────────
// axis 파라미터: ?axis=x → X 스냅샷, ?axis=y → 현재 PSD
// [Round 3] MEAS_DONE 후에만 호출 권장 (측정중 호출 시 FIFO 손실 가능)
void handleGetPsd() {
  const float freqRes = dspFreqRes();
  const int binMin = dspBinMin();
  const int binMax = dspBinMax();
  // v1.0: Print Measure 모드 — 백업 PSD 반환 (라이브 오염 방지)
  if (server.hasArg("mode") && strcmp(server.arg("mode").c_str(),"print")==0) {
    if (!measPsdValid) {
      server.send(200, "application/json", "{\"ok\":false,\"err\":\"no measurement data\"}");
      return;
    }
    JsonDocument doc;
    doc["ok"] = true;
    doc["mode"] = "print";
    doc["freqRes"] = freqRes;
    // X bins (백업)
    JsonArray bx = doc["binsX"].to<JsonArray>();
    for (int i=0; i<MEAS_BINS; i++) {
      JsonObject b = bx.add<JsonObject>();
      b["f"] = (i + binMin) * freqRes;
      b["v"] = measPsdX[i];
      b["var"] = measVarX[i];
    }
    // Y bins (백업)
    JsonArray by = doc["binsY"].to<JsonArray>();
    for (int i=0; i<MEAS_BINS; i++) {
      JsonObject b = by.add<JsonObject>();
      b["f"] = (i + binMin) * freqRes;
      b["v"] = measPsdY[i];
      b["var"] = measVarY[i];
    }
    // bgPsd
    if (dspBgSegs > 0) {
      JsonArray bg = doc["bgPsd"].to<JsonArray>();
      for (int k=binMin; k<=binMax; k++) bg.add(dspBgPsd[k]);
    }
    sendJson(doc);
    return;
  }

  // axis 파라미터 처리
  const char* axis = server.hasArg("axis") ? server.arg("axis").c_str() : "current";

DspStatus st = dspGetStatus();
  JsonDocument doc;
  doc["ok"]        = adxlOK;
  doc["segCount"]  = st.segCount;
  doc["peakFreq"]  = st.peakFreq;
  doc["peakPower"] = st.peakPower;
  doc["noiseFloor"]= st.noiseFloor;
  doc["snrDb"]     = st.snrDb;
  doc["confidence"]= st.confidence;
  doc["valid"]     = st.valid;
  doc["displayable"]= st.displayable;
  doc["freqRes"]   = freqRes;
  doc["measState"] = (measState == MEAS_PRINT) ? "print" :
                     (measState == MEAS_DONE) ? "done" : "idle";
  // PSD bins (18.75~200Hz) + v0.9 분산
  JsonArray bins = doc["bins"].to<JsonArray>();
  for (int k = binMin; k <= binMax; k++) {
    JsonObject b = bins.add<JsonObject>();
    b["f"] = k * freqRes;
    b["v"] = dspPsdAccum[k];
    b["var"] = dspPsdVar[k];  // v0.9: 세그먼트 간 분산
  }
  // peaks[] — dsp.h dspFindPeaks() 결과 직렬화 (diagnostic.js Stage 2 사용)
  JsonArray peaksArr = doc["peaks"].to<JsonArray>();
  for (int i = 0; i < st.peakCount; i++) {
    JsonObject pk = peaksArr.add<JsonObject>();
    pk["f"]    = st.peaks[i].freq;
    pk["v"]    = st.peaks[i].power;
    pk["prom"] = st.peaks[i].prominence;
  }
  // 배경 PSD (정지 구간 스냅샷 — JS에서 노이즈 차감용)
  if (dspBgSegs > 0) {
    JsonArray bg = doc["bgPsd"].to<JsonArray>();
    for (int k = binMin; k <= binMax; k++) {
      bg.add(dspBgPsd[k]);
    }
    doc["bgSegs"] = dspBgSegs;
  }
  sendJson(doc);
}

// ── POST /api/measure — 측정 제어 ──────────────────
// body: {"cmd":"print_start"|"print_stop"|"stop"|"reset"}
void handleMeasure() {
  if (!server.hasArg("plain")) { server.send(400,"text/plain","No body"); return; }
  JsonDocument req;
  if (deserializeJson(req, server.arg("plain"))) { server.send(400,"text/plain","JSON error"); return; }
  const char* cmd = req["cmd"] | "reset";

  JsonDocument res;

  if (strcmp(cmd,"print_start")==0) {
    // v1.0: 공진 검출 시작 — 듀얼 DSP
    if (!cfg.useCalWeights) {
      res["ok"] = false; res["error"] = "calibration_required";
      sendJson(res); return;
    }
    liveMode = false;  // 라이브 롤링 → 공진 검출 모드로 전환
    dspResetDual();
    measState = MEAS_PRINT;
    ledState  = LED_BLINK;
    res["ok"] = true; res["state"] = "print";
    Serial.println("[MEAS] 공진 검출 시작 (듀얼 DSP)");
  }
  else if (strcmp(cmd,"print_stop")==0) {
    // v1.0: 공진 검출 종료
    dspUpdateDual();
    // PSD 백업 (라이브 오염 방지)
    for (int k=DSP_BIN_MIN, i=0; k<=DSP_BIN_MAX; k++, i++) {
      measPsdX[i] = dspDualPsdX[k]; measPsdY[i] = dspDualPsdY[k];
      measVarX[i] = dspDualVarX[k]; measVarY[i] = dspDualVarY[k];
    }
    measPsdValid = true;
    saveMeasPsdToNVS();  // 재부팅 후에도 차트 복원
    float pkPwrX=0, pkPwrY=0;
    peakFreqX = dspDualFindPeak(dspDualPsdX, dspDualSegCountX(), &pkPwrX);
    peakFreqY = dspDualFindPeak(dspDualPsdY, dspDualSegCountY(), &pkPwrY);
    peakPowerX = pkPwrX; peakPowerY = pkPwrY;
    segCountX = dspDualSegCountX();
    segCountY = dspDualSegCountY();
    measState = MEAS_DONE;
    ledState  = LED_ON;
    res["ok"] = true; res["state"] = "done";
    res["peakX"] = peakFreqX; res["peakY"] = peakFreqY;
    res["segsX"] = segCountX; res["segsY"] = segCountY;
    res["segTotal"] = dspDualSegTotal();
    res["gateRatio"] = dspDualGateRatio();
    res["correlation"] = dspDualCorrelation();
    res["convergenceX"] = dspDualConvergence('x');
    res["convergenceY"] = dspDualConvergence('y');
    res["sweepDetected"] = true;
    Serial.printf("[MEAS] 공진 검출 완료 (X:%.1fHz/%d Y:%.1fHz/%d gate:%.0f%% corr:%.0f%%)\n",
      peakFreqX, segCountX, peakFreqY, segCountY,
      dspDualGateRatio()*100, dspDualCorrelation()*100);
  }
  else if (strcmp(cmd,"stop")==0) {
    // 범용 중지 (공진 검출 또는 아무 상태)
    if (measState == MEAS_PRINT) {
      // print_stop과 동일 처리
      dspUpdateDual();
      float pkPwrX=0, pkPwrY=0;
      peakFreqX = dspDualFindPeak(dspDualPsdX, dspDualSegCountX(), &pkPwrX);
      peakFreqY = dspDualFindPeak(dspDualPsdY, dspDualSegCountY(), &pkPwrY);
      peakPowerX = pkPwrX; peakPowerY = pkPwrY;
      segCountX = dspDualSegCountX(); segCountY = dspDualSegCountY();
    }
    measState = MEAS_DONE;
    ledState  = LED_ON;
    res["ok"] = true; res["state"] = "done";
    res["peakX"] = peakFreqX; res["peakY"] = peakFreqY;
    res["segsX"] = segCountX; res["segsY"] = segCountY;
  }
  else {  // reset
    dspReset();
    dspResetDual();
    measState = MEAS_IDLE;
    ledState  = LED_OFF;
    res["ok"] = true; res["state"] = "idle";
  }

  sendJson(res);
}


// ── GET /api/measure/status — 현재 측정 상태 ─────────
void handleMeasStatus() {
  JsonDocument doc;
  // v1.0: 3상태 (IDLE=0, PRINT=1, DONE=2)
  const char* stStr[] = {"idle","print","done"};
  doc["state"]       = stStr[measState];
  doc["measState"]   = stStr[measState];
  // Print Measure 모드일 때 듀얼 세그먼트 수 반환
  if (measState == MEAS_PRINT) {
    doc["segCount"]  = dspDualSegCountY();
    doc["segCountX"] = dspDualSegCountX();
    doc["segCountY"] = dspDualSegCountY();
    doc["segTotal"]  = dspDualSegTotal();
    doc["gateRatio"] = dspDualGateRatio();
    doc["correlation"] = dspDualCorrelation();
    doc["convergenceX"] = dspDualConvergence('x');
    doc["convergenceY"] = dspDualConvergence('y');
    doc["displayable"] = (dspDualSegCountY() >= 3);
    doc["valid"]     = (dspDualSegCountX() >= 50);
    doc["autoReady"] = dspDualAutoReady();
  } else {
    doc["segCount"]  = dspSegCount;
    doc["displayable"] = (dspSegCount >= 3);
    doc["valid"]     = (dspSegCount >= 10);
  }
  doc["peakFreqX"]   = peakFreqX;
  doc["peakFreqY"]   = peakFreqY;
  doc["axesMap"]     = cfg.axesMap;
  // SNR
  DspStatus st = dspGetStatus();
  if (st.segCount > 0 && st.peakPower > 0) {
    float noise = 0; int nc = 0;
    for (int k = dspBinMin(); k <= dspBinMax(); k++) {
      if (abs(k * dspFreqRes() - st.peakFreq) > 15) { noise += dspPsdAccum[k]; nc++; }
    }
    if (nc > 0 && noise/nc > 0) doc["snrDb"] = 10.0f * log10f(st.peakPower / (noise/nc));
  }
  sendJson(doc);
}

// ── 딥슬립 설정 ─────────────────────────────────────
// deep sleep timeout
#define DEEP_SLEEP_TIMEOUT_MS  (5 * 60 * 1000)  // 5분 무활동 → 딥슬립
static unsigned long lastActivityMs = 0;

// ── setup ────────────────────────────────────────────
// v0.9: 라이브 SSE 스트리밍 — 실시간 FFT PSD
void handleLiveStream() {
  WiFiClient client = server.client();
  client.println("HTTP/1.1 200 OK");
  client.println("Content-Type: text/event-stream");
  client.println("Cache-Control: no-cache");
  client.println("Connection: keep-alive");
  client.println("Access-Control-Allow-Origin: *");
  client.println();
  liveSSEClient = client;
  liveMode = true;
  dspReset();
  
  liveSegReset = 0;
  Serial.println("[LIVE] SSE stream started");
}

void handleLiveStop() {
  liveMode = false;
  if (liveSSEClient.connected()) liveSSEClient.stop();
  server.send(200, "application/json", "{\"ok\":true}");
  Serial.println("[LIVE] SSE stream stopped");
}

void handleLiveAxis() {
  if (!server.hasArg("plain")) { server.send(400,"text/plain","No body"); return; }
  JsonDocument req;
  if (deserializeJson(req, server.arg("plain"))) { server.send(400,"text/plain","JSON"); return; }
  const char* ax = req["axis"] | "a";
  // PSD 리셋 → 새 축으로 다시 축적
  if (liveMode) { dspReset(); }
  server.send(200, "application/json", "{\"ok\":true}");
}

// v0.9: WiFi 스캔
void handleWifiScan() {
  int n = WiFi.scanNetworks(false, false, false, 300);
  JsonDocument doc;
  JsonArray nets = doc["networks"].to<JsonArray>();
  for (int i = 0; i < n && i < 20; i++) {
    JsonObject net = nets.add<JsonObject>();
    net["ssid"] = WiFi.SSID(i);
    net["rssi"] = WiFi.RSSI(i);
    net["enc"]  = WiFi.encryptionType(i) != WIFI_AUTH_OPEN;
  }
  doc["count"] = n;
  sendJson(doc);
  WiFi.scanDelete();
}

void setup() {
  Serial.begin(115200);
  // USB CDC 연결 대기 (최대 3초 — 연결 안 돼도 진행)
  unsigned long waitStart = millis();
  while (!Serial && (millis() - waitStart < 3000)) { delay(10); }
  delay(200);

  // 딥슬립 웨이크업 원인 확인
  esp_sleep_wakeup_cause_t wakeup = esp_sleep_get_wakeup_cause();
  if (wakeup == ESP_SLEEP_WAKEUP_GPIO) {
    Serial.println("[WAKE] GPIO 웨이크업 (택트스위치)");
  } else if (wakeup != ESP_SLEEP_WAKEUP_UNDEFINED) {
    Serial.printf("[WAKE] 원인: %d\n", wakeup);
  }

  lastActivityMs = millis();

  Serial.println("=== FEMTO SHAPER v0.9 ===");

  if (!LittleFS.begin(true)) { Serial.println("[ERROR] LittleFS FAIL"); return; }
  File root = LittleFS.open("/");
  File f = root.openNextFile();
  while (f) { Serial.printf("  %s (%dB)\n",f.name(),f.size()); f=root.openNextFile(); }

  loadConfig();  // NVS 설정 로드 — GPIO 초기화 전에 필수

  // GPIO 초기화 (loadConfig 이후 — NVS 핀 설정 반영)
  pinMode(cfg.pinLED, OUTPUT);
  digitalWrite(cfg.pinLED, HIGH);  // OFF
  pinMode(cfg.pinReset, INPUT_PULLUP); // reset button

  adxlOK = adxlInit();
  Serial.printf("[ADXL] %s\n", adxlOK ? "OK" : "FAIL");

  // 배경 PSD: NVS 폴백 로드 (loop에서 부팅 캡처 후 갱신)
  // v0.8 마이그레이션: 이전 513빈 bgPsd 정리
  {
    prefs.begin("femto_bg", true);  // read-only 확인
    bool hasLegacy = prefs.isKey("b0");
    prefs.end();
    if (hasLegacy) {
      prefs.begin("femto_bg", false);  // write 모드 — 정리 필요할 때만
      prefs.clear();
      prefs.end();
      Serial.println("[NVS] Cleared legacy 513-bin bgPsd");
    }
  }
  loadBgPsdFromNVS();
  loadMeasPsdFromNVS();  // v1.0: 측정 PSD 복원 (재부팅 후 차트 유지)

  // ── WiFi 초기화 (AP / STA 모드 지원) ──
  WiFi.mode(WIFI_OFF);
  delay(100);
  WiFi.disconnect(true);
  WiFi.softAPdisconnect(true);
  delay(100);

  int8_t txPowerLevel = cfg.txPower;
  switch(txPowerLevel) {
    case 2:  txPower = WIFI_POWER_2dBm;    break;
    case 5:  txPower = WIFI_POWER_5dBm;    break;
    case 8:  txPower = WIFI_POWER_8_5dBm;  break;
    case 11: txPower = WIFI_POWER_11dBm;   break;
    case 15: txPower = WIFI_POWER_15dBm;   break;
    case 20: txPower = WIFI_POWER_19_5dBm; break;
    default: txPower = WIFI_POWER_8_5dBm;
  }

  bool staConnected = false;

  // STA 모드 시도
  if (strcmp(cfg.wifiMode,"sta")==0 && strlen(cfg.staSSID) > 0) {
    Serial.printf("[WiFi] STA mode — connecting to '%s'...\n", cfg.staSSID);
    WiFi.mode(WIFI_STA);
    WiFi.setHostname(cfg.hostname);  // v1.0: mDNS 호스트명
    WiFi.setTxPower(txPower);
    WiFi.begin(cfg.staSSID, cfg.staPass);

    // 최대 15초 대기
    int wait = 0;
    while (WiFi.status() != WL_CONNECTED && wait < 30) {
      delay(500);
      Serial.print(".");
      wait++;
    }
    Serial.println();

    if (WiFi.status() == WL_CONNECTED) {
      staConnected = true;
      Serial.printf("[WiFi] STA connected! IP: %s (Heap: %u)\n",
        WiFi.localIP().toString().c_str(), ESP.getFreeHeap());
    } else {
      Serial.println("[WiFi] STA failed — fallback to AP mode");
      WiFi.disconnect(true);
      delay(100);
    }
  }

  // AP 모드 (기본 또는 STA 실패 시 폴백)
  if (!staConnected) {
    WiFi.mode(WIFI_AP);
    delay(200);
    WiFi.setTxPower(txPower);
    WiFi.softAPConfig(AP_IP, AP_IP, IPAddress(255,255,255,0));

    bool apStarted = false;
    for (int attempt = 1; attempt <= 3; attempt++) {
      WiFi.softAP(AP_SSID, nullptr, 1, 0, 4);
      delay(200 + attempt * 100);
      if (WiFi.softAPIP() != IPAddress(0,0,0,0)) {
        apStarted = true;
        break;
      }
      Serial.printf("[WiFi] AP start failed — retry %d/3\n", attempt);
      WiFi.softAPdisconnect(true);
      delay(200);
    }

    Serial.printf("[WiFi] AP: %s @ %s (TX: %ddBm) Heap: %u\n",
      AP_SSID, WiFi.softAPIP().toString().c_str(), txPowerLevel, ESP.getFreeHeap());

    if (!apStarted) {
      Serial.println("[WiFi] AP failed — reboot in 5s");
      delay(5000);
      ESP.restart();
    }
  }

  // DNS 서버 (AP 모드에서만 — 캡티브 포털)
  if (!staConnected) {
    dnsServer.start(53, "*", AP_IP);
    Serial.println("[DNS] 캡티브 포털 시작");
  }

  // mDNS: hostname.local 접속 지원 (STA 모드에서만 유의미)
  if (staConnected) {
    esp_log_level_set("WiFiUdp", ESP_LOG_NONE);
    if (MDNS.begin(cfg.hostname)) {
      MDNS.addService("http", "tcp", 80);
      Serial.printf("[mDNS] http://%s.local\n", cfg.hostname);
    } else {
      Serial.println("[mDNS] FAILED");
    }
  }

  const char* JS="application/javascript", *CSS="text/css";
  server.on("/",              []()        { serveFile("/index.html",    "text/html"); });
  server.on("/index.html",    []()        { serveFile("/index.html",    "text/html"); });
  server.on("/style.css",     [CSS=CSS]() { serveFile("/style.css",     CSS); });
  server.on("/i18n.js",       [JS=JS]()   { serveFile("/i18n.js",       JS); });
  server.on("/led.js",        [JS=JS]()   { serveFile("/led.js",        JS); });
  server.on("/shaper.js",     [JS=JS]()   { serveFile("/shaper.js",     JS); });
  server.on("/kinematics.js", [JS=JS]()   { serveFile("/kinematics.js", JS); });
  server.on("/charts.js",     [JS=JS]()   { serveFile("/charts.js",     JS); });
  server.on("/chart.min.js",  [JS=JS]()   { serveFile("/chart.min.js",  JS); });
  server.on("/filter.js",     [JS=JS]()   { serveFile("/filter.js",     JS); });
  server.on("/measure.js",    [JS=JS]()   { serveFile("/measure.js",    JS); });
  server.on("/live.js",       [JS=JS]()   { serveFile("/live.js",        JS); });
  server.on("/validator.js",  [JS=JS]()   { serveFile("/validator.js",  JS); });
  server.on("/diagnostic.js", [JS=JS]()   { serveFile("/diagnostic.js", JS); });
  server.on("/settings.js",   [JS=JS]()   { serveFile("/settings.js",   JS); });
  server.on("/app.js",        [JS=JS]()   { serveFile("/app.js",        JS); });
  server.on("/report.js",     [JS=JS]()   { serveFile("/report.js",     JS); });
  // adxl_test.js: 디버그 전용, v0.8에서 제거

  server.on("/api/config",      HTTP_GET,  handleGetConfig);
  server.on("/api/noise",       HTTP_GET,  handleGetNoise);
  server.on("/api/config",      HTTP_POST, handlePostConfig);
  server.on("/api/debug",       HTTP_GET,  handleDebugGet);
  server.on("/api/debug",       HTTP_POST, handleDebugPost);
  server.on("/api/led",         HTTP_POST, handleLed);
  server.on("/api/result",      HTTP_GET,  handleLoadResult);
  server.on("/api/result",      HTTP_POST, handleSaveResult);
  server.on("/api/belt",        HTTP_GET,  handleLoadBelt);
  server.on("/api/belt",        HTTP_POST, handleSaveBelt);
  server.on("/api/diag",        HTTP_GET,  handleLoadDiag);
  server.on("/api/diag",        HTTP_POST, handleSaveDiag);
  server.on("/api/adxl/status", HTTP_GET,  handleAdxlStatus);
  server.on("/api/adxl/raw",    HTTP_GET,  handleAdxlRaw);
  server.on("/api/adxl/rate",   HTTP_GET,  handleAdxlRate);
  server.on("/api/adxl/rate",   HTTP_POST, handleAdxlRate);
  server.on("/api/adxl/fifo",   HTTP_GET,  handleAdxlFifo);
  server.on("/api/psd",            HTTP_GET,  handleGetPsd);
  server.on("/api/measure",        HTTP_POST, handleMeasure);
  server.on("/api/measure/status", HTTP_GET,  handleMeasStatus);
  server.on("/api/live/stream",    HTTP_GET,  handleLiveStream);
  server.on("/api/live/stop",      HTTP_POST, handleLiveStop);
  server.on("/api/live/axis",      HTTP_POST, handleLiveAxis);
  server.on("/api/wifi/scan",      HTTP_GET,  handleWifiScan);
  server.on("/api/reboot",         HTTP_POST, []() {
    server.send(200, "application/json", "{\"ok\":true}");
    delay(500);
    ESP.restart();
  });
  server.on("/favicon.ico", []() { server.send(204,"text/plain",""); });

  // ── 캡티브 포털 엔드포인트 ─────────────────────────
  // Android/iOS/Windows/Firefox 전 플랫폼 감지 엔드포인트
  // 모두 302 리다이렉트 → 캡티브 포털 자동 팝업
  auto redirectToPortal = []() {
    { char loc[40]; snprintf(loc,sizeof(loc),"http://%s",AP_IP.toString().c_str()); server.sendHeader("Location",loc,true); }
    server.sendHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    server.send(302, "text/plain", "");
  };
  // Android
  server.on("/generate_204", redirectToPortal);
  server.on("/gen_204",      redirectToPortal);
  // iOS / macOS
  server.on("/hotspot-detect.html", redirectToPortal);
  server.on("/library/test/success.html", redirectToPortal);
  // Windows
  server.on("/connecttest.txt", redirectToPortal);
  server.on("/ncsi.txt",       redirectToPortal);
  server.on("/redirect",       redirectToPortal);
  // Firefox
  server.on("/canonical.html", redirectToPortal);
  server.on("/success.txt",    []() {
    server.sendHeader("Cache-Control", "no-cache");
    server.send(200, "text/plain", "success");  // Firefox 전용 응답
  });
  // 미등록 URL → index.html (SPA 라우팅 + 캡티브 포털 폴백)
  server.onNotFound([]() {
    serveFile("/index.html", "text/html");
  });

  server.begin();
  Serial.println("[HTTP] 시작 — http://192.168.4.1");
}

// ── loop ─────────────────────────────────────────────
static const int BOOT_NOISE_TARGET = 1024 + 9 * DSP_STEP; // 10 segments ≈ 0.8s

void loop() {
  dnsServer.processNextRequest();  // 캡티브 포털 DNS
  server.handleClient();

  if (adxlOK) {
    adxlUpdate();

    // ── 부팅 배경 PSD 캡처 (비동기, WiFi와 병렬) ──
    if (!bootNoiseDone && measState == MEAS_IDLE) {
      // 첫 진입 시 초기화
      if (bootNoiseSamples == 0) {
        dspBgSegs = 0;           // NVS 로드값 무효화 → 새 캡처 허용
        dspReset();
        
      }
      while (adxlCount > 0 && bootNoiseSamples < BOOT_NOISE_TARGET) {
        AdxlSample s = adxlBuf[adxlHead];
        adxlHead  = (adxlHead + 1) % ADXL_BUF_SIZE;
        adxlCount--;
        // v0.9: 캘리브레이션 가중치 적용 (측정과 동일 스케일)
        int16_t val;
        if (cfg.useCalWeights) {
          val = (int16_t)(cfg.calWx[0]*s.x + cfg.calWx[1]*s.y + cfg.calWx[2]*s.z);
        } else {
          val = s.x;
        }
        dspFeed(val);
        bootNoiseSamples++;
      }
      if (bootNoiseSamples >= BOOT_NOISE_TARGET || millis() > 10000) {
        bootNoiseDone = true;
        if (dspBgSegs > 0) {
          // v0.9: 자기일관성 체크 — 전반(seg 1-5) vs 후반(seg 6-10) 에너지 비교
          // dspBgPsd = seg 1-5 평균 (dsp.h에서 seg 5 시점 캡처)
          // _psdSum/10 = seg 1-10 전체 평균
          // 후반 평균 = (전체*10 - 전반*5) / 5
          float eFirst = 0, eSecond = 0;
          for (int k = DSP_BIN_MIN; k <= DSP_BIN_MAX; k++) {
            float totalAvg = _psdSum[k] / (float)_segCount;
            float firstAvg = dspBgPsd[k];
            float secondAvg = (_segCount >= 10)
              ? (totalAvg * _segCount - firstAvg * 5.0f) / (_segCount - 5.0f)
              : firstAvg;
            eFirst += firstAvg;
            eSecond += secondAvg;
          }
          float ratio = (eFirst > 0.001f) ? eSecond / eFirst : 1.0f;
          bool consistent = (ratio > 0.5f && ratio < 2.0f);

          if (consistent) {
            // 일관적 → 전체 평균을 최종 bgPsd로 사용 (더 정밀)
            dspUpdateAccum();
            for (int k = dspBinMin(); k <= dspBinMax(); k++)
              dspBgPsd[k] = dspPsdAccum[k];
            saveBgPsdToNVS();
            Serial.printf("[BOOT] bgPsd OK (ratio=%.2f, %d samples)\n", ratio, bootNoiseSamples);
          } else {
            // 비일관적 → WiFi 스파이크 등 오염 가능성 → NVS 폴백
            loadBgPsdFromNVS();
            Serial.printf("[BOOT] bgPsd inconsistent (ratio=%.2f) → NVS fallback\n", ratio);
          }
        } else {
          // 캡처 실패 → NVS 폴백 복원
          loadBgPsdFromNVS();
          Serial.println("[BOOT] Capture failed — NVS fallback restored");
        }
        // v0.9: 배경 에너지 계산 → 스윕 감지 threshold 기준
        dspBgEnergy = 0;
        for (int k = dspBinMin(); k <= dspBinMax(); k++) dspBgEnergy += dspBgPsd[k];
        if (dspBgEnergy < 50.0f) dspBgEnergy = 50.0f;
        Serial.printf("[BOOT] bgEnergy=%.0f → sweep threshold base\n", dspBgEnergy);
        dspReset();  // sweepDetect 다시 ON으로 복원
      }
    }

    // v1.0: Print Measure — 듀얼 DSP
    else if (measState == MEAS_PRINT) {
      const float scale = 0.0039f * 9.80665f;  // raw → m/s²
      while (adxlCount > 0) {
        AdxlSample s = adxlBuf[adxlHead];
        adxlHead  = (adxlHead + 1) % ADXL_BUF_SIZE;
        adxlCount--;
        float ax = s.x * scale, ay = s.y * scale, az = s.z * scale;
        float projX = cfg.calWx[0]*ax + cfg.calWx[1]*ay + cfg.calWx[2]*az;
        float projY = cfg.calWy[0]*ax + cfg.calWy[1]*ay + cfg.calWy[2]*az;
        dspFeedDual(projX, projY);
      }
      // SSE: 듀얼 세그먼트 완료 시 진행 상태 전송
      if (dspDualNewSeg) {
        dspDualNewSeg = false;
        if (liveSSEClient.connected()) {
          dspUpdateDual();
          char buf[2048];  // 59빈×2축×8B = ~1000B + 여유
          int len = snprintf(buf, sizeof(buf),
            "data: {\"m\":\"print\",\"sx\":%d,\"sy\":%d,\"st\":%d,\"gr\":%.2f,\"bx\":[",
            dspDualSegCountX(), dspDualSegCountY(), dspDualSegTotal(), dspDualGateRatio());
          int binMin = dspBinMin();
          int binMax = dspBinMax();
          for (int k=binMin; k<=binMax; k++) {
            if (k>binMin) buf[len++]=',';
            float v = dspDualPsdX[k];
            if (v<0.01f) { buf[len++]='0'; }
            else if (v>=100) len+=snprintf(buf+len,sizeof(buf)-len,"%.0f",v);
            else if (v>=1) len+=snprintf(buf+len,sizeof(buf)-len,"%.1f",v);
            else len+=snprintf(buf+len,sizeof(buf)-len,"%.2f",v);
          }
          len += snprintf(buf+len, sizeof(buf)-len, "],\"by\":[");
          for (int k=binMin; k<=binMax; k++) {
            if (k>binMin) buf[len++]=',';
            float v = dspDualPsdY[k];
            if (v<0.01f) { buf[len++]='0'; }
            else if (v>=100) len+=snprintf(buf+len,sizeof(buf)-len,"%.0f",v);
            else if (v>=1) len+=snprintf(buf+len,sizeof(buf)-len,"%.1f",v);
            else len+=snprintf(buf+len,sizeof(buf)-len,"%.2f",v);
          }
          len += snprintf(buf+len, sizeof(buf)-len,
            "],\"co\":%.2f,\"cx\":%.1f,\"cy\":%.1f,\"ar\":%d}\n\n",
            dspDualCorrelation(), dspDualConvergence('x'), dspDualConvergence('y'),
            dspDualAutoReady() ? 1 : 0);
          liveSSEClient.write((uint8_t*)buf, len);
        }
      }
    } else {
      // IDLE/DONE
      if (liveMode && (measState == MEAS_IDLE || measState == MEAS_DONE)) {
        // v1.0: 라이브 = 듀얼 DSP 롤링 모드
        const float scale = 0.0039f * 9.80665f;
        while (adxlCount > 0) {
          AdxlSample s = adxlBuf[adxlHead];
          adxlHead = (adxlHead + 1) % ADXL_BUF_SIZE;
          adxlCount--;
          float ax = s.x * scale, ay = s.y * scale, az = s.z * scale;
          float projX, projY;
          if (cfg.useCalWeights) {
            projX = cfg.calWx[0]*ax + cfg.calWx[1]*ay + cfg.calWx[2]*az;
            projY = cfg.calWy[0]*ax + cfg.calWy[1]*ay + cfg.calWy[2]*az;
          } else {
            projX = ax; projY = ay;  // 미캘리브레이션 폴백
          }
          dspFeedDual(projX, projY);
        }
        // cfg.liveSegs 세그마다 SSE 전송, 30세그마다 롤링 리셋
        int segNow = dspDualSegTotal();
        if (segNow - liveSegReset >= cfg.liveSegs) {
          liveSegReset = segNow;
          dspUpdateDual();
          // SSE: 듀얼 PSD 전송
          if (liveSSEClient.connected()) {
            char buf[2048];
            int len = snprintf(buf, sizeof(buf),
              "data: {\"m\":\"live\",\"sx\":%d,\"bx\":[",
              dspDualSegTotal());
            int binMin = dspBinMin();
            int binMax = dspBinMax();
            for (int k=binMin; k<=binMax; k++) {
              if (k>binMin) buf[len++]=',';
              float v = dspDualPsdX[k];
              if (v<0.01f) { buf[len++]='0'; }
              else if (v>=100) len+=snprintf(buf+len,sizeof(buf)-len,"%.0f",v);
              else if (v>=1) len+=snprintf(buf+len,sizeof(buf)-len,"%.1f",v);
              else len+=snprintf(buf+len,sizeof(buf)-len,"%.2f",v);
            }
            len += snprintf(buf+len, sizeof(buf)-len, "],\"by\":[");
            for (int k=binMin; k<=binMax; k++) {
              if (k>binMin) buf[len++]=',';
              float v = dspDualPsdY[k];
              if (v<0.01f) { buf[len++]='0'; }
              else if (v>=100) len+=snprintf(buf+len,sizeof(buf)-len,"%.0f",v);
              else if (v>=1) len+=snprintf(buf+len,sizeof(buf)-len,"%.1f",v);
              else len+=snprintf(buf+len,sizeof(buf)-len,"%.2f",v);
            }
            float pkX = dspDualFindPeak(dspDualPsdX, 1, NULL);
            float pkY = dspDualFindPeak(dspDualPsdY, 1, NULL);
            len += snprintf(buf+len, sizeof(buf)-len,
              "],\"pkx\":%.1f,\"pky\":%.1f}\n\n", pkX, pkY);
            liveSSEClient.write((uint8_t*)buf, len);
          }
          // 30세그마다 롤링 리셋 (PSD 신선도 유지)
          if (segNow >= 30) {
            dspResetDual();
            liveSegReset = 0;
          }
          if (!liveSSEClient.connected()) { liveMode = false; }
        }
      } else {
        // 비라이브: 버퍼 오버플로 방지
        if (adxlCount > 32) {
          uint8_t drop = adxlCount - 4;
          adxlHead = (adxlHead + drop) % ADXL_BUF_SIZE;
          adxlCount -= drop;
        }
      }
    }
  }

  // ── 3단계 AP 자동복구 + 힙 모니터링 ────────────────
  if (millis() - lastApCheck > 30000) {
    lastApCheck = millis();

    // 힙 사용량 체크 — 40KB 이하면 WiFi 불안정 위험
    uint32_t freeHeap = ESP.getFreeHeap();
    if (freeHeap < 40000) {
      Serial.printf("[HEAP] 위험: %u bytes — WiFi 불안정 가능\n", freeHeap);
      // 힙 부족 시 측정 중이 아니면 리부팅 고려
      if (measState == MEAS_IDLE || measState == MEAS_DONE) {
        if (freeHeap < 20000) {
          Serial.println("[HEAP] 치명적 — 리부팅");
          ESP.restart();
        }
      }
    }

    // WiFi 상태 확인 + 복구
    if (WiFi.status() == WL_CONNECTED) {
      // STA 연결 정상
      apFailCount = 0;
    } else if (strcmp(cfg.wifiMode,"sta")==0 && WiFi.status() != WL_CONNECTED) {
      // STA 연결 끊김 → 재연결 시도
      apFailCount++;
      Serial.printf("[WiFi] STA reconnect %d/3\n", apFailCount);
      if (apFailCount <= 2) {
        WiFi.reconnect();
      } else {
        Serial.println("[WiFi] STA failed — fallback to AP");
        WiFi.disconnect(true);
        delay(100);
        WiFi.mode(WIFI_AP);
        delay(200);
        WiFi.setTxPower(txPower);
        WiFi.softAPConfig(AP_IP, AP_IP, IPAddress(255,255,255,0));
        WiFi.softAP(AP_SSID, nullptr, 1, 0, 4);
        dnsServer.start(53, "*", AP_IP);
        apFailCount = 0;
      }
    } else if (WiFi.softAPIP() == IPAddress(0,0,0,0)) {
      apFailCount++;
      Serial.printf("[WiFi] AP 복구 %d/3 (heap: %u)\n", apFailCount, freeHeap);
      if (apFailCount <= 1) {
        WiFi.softAP(AP_SSID, nullptr, 1, 0, 4);
      } else if (apFailCount <= 2) {
        WiFi.mode(WIFI_OFF);
        delay(500);
        WiFi.disconnect(true);
        WiFi.softAPdisconnect(true);
        delay(200);
        WiFi.mode(WIFI_AP);
        delay(200);
        WiFi.setTxPower(txPower); // NVS 설정값 유지
        WiFi.softAPConfig(AP_IP, AP_IP, IPAddress(255,255,255,0));
        WiFi.softAP(AP_SSID, nullptr, 1, 0, 4);
        dnsServer.start(53, "*", AP_IP);
      } else {
        Serial.println("[WiFi] Stage 3 — 리부팅");
        ESP.restart();
      }
    } else {
      apFailCount = 0;
    }
  }

  if (ledState != LED_BLINK)
    ledState = WiFi.softAPgetStationNum() > 0 ? LED_ON : LED_OFF;
  updateLed();

  // ── GPIO10 리셋 버튼 ──
  if (digitalRead(cfg.pinReset) == LOW) {
    delay(50);  // 디바운스
    if (digitalRead(cfg.pinReset) == LOW) {
      Serial.println("[RESET] Button pressed");
      delay(100);
      ESP.restart();
    }
  }

  // ── 딥슬립 (5분 무활동) ──
  // 클라이언트 접속 중이면 타이머 리셋
  if (WiFi.softAPgetStationNum() > 0 || measState != MEAS_IDLE) {
    lastActivityMs = millis();
  }
  // 무활동 5분 → 딥슬립 진입
  if (millis() - lastActivityMs > DEEP_SLEEP_TIMEOUT_MS) {
    Serial.println("[SLEEP] 5min idle → deep sleep (press reset to wake)");
    WiFi.mode(WIFI_OFF);
    delay(100);
    esp_deep_sleep_enable_gpio_wakeup(1ULL << cfg.pinReset, ESP_GPIO_WAKEUP_GPIO_LOW);
    esp_deep_sleep_start();
  }
}
