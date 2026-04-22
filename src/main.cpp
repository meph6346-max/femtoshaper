// ============================================================
// FEMTO SHAPER ESP32-C3 Firmware
// Key design notes:
// 1. CS pinMode set before SPI.begin() (ordering matters for reliability)
// 2. FIFO in stream mode, not bypass (drops fewer samples at high rates)
// 3. GPIO0 INT1: INPUT_PULLUP on the pin, rising-edge ISR
// 4. adxl_test.js removed (diagnostic helper no longer shipped)
// 5. Dropped handleSaveBelt/LoadBelt (belt-tension feature retired)
// 6. adxlFifoReady ISR flag is polled from loop() (keeps ISR tiny)
// 7. INT_SOURCE register is cleared inside the ISR
// Pin mapping (ADXL345):
//   SCL -> GPIO4 (SCK)
//   SDO -> GPIO2 (MISO)
//   SDA -> GPIO3 (MOSI)
//   CS  -> GPIO1
//   INT1 -> GPIO0
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

// Reusable JSON serialisation buffer (avoids heap churn on every response).
// 32 KB covers the worst case: /api/psd?mode=print at cfg.sampleRate=400 has
// 465 bins per axis with objects like `{"f":18.75,"v":0.01,"var":0.0}` (~30 B
// each), so binsX + binsY + jerkX + jerkY + bgPsd can total ~35 KB-equivalent
// before ArduinoJson compression. The old 8 KB sized for the 3200Hz-only case
// (59 bins/axis) and made the PSD endpoint 507-fail at every non-default rate.
// ESP32-C3 has 400 KB of DRAM; 32 KB static is trivially affordable.
static char _jbuf[32768];
// Shared SSE payload buffer - moved off the loop task stack (default 8KB)
// because two char[8192] locals in loop() left no margin for call frames and
// risked silent stack overflow. See BF-R14-001.
static char _sseBuf[8192];
inline void sendJson(JsonDocument& doc) {
  // R32: measureJson() predicts length before serializing to prevent truncation
  size_t need = measureJson(doc);
  if (need + 1 >= sizeof(_jbuf)) {
    Serial.printf("[JSON] Response too large: %u > %u\n", (unsigned)need, (unsigned)sizeof(_jbuf));
    server.send(507, "application/json", "{\"ok\":false,\"err\":\"JSON_too_large\"}");
    return;
  }
  size_t len = serializeJson(doc, _jbuf, sizeof(_jbuf));
  if (len == 0 || len >= sizeof(_jbuf)) {
    server.send(500, "application/json", "{\"ok\":false,\"err\":\"JSON_serialize_failed\"}");
    return;
  }
  server.send(200, "application/json", _jbuf);
}

// R25: POST body size limit (DoS prevention). All handlePost* handlers call this.
static bool checkBodyLimit(size_t maxBytes = 8192) {
  if (!server.hasArg("plain")) return false;
  if ((size_t)server.arg("plain").length() > maxBytes) {
    server.send(413, "application/json", "{\"ok\":false,\"error\":\"body_too_large\"}");
    return false;
  }
  return true;
}
DNSServer   dnsServer;
Preferences prefs;

// ============ Config (persisted in NVS, loaded at boot) ============
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
  // Calibration weights: project raw ADXL axes onto the printer's X/Y
  // motion axes.
  // printerX = calWx[0]*ax + calWx[1]*ay + calWx[2]*az
  float  calWx[3] = {1, 0, 0};  // default: ADXL X == printer X
  float  calWy[3] = {0, 1, 0};  // default: ADXL Y == printer Y
  bool   useCalWeights = false;
  // WiFi STA credentials (used when wifiMode == "sta").
  char wifiMode[8] = "ap";
  char staSSID[33] = "";
  char staPass[65] = "";
  char hostname[32] = "femto";  // mDNS name (resolves as <hostname>.local)
  int    powerHz  = 60;  // mains notch filter frequency (60/50/0 = off)
  int    liveSegs = 2;   // live-mode SSE segment interval before publishing
} cfg;

// ============ LED (Active Low, GPIO8 = BUILTIN LED) ============
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

// ============================================================
// ADXL345 driver
// ============================================================

// ============ SPI pin defines ============
#define ADXL_SCK   4   // GPIO4 = SCK  (labelled SCL on module)
#define ADXL_MISO  2   // GPIO2 = MISO (labelled SDO on module)
#define ADXL_MOSI  3   // GPIO3 = MOSI (labelled SDA on module)
#define ADXL_CS    1   // GPIO1 = CS
#define ADXL_INT1  0   // GPIO0 = INT1 (rising-edge interrupt)

// ============ ADXL345 register addresses ============
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

// ============ Sample record ============
struct AdxlSample { int16_t x, y, z; };

// ============ ADXL driver state ============
static bool    adxlOK    = false;
static bool    bootNoiseDone = false;
static int     bootNoiseSamples = 0;
static uint8_t adxlDevId = 0;

#define ADXL_BUF_SIZE 64
static AdxlSample adxlBuf[ADXL_BUF_SIZE];
static uint8_t    adxlHead  = 0;
static uint8_t    adxlCount = 0;

static volatile bool adxlFifoReady = false;  // set by ISR, polled by loop
// Sample-rate measurement helpers
static uint32_t adxlRateSamples   = 0;
static uint32_t adxlRateStart     = 0;
static float    adxlRateHz        = 0.0f;
static bool     adxlRateMeasuring = false;

// ============ ISR ============
void IRAM_ATTR adxlISR() {
  adxlFifoReady = true;
}

// ============ SPI read/write helpers ============
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

// Apply the BW_RATE register for the current cfg.sampleRate. Safe to call
// while the device is already running (standby -> write -> measure), so we
// can reconfigure without a reboot when the client changes sampleRate.
// Returns true on success (readback verified), false otherwise.
static bool adxlApplySampleRate() {
  if (!adxlOK) return false;
  spiWrite(REG_POWER_CTL, 0x00);  // Standby
  delay(2);
  uint8_t bwRate = 0x0F;
  if      (cfg.sampleRate <= 400)  bwRate = 0x0C;
  else if (cfg.sampleRate <= 800)  bwRate = 0x0D;
  else if (cfg.sampleRate <= 1600) bwRate = 0x0E;
  else                             bwRate = 0x0F;
  spiWrite(REG_BW_RATE, bwRate);
  uint8_t vr = spiRead(REG_BW_RATE);
  if (vr != bwRate) {
    Serial.printf("[ADXL] BW_RATE runtime update FAILED: wrote 0x%02X, read 0x%02X\n", bwRate, vr);
    spiWrite(REG_POWER_CTL, 0x08);  // Back to Measure even on failure
    return false;
  }
  spiWrite(REG_POWER_CTL, 0x08);  // Measure
  Serial.printf("[ADXL] BW_RATE updated live: 0x%02X (%dHz)\n", bwRate, cfg.sampleRate);
  return true;
}

// ============ ADXL init ============
bool adxlInit() {
  Serial.printf("[ADXL] pins: SCK=%d MISO=%d MOSI=%d CS=%d INT1=%d\n",
    cfg.pinSCK, cfg.pinMISO, cfg.pinMOSI, cfg.pinCS, cfg.pinINT1);

  // CS must be HIGH before SPI.begin() (idle state)
  pinMode(cfg.pinCS, OUTPUT);
  digitalWrite(cfg.pinCS, HIGH);
  delay(10);

  // SPI init: use SS=-1 so we can drive CS manually
  SPI.end();  // ensure any previous SPI config is cleared
  SPI.begin(cfg.pinSCK, cfg.pinMISO, cfg.pinMOSI, -1);
  SPI.setFrequency(1000000);  // start at 1 MHz (safe for detection); boosted later
  SPI.setDataMode(SPI_MODE3);
  delay(50);  // let SPI settle
  // Configure INT1 pin
  pinMode(cfg.pinINT1, INPUT_PULLUP);
  delay(10);

  // DevID read - retry up to 3 times
  adxlDevId = 0;
  for (int attempt = 1; attempt <= 3; attempt++) {
    // Toggle CS to put the ADXL345 into a known SPI state
    digitalWrite(cfg.pinCS, HIGH);
    delay(5);
    digitalWrite(cfg.pinCS, LOW);
    delay(1);
    digitalWrite(cfg.pinCS, HIGH);
    delay(5);

    adxlDevId = spiRead(REG_DEVID);
    Serial.printf("[ADXL] init attempt %d/3: DevID=0x%02X %s\n",
      attempt, adxlDevId, adxlDevId == 0xE5 ? "OK" : "FAIL");

    if (adxlDevId == 0xE5) break;
    delay(50);
  }

  if (adxlDevId != 0xE5) {
    Serial.println("[ADXL] SPI communication failed - check wiring");
    Serial.printf("  SCK=GPIO%d  MISO=GPIO%d  MOSI=GPIO%d  CS=GPIO%d\n",
      cfg.pinSCK, cfg.pinMISO, cfg.pinMOSI, cfg.pinCS);
    return false;
  }

  // Boost SPI to 5 MHz after initial detection (stable at 3200 Hz)
  SPI.setFrequency(5000000);

  spiWrite(REG_POWER_CTL, 0x00);  // Standby
  delay(5);

  // BW_RATE: derive ADXL BW_RATE register value from cfg.sampleRate
  uint8_t bwRate = 0x0F; // default: 3200Hz
  if      (cfg.sampleRate <= 400)  bwRate = 0x0C;
  else if (cfg.sampleRate <= 800)  bwRate = 0x0D;
  else if (cfg.sampleRate <= 1600) bwRate = 0x0E;
  else                             bwRate = 0x0F;
  spiWrite(REG_BW_RATE, bwRate);
  // R66: verify BW_RATE via readback (detects SPI glitch/miswire)
  {
    uint8_t vr = spiRead(REG_BW_RATE);
    if (vr != bwRate) {
      Serial.printf("[ADXL] BW_RATE verify FAILED: wrote 0x%02X, read 0x%02X\n", bwRate, vr);
      return false;
    }
  }
  Serial.printf("[ADXL] BW_RATE=0x%02X (%dHz) verified\n", bwRate, cfg.sampleRate);
  spiWrite(REG_DATA_FORMAT, 0x08);  // Full Res, +/-16g

  // FIFO: switch from bypass to stream mode
  spiWrite(REG_FIFO_CTL, 0x00);  // bypass
  delay(1);
  spiWrite(REG_FIFO_CTL, 0x99);  // Stream + WM=25

  spiWrite(REG_INT_MAP,    0x00);  // route all interrupts to INT1
  spiWrite(REG_INT_ENABLE, 0x02);  // enable watermark (WM) interrupt
  // Clear pending INT_SOURCE before attaching ISR (avoids spurious first trigger)
  spiRead(REG_INT_SOURCE);

  attachInterrupt(digitalPinToInterrupt(cfg.pinINT1), adxlISR, RISING);

  spiWrite(REG_POWER_CTL, 0x08);  // Measurement ON
  delay(5);

  // Test read to confirm SPI link is good before returning success
  int16_t tx, ty, tz;
  spiReadXYZ(tx, ty, tz);
  Serial.printf("[ADXL] self-test reading: X=%d Y=%d Z=%d\n", tx, ty, tz);
  Serial.printf("[ADXL] ready: %dHz / 16g FR / Stream(WM=25)\n", cfg.sampleRate);
  return true;
}

// ============ FIFO drain ============
// R33: FIFO overflow counter.
static uint32_t _adxlOverflowCount = 0;

static void adxlDrainFifo() {
  uint8_t rawStatus = spiRead(REG_FIFO_STATUS);
  // R33: FIFO_STATUS bit 7 = overflow flag - checked from loop()
  if (rawStatus & 0x80) {
    _adxlOverflowCount++;
    if ((_adxlOverflowCount % 10) == 1) {
      Serial.printf("[ADXL] FIFO overflow #%u - main loop too slow\n", (unsigned)_adxlOverflowCount);
    }
  }
  uint8_t hwCnt = rawStatus & 0x3F;
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
  // GPIO0 ISR fires on watermark; we drain the FIFO in the main loop
  // Keeping ISR body minimal avoids stalling higher-priority tasks
  if (adxlFifoReady) {
    adxlFifoReady = false;
    adxlDrainFifo();
  } else {
    // ISR may have missed an edge; poll FIFO watermark as a safety net
    uint8_t entries = spiRead(REG_FIFO_STATUS) & 0x3F;
    if (entries >= 25) {
      adxlDrainFifo();
    }
  }
}

static float toMs2(int16_t raw) {
  return raw * 0.0039f * 9.80665f;
}

// ============================================================
// ADXL / DSP HTTP API
// ============================================================

// Debug/read endpoint: dump DSP tuning + current state.
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
  // R25: every POST handler must enforce the body size limit for DoS protection.
  if (!checkBodyLimit(8192)) return;
  JsonDocument doc;
  if (deserializeJson(doc, server.arg("plain"))) {
    server.send(400, "text/plain", "JSON error"); return;
  }
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
  // Read X/Y/Z via SPI one-shot (for ISR-free poll mode)
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
    server.send(200, "application/json", "{\"ok\":true,\"msg\":\"rate sampling started\"}");
    return;
  }
  JsonDocument doc;
  // R76: validate measured rate against cfg.sampleRate (+/-8%), not a fixed 3200Hz
  // constant. Without this, any non-default sampleRate would falsely report "NOT OK"
  // even when the sensor is delivering the configured rate correctly.
  const float targetHz = (float)cfg.sampleRate;
  const float lo = targetHz * 0.92f;
  const float hi = targetHz * 1.08f;
  if (adxlRateMeasuring) {
    uint32_t elapsed = millis() - adxlRateStart;
    if (elapsed >= 1000) {
      adxlRateHz = adxlRateSamples * 1000.0f / (float)elapsed;
      adxlRateMeasuring = false;
      doc["done"] = true; doc["hz"] = adxlRateHz;
      doc["samples"] = adxlRateSamples; doc["elapsed"] = elapsed;
      doc["target"] = targetHz;
      doc["ok"] = (adxlRateHz > lo && adxlRateHz < hi);
    } else {
      doc["done"] = false; doc["elapsed"] = elapsed; doc["samples"] = adxlRateSamples;
    }
  } else {
    doc["done"] = true; doc["hz"] = adxlRateHz;
    doc["target"] = targetHz;
    doc["ok"] = (adxlRateHz > lo && adxlRateHz < hi);
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

// =============================================================
// Config load/save
// =============================================================
// Forward decl - referenced by loadConfig() on first-boot path.
bool saveConfig();

void loadConfig() {
  // First-boot detection: if "femto" namespace does not exist, initialize it
  bool firstBoot = false;
  if (!prefs.begin("femto", true)) {  // read-only probe; may fail on fresh flash
    prefs.end();
    firstBoot = true;
    Serial.println("[NVS] first-boot: no saved config, writing defaults");
    saveConfig();  // persist default config so the next boot is clean
  } else {
    prefs.end();
  }

  // Read-phase open. If this fails we keep the in-memory defaults.
  // R1.1: fall through to defaults on failure rather than blocking boot
  if (!prefs.begin("femto", false)) {
    Serial.println("[NVS] ERROR: cannot open 'femto' for reading - using defaults");
    dspMinValidSegs = cfg.minSegs;
    dspSetSampleRate((float)cfg.sampleRate);
    return;
  }
  cfg.buildX     = prefs.getInt("buildX",    cfg.buildX);
  cfg.buildY     = prefs.getInt("buildY",    cfg.buildY);
  cfg.accel      = prefs.getInt("accel",     cfg.accel);
  cfg.feedrate   = prefs.getInt("feedrate",  cfg.feedrate);
  cfg.sampleRate = prefs.getInt("sampleRate",cfg.sampleRate);
  prefs.getString("kin", cfg.kin, sizeof(cfg.kin));
  prefs.getString("axesMap", cfg.axesMap, sizeof(cfg.axesMap));
  // Calibration weights from NVS (projects ADXL axes onto printer axes)
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

  // Sync DSP parameter from cfg.minSegs
  dspMinValidSegs = cfg.minSegs;
  dspSetSampleRate((float)cfg.sampleRate);

  // R71: sanity-check config fields (guards against NVS bit-flips)
  auto isValidKin = [](const char* k) {
    return strcmp(k, "corexy") == 0 || strcmp(k, "cartesian") == 0 ||
           strcmp(k, "delta") == 0 || strcmp(k, "scara") == 0;
  };
  auto isValidFw = [](const char* f) {
    return strcmp(f, "marlin_is") == 0 || strcmp(f, "marlin_ftm") == 0 ||
           strcmp(f, "klipper") == 0 || strcmp(f, "rrf") == 0;
  };
  if (!isValidKin(cfg.kin)) {
    Serial.printf("[CFG] Invalid kin '%s' - reset to corexy\n", cfg.kin);
    strncpy(cfg.kin, "corexy", sizeof(cfg.kin)-1);
  }
  if (!isValidFw(cfg.firmware)) {
    Serial.printf("[CFG] Invalid firmware '%s' - reset to marlin_is\n", cfg.firmware);
    strncpy(cfg.firmware, "marlin_is", sizeof(cfg.firmware)-1);
  }
  // Range clamp (mirrors the POST handler so NVS bit-flips are caught)
  cfg.buildX   = constrain(cfg.buildX, 30, 1000);
  cfg.buildY   = constrain(cfg.buildY, 30, 1000);
  cfg.accel    = constrain(cfg.accel, 100, 50000);
  cfg.feedrate = constrain(cfg.feedrate, 10, 1000);
  // Shaper parameters: same sanity ranges as the POST validator. Without these
  // a corrupted NVS read could feed 0 or NaN into the shaper math at boot.
  if (!isfinite(cfg.scv)      || cfg.scv      <= 0.0f || cfg.scv      > 1000.0f) cfg.scv      = 5.0f;
  if (!isfinite(cfg.damping)  || cfg.damping  <= 0.0f || cfg.damping  >= 1.0f)   cfg.damping  = 0.1f;
  if (!isfinite(cfg.targetSm) || cfg.targetSm <= 0.0f || cfg.targetSm >= 1.0f)   cfg.targetSm = 0.12f;
  // Snap to discrete hardware-supported values so NVS bit-flips or stale
  // pre-validator writes don't produce undefined WiFi / filter behaviour.
  {
    const int tx[] = {2, 5, 8, 11, 15, 20};
    int best = tx[0], bestDist = abs(cfg.txPower - best);
    for (size_t i = 1; i < sizeof(tx)/sizeof(tx[0]); i++) {
      int d = abs(cfg.txPower - tx[i]);
      if (d < bestDist) { bestDist = d; best = tx[i]; }
    }
    cfg.txPower = best;
  }
  {
    const int ph[] = {0, 50, 60};
    int best = ph[0], bestDist = abs(cfg.powerHz - best);
    for (size_t i = 1; i < sizeof(ph)/sizeof(ph[0]); i++) {
      int d = abs(cfg.powerHz - ph[i]);
      if (d < bestDist) { bestDist = d; best = ph[i]; }
    }
    cfg.powerHz = best;
  }
  // ADXL345 only supports the discrete rates {400, 800, 1600, 3200}. Snap the
  // stored cfg value to the nearest supported rate so the DSP freq axis (which
  // uses cfg.sampleRate) stays aligned with the actual hardware rate. Without
  // this, a user POSTing sampleRate=1000 would get a 1600Hz ADXL + a DSP that
  // believed the rate was 1000, mis-locating every peak by ~37%.
  cfg.sampleRate = constrain(cfg.sampleRate, 400, 3200);
  {
    const int allowed[] = {400, 800, 1600, 3200};
    int best = allowed[0];
    int bestDist = abs(cfg.sampleRate - best);
    for (size_t i = 1; i < sizeof(allowed)/sizeof(allowed[0]); i++) {
      int d = abs(cfg.sampleRate - allowed[i]);
      if (d < bestDist) { bestDist = d; best = allowed[i]; }
    }
    cfg.sampleRate = best;
  }
  cfg.minSegs  = constrain(cfg.minSegs, 10, 500);

  // R5.1/R18.24: if calibration vectors are still the identity default,
  // force useCalWeights=false so we do not pretend we are calibrated
  bool isDefaultCal = (cfg.calWx[0] == 1.0f && cfg.calWx[1] == 0.0f && cfg.calWx[2] == 0.0f &&
                       cfg.calWy[0] == 0.0f && cfg.calWy[1] == 1.0f && cfg.calWy[2] == 0.0f);
  if (cfg.useCalWeights && isDefaultCal) {
    cfg.useCalWeights = false;
    Serial.println("[CFG] useCalWeights=true with default vectors - forced to false");
  }
  // R42: renormalise calibration vectors if their magnitude drifted from 1.0
  if (cfg.useCalWeights) {
    float magX = sqrtf(cfg.calWx[0]*cfg.calWx[0] + cfg.calWx[1]*cfg.calWx[1] + cfg.calWx[2]*cfg.calWx[2]);
    float magY = sqrtf(cfg.calWy[0]*cfg.calWy[0] + cfg.calWy[1]*cfg.calWy[1] + cfg.calWy[2]*cfg.calWy[2]);
    if (magX > 1e-6f && fabsf(magX - 1.0f) > 0.01f) {
      for (int i = 0; i < 3; i++) cfg.calWx[i] /= magX;
      Serial.printf("[CFG] calWx renormalized (was mag=%.4f)\n", magX);
    }
    if (magY > 1e-6f && fabsf(magY - 1.0f) > 0.01f) {
      for (int i = 0; i < 3; i++) cfg.calWy[i] /= magY;
      Serial.printf("[CFG] calWy renormalized (was mag=%.4f)\n", magY);
    }
    // Zero-magnitude or NaN vector means the calibration is unusable
    if (magX < 1e-6f || magY < 1e-6f || !isfinite(magX) || !isfinite(magY)) {
      cfg.useCalWeights = false;
      Serial.println("[CFG] calWx/calWy invalid - useCalWeights disabled");
    }
  }
  if (firstBoot) {
    Serial.println("[NVS] first boot - defaults loaded");
  }
  Serial.printf("[CFG] %dx%d accel=%d scv=%.1f fw=%s\n",
    cfg.buildX, cfg.buildY, cfg.accel, cfg.scv, cfg.firmware);
}

// R4.2: Persist config to NVS. Returns true on success, false on NVS error.
// The final putInt() return value tells us whether any bytes were written.
bool saveConfig() {
  if (!prefs.begin("femto", false)) return false;
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
  // R4.2: use the liveSegs putInt() return as the success probe (0 = failure)
  size_t lastWrite = prefs.putInt("liveSegs", cfg.liveSegs);
  prefs.end();
  return lastWrite > 0;
}

void serveFile(const char* path, const char* ct) {
  File f = LittleFS.open(path, "r");
  if (!f) { server.send(404, "text/plain", "Not found"); return; }
  server.streamFile(f, ct);
  f.close();
}

#define FEMTO_API_VERSION "1.2"  // R86: bump on breaking API changes
#define FEMTO_FW_VERSION  "1.2.0-bughunt"

void handleGetConfig() {
  JsonDocument doc;
  doc["apiVersion"] = FEMTO_API_VERSION;
  doc["fwVersion"] = FEMTO_FW_VERSION;
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
  // Runtime WiFi status
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

// ============ Measurement state machine ============
// 3 states: IDLE -> PRINT (sampling) -> DONE. dsp.h::dspFeed() is fed only in PRINT.
enum MeasState { MEAS_IDLE, MEAS_PRINT, MEAS_DONE };
static MeasState measState = MEAS_IDLE;

// v1.0: Live SSE broadcast channel - single persistent client
static WiFiClient liveSSEClient;
static bool  liveMode = false;
static int   liveSegReset = 0;

// v1.0: Peak tracking (dual-axis DSP, live-mode snapshot)
static float peakFreqX = 0.0f, peakFreqY = 0.0f;
static float peakPowerX = 0.0f, peakPowerY = 0.0f;
static int   segCountX = 0, segCountY = 0;

// v1.0: Measured PSD snapshot (saved at print_stop; used for /api/psd?mode=print)
#define MEAS_MAX_BINS DSP_NBINS
static float measPsdX[MEAS_MAX_BINS], measPsdY[MEAS_MAX_BINS];
static float measVarX[MEAS_MAX_BINS], measVarY[MEAS_MAX_BINS];
// Phase 2: Jerk PSD arrays (derivative spectrum, saved at print-stop)
static float measJerkX[MEAS_MAX_BINS], measJerkY[MEAS_MAX_BINS];
static int   measSampleRate = (int)DSP_FS_DEFAULT;
static int   measBinMin = 0;
static int   measBinCount = 0;
static bool  measPsdValid = false;

void handlePostConfig() {
  if (!checkBodyLimit(8192)) return;
  JsonDocument doc;
  if (deserializeJson(doc,server.arg("plain"))) { server.send(400,"text/plain","JSON error"); return; }

  // Pre-flight pin-conflict check. We have to do this BEFORE mutating any
  // state (previously this check happened after sampleRate was already
  // applied + NVS caches were already invalidated + ADXL was already
  // reprogrammed, so a user with a typo on pins silently lost their
  // measurement snapshot on every 400-response). Stage new pin values
  // from the body and reject upfront on duplicates without touching cfg.
  {
    int np[7] = {
      doc["pinSCK"].is<int>()   ? doc["pinSCK"].as<int>()   : cfg.pinSCK,
      doc["pinMISO"].is<int>()  ? doc["pinMISO"].as<int>()  : cfg.pinMISO,
      doc["pinMOSI"].is<int>()  ? doc["pinMOSI"].as<int>()  : cfg.pinMOSI,
      doc["pinCS"].is<int>()    ? doc["pinCS"].as<int>()    : cfg.pinCS,
      doc["pinINT1"].is<int>()  ? doc["pinINT1"].as<int>()  : cfg.pinINT1,
      doc["pinLED"].is<int>()   ? doc["pinLED"].as<int>()   : cfg.pinLED,
      doc["pinReset"].is<int>() ? doc["pinReset"].as<int>() : cfg.pinReset,
    };
    for (int i = 0; i < 7; i++)
      for (int j = i+1; j < 7; j++)
        if (np[i] == np[j] && np[i] >= 0) {
          server.send(400, "application/json",
            "{\"ok\":false,\"error\":\"duplicate_gpio_pins\"}");
          return;
        }
  }

  // R20.32: block sampleRate changes during an active measurement
  // (FFT sizing assumes a fixed rate for the duration of the run)
  if (measState == MEAS_PRINT) {
    if (doc["sampleRate"].is<int>() && doc["sampleRate"].as<int>() != cfg.sampleRate) {
      server.send(409, "application/json",
        "{\"ok\":false,\"error\":\"cannot_change_sample_rate_during_measurement\"}");
      return;
    }
    if (doc["minSegs"].is<int>() && doc["minSegs"].as<int>() != cfg.minSegs) {
      server.send(409, "application/json",
        "{\"ok\":false,\"error\":\"cannot_change_minSegs_during_measurement\"}");
      return;
    }
  }

  // R60.1/2/3: reject obviously bad values (negative / zero / out-of-range)
  if (doc["buildX"].is<int>())      cfg.buildX     = constrain(doc["buildX"].as<int>(), 30, 1000);
  if (doc["buildY"].is<int>())      cfg.buildY     = constrain(doc["buildY"].as<int>(), 30, 1000);
  if (doc["accel"].is<int>())       cfg.accel      = constrain(doc["accel"].as<int>(), 100, 50000);
  if (doc["feedrate"].is<int>())    cfg.feedrate   = constrain(doc["feedrate"].as<int>(), 10, 1000);
  // P-05/P-06 (Codex follow-up): when sampleRate changes we must wipe
  // rate-dependent caches, or their bin frequencies will be wrong:
  //   - measPsd (frequency axis scales with rate)
  //   - dspBgPsd (bin count and frequency mapping change with rate)
  //   - dspBgEnergy (sweep threshold derives from background energy)
  if (doc["sampleRate"].is<int>()) {
    int newSR = constrain(doc["sampleRate"].as<int>(), 400, 3200);
    // Snap to nearest ADXL-supported rate (same reasoning as loadConfig; without
    // this the DSP would mis-locate peaks whenever cfg != hardware rate).
    {
      const int allowed[] = {400, 800, 1600, 3200};
      int best = allowed[0];
      int bestDist = abs(newSR - best);
      for (size_t i = 1; i < sizeof(allowed)/sizeof(allowed[0]); i++) {
        int d = abs(newSR - allowed[i]);
        if (d < bestDist) { bestDist = d; best = allowed[i]; }
      }
      newSR = best;
    }
    if (newSR != cfg.sampleRate) {
      // New sample rate: invalidate all rate-dependent buffers
      measPsdValid = false;
      measSampleRate = newSR;
      measBinMin = 0;
      measBinCount = 0;
      memset(measPsdX, 0, sizeof(measPsdX));
      memset(measPsdY, 0, sizeof(measPsdY));
      memset(measVarX, 0, sizeof(measVarX));
      memset(measVarY, 0, sizeof(measVarY));
      memset(measJerkX, 0, sizeof(measJerkX));
      memset(measJerkY, 0, sizeof(measJerkY));
      memset(dspBgPsd, 0, sizeof(dspBgPsd));
      dspBgSegs = 0;
      dspBgEnergy = 0;
      bootNoiseDone = false;   // re-capture boot noise for the new rate
      bootNoiseSamples = 0;
      // Dual-axis accumulators hold data digitised at the OLD freqRes. If we
      // leave them, any in-flight live SSE stream will report the old bin
      // values with the new fr/bm metadata attached - a silent freq-axis mix.
      dspResetDual();
      Serial.printf("[CFG] sampleRate changed %d -> %d : measPsd/bgPsd/dual invalidated, will recapture noise\n",
                    cfg.sampleRate, newSR);
      cfg.sampleRate = newSR;
      // CRITICAL: also reprogram the ADXL BW_RATE register. Without this the
      // hardware keeps delivering samples at the old rate while the DSP now
      // believes the rate is newSR - every peak ends up reported at
      // (newSR/oldSR) x the real frequency.
      adxlApplySampleRate();
    }
  }
  if (doc["kin"].is<const char*>()) strncpy(cfg.kin, doc["kin"] | "corexy", sizeof(cfg.kin)-1);
  if (doc["axesMap"].is<const char*>()) strncpy(cfg.axesMap, doc["axesMap"] | "xyz", sizeof(cfg.axesMap)-1);
  // Calibration weights accepted from JS (expected as 3-float JSON arrays).
  // Both calWx and calWy must be present and well-formed; partial updates are
  // rejected to avoid mixing a fresh X vector with a stale Y vector (which
  // could yield a non-orthogonal projection).
  if (doc["calWx"].is<JsonArray>() && doc["calWx"].size() == 3 &&
      doc["calWy"].is<JsonArray>() && doc["calWy"].size() == 3) {
    cfg.calWx[0] = doc["calWx"][0]; cfg.calWx[1] = doc["calWx"][1]; cfg.calWx[2] = doc["calWx"][2];
    cfg.calWy[0] = doc["calWy"][0]; cfg.calWy[1] = doc["calWy"][1]; cfg.calWy[2] = doc["calWy"][2];
    cfg.useCalWeights = true;
  }
  // Phase 5: SCV / damping / targetSm (shaper parameters).
  // Validate ranges so downstream shaper math (division, sqrt(1 - damping^2),
  // bisection over smoothing) cannot see 0/negative/NaN and silently produce
  // garbage shapers. Typical: scv 2-20 mm/s, damping 0.02-0.5, targetSm 0.05-0.3.
  if (doc["scv"].is<float>()) {
    float v = doc["scv"].as<float>();
    if (isfinite(v) && v > 0.0f && v <= 1000.0f) cfg.scv = v;
  }
  if (doc["damping"].is<float>()) {
    float v = doc["damping"].as<float>();
    if (isfinite(v) && v > 0.0f && v < 1.0f) cfg.damping = v;
  }
  if (doc["targetSm"].is<float>()) {
    float v = doc["targetSm"].as<float>();
    if (isfinite(v) && v > 0.0f && v < 1.0f) cfg.targetSm = v;
  }
  if (doc["demoMode"].is<bool>())  cfg.demoMode   = doc["demoMode"].as<bool>();
  if (doc["firmware"].is<const char*>()) strncpy(cfg.firmware, doc["firmware"] | "marlin_is", sizeof(cfg.firmware)-1);
  if (doc["eepromSave"].is<bool>()) cfg.eepromSave = doc["eepromSave"];
  // GPIO pin fields (may conflict - validated below)
  // R60.7: Stage new pin values, then check for duplicates before commit
  int newSCK = doc["pinSCK"].is<int>()   ? doc["pinSCK"].as<int>()   : cfg.pinSCK;
  int newMISO= doc["pinMISO"].is<int>()  ? doc["pinMISO"].as<int>()  : cfg.pinMISO;
  int newMOSI= doc["pinMOSI"].is<int>()  ? doc["pinMOSI"].as<int>()  : cfg.pinMOSI;
  int newCS  = doc["pinCS"].is<int>()    ? doc["pinCS"].as<int>()    : cfg.pinCS;
  int newINT1= doc["pinINT1"].is<int>()  ? doc["pinINT1"].as<int>()  : cfg.pinINT1;
  int newLED = doc["pinLED"].is<int>()   ? doc["pinLED"].as<int>()   : cfg.pinLED;
  int newRst = doc["pinReset"].is<int>() ? doc["pinReset"].as<int>() : cfg.pinReset;
  // Reload GPIO pin assignments (ADXL SPI may need re-init)
  int pins[7] = { newSCK, newMISO, newMOSI, newCS, newINT1, newLED, newRst };
  bool pinConflict = false;
  for (int i = 0; i < 7; i++)
    for (int j = i+1; j < 7; j++)
      if (pins[i] == pins[j] && pins[i] >= 0) { pinConflict = true; break; }
  if (pinConflict) {
    server.send(400, "application/json",
      "{\"ok\":false,\"error\":\"duplicate_gpio_pins\"}");
    return;
  }
  cfg.pinSCK = newSCK; cfg.pinMISO = newMISO; cfg.pinMOSI = newMOSI;
  cfg.pinCS = newCS; cfg.pinINT1 = newINT1; cfg.pinLED = newLED; cfg.pinReset = newRst;
  if (doc["txPower"].is<int>()) {
    // txPower must match one of the discrete ESP32-C3 Wi-Fi power levels.
    // The setup() switch maps the accepted values to WIFI_POWER_* enums;
    // unaccepted values fall to the 8.5dBm default, making the NVS-stored
    // value silently diverge from actual hardware state. Snap here.
    int t = doc["txPower"].as<int>();
    int allowed[] = {2, 5, 8, 11, 15, 20};
    int best = allowed[0], bestDist = abs(t - best);
    for (size_t i = 1; i < sizeof(allowed)/sizeof(allowed[0]); i++) {
      int d = abs(t - allowed[i]);
      if (d < bestDist) { bestDist = d; best = allowed[i]; }
    }
    cfg.txPower = best;
  }
  if (doc["minSegs"].is<int>()) {
    cfg.minSegs = constrain(doc["minSegs"].as<int>(), 10, 500);
    dspMinValidSegs = cfg.minSegs;  // keep DSP validity threshold in sync
  }
  if (doc["wifiMode"].is<const char*>()) strncpy(cfg.wifiMode, doc["wifiMode"] | "ap", sizeof(cfg.wifiMode)-1);
  if (doc["staSSID"].is<const char*>()) strncpy(cfg.staSSID, doc["staSSID"] | "", sizeof(cfg.staSSID)-1);
  if (doc["staPass"].is<const char*>()) strncpy(cfg.staPass, doc["staPass"] | "", sizeof(cfg.staPass)-1);
  if (doc["hostname"].is<const char*>()) {
    strncpy(cfg.hostname, doc["hostname"] | "femto", sizeof(cfg.hostname)-1);
    // Hostname must be a valid DNS label; strip/replace as needed
    for (int i=0; cfg.hostname[i]; i++) {
      char c = cfg.hostname[i];
      if (!((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='-')) cfg.hostname[i] = '-';
    }
    if (cfg.hostname[0]=='\0' || (!(cfg.hostname[0]>='a'&&cfg.hostname[0]<='z') && !(cfg.hostname[0]>='A'&&cfg.hostname[0]<='Z')))
      strncpy(cfg.hostname, "femto", sizeof(cfg.hostname)-1);
  }
  if (doc["powerHz"].is<int>()) {
    // Only 0 (off), 50 or 60 make sense for a mains-notch filter; anything
    // else would sit in NVS as a bogus value and confuse future features
    // that try to use it. Snap to nearest.
    int p = doc["powerHz"].as<int>();
    int allowed[] = {0, 50, 60};
    int best = allowed[0], bestDist = abs(p - best);
    for (size_t i = 1; i < sizeof(allowed)/sizeof(allowed[0]); i++) {
      int d = abs(p - allowed[i]);
      if (d < bestDist) { bestDist = d; best = allowed[i]; }
    }
    cfg.powerHz = best;
  }
  if (doc["liveSegs"].is<int>()) {
    cfg.liveSegs = doc["liveSegs"].as<int>();
    if (cfg.liveSegs < 1) cfg.liveSegs = 1;
    if (cfg.liveSegs > 10) cfg.liveSegs = 10;
  }
  dspSetSampleRate((float)cfg.sampleRate);
  // R4.2/R20.33: report NVS write status so the client knows if it succeeded
  if (!saveConfig()) {
    server.send(507, "application/json",
      "{\"ok\":false,\"error\":\"nvs_full\",\"hint\":\"POST /api/reset?all=1 to factory reset\"}");
    return;
  }
  server.send(200,"application/json","{\"ok\":true}");
}

static inline int currentPsdBinCount() {
  return dspBinMax() - dspBinMin() + 1;
}

// Background PSD persistence (NVS-backed, blob-encoded)
void loadBgPsdFromNVS() {
  prefs.begin("femto_bg", true);  // read-only
  if (prefs.getBool("valid", false)) {
    memset(dspBgPsd, 0, sizeof(dspBgPsd));
    size_t len = prefs.getBytesLength("psd");
    const int savedBinMin = prefs.getInt("binMin", -1);
    const int savedBinCount = prefs.getInt("binCount", 0);
    const int savedSampleRate = prefs.getInt("sampleRate", 0);
    if (savedBinCount > 0 &&
        savedBinCount <= DSP_NBINS &&
        savedBinMin >= 0 &&
        (savedBinMin + savedBinCount) <= DSP_NBINS &&
        len == (size_t)(savedBinCount * sizeof(float)) &&
        (savedSampleRate == 0 || savedSampleRate == cfg.sampleRate)) {
      float buf[DSP_NBINS];
      prefs.getBytes("psd", buf, len);
      for (int i = 0; i < savedBinCount; i++) dspBgPsd[savedBinMin + i] = buf[i];
      dspBgSegs = prefs.getInt("segs", 5);
      Serial.printf("[NVS] bgPsd restored (%d bins)\n", savedBinCount);
    } else if (len == 59 * sizeof(float) && cfg.sampleRate == (int)DSP_FS_DEFAULT) {
      float buf[59];
      prefs.getBytes("psd", buf, len);
      for (int i = 0; i < 59; i++) dspBgPsd[i + 6] = buf[i];
      dspBgSegs = 5;
      Serial.println("[NVS] bgPsd restored (legacy blob 59 bins)");
    } else if (prefs.isKey("b6") && cfg.sampleRate == (int)DSP_FS_DEFAULT) {
      for (int k = 6; k <= 64; k++) {
        char key[8]; snprintf(key, sizeof(key), "b%d", k);
        dspBgPsd[k] = prefs.getFloat(key, 0.0f);
      }
      dspBgSegs = 5;
      Serial.println("[NVS] bgPsd restored (legacy 59 keys)");
    }
  }
  prefs.end();
}

// Save bgPsd to NVS as a single blob (no per-bin keys)
void saveBgPsdToNVS() {
  const int binMin = dspBinMin();
  const int binCount = currentPsdBinCount();
  float buf[DSP_NBINS];
  memset(buf, 0, sizeof(buf));
  for (int i = 0; i < binCount; i++) buf[i] = dspBgPsd[i + binMin];
  prefs.begin("femto_bg", false);
  prefs.clear();
  prefs.putBool("valid", true);
  prefs.putInt("sampleRate", cfg.sampleRate);
  prefs.putInt("binMin", binMin);
  prefs.putInt("binCount", binCount);
  prefs.putInt("segs", dspBgSegs);
  prefs.putBytes("psd", buf, binCount * sizeof(float));
  prefs.end();
  Serial.printf("[NVS] bgPsd saved (%d bins)\n", binCount);
}

// Get accumulated background PSD (with variance)
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
  if (!checkBodyLimit(8192)) return;
  JsonDocument doc;
  if (deserializeJson(doc,server.arg("plain"))) { server.send(400,"text/plain","JSON error"); return; }
  const char* st = doc["state"] | "off";
  if      (strcmp(st, "on")    == 0) ledState = LED_ON;
  else if (strcmp(st, "blink") == 0) ledState = LED_BLINK;
  else                               ledState = LED_OFF;
  server.send(200,"application/json","{\"ok\":true}");
}

void handleSaveResult() {
  if (!checkBodyLimit(8192)) return;
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
    doc["hasResult"]=false;doc["freqX"]=0;doc["freqY"]=0;doc["shaperType"]="";doc["confidence"]=0;doc["savedAt"]=0;
  } else {
    float freqX=prefs.getFloat("freqX",0), freqY=prefs.getFloat("freqY",0);
    // Zero-initialise before getString: if the NVS key is missing the buffer
    // is NOT touched, leaving uninitialised stack garbage. The subsequent
    // `if (!shTypeX[0])` check would then behave unpredictably.
    char shType[16]="", shTypeX[16]="", shTypeY[16]="";
    prefs.getString("shaperType", shType,  sizeof(shType));
    prefs.getString("shaperTypeX",shTypeX, sizeof(shTypeX));
    prefs.getString("shaperTypeY",shTypeY, sizeof(shTypeY));
    if (!shTypeX[0]) strncpy(shTypeX, shType, sizeof(shTypeX)-1);
    if (!shTypeY[0]) strncpy(shTypeY, shType, sizeof(shTypeY)-1);
    float conf=prefs.getFloat("confidence",0);
    // savedAt is written by handleSaveResult via putULong. The client uses it as
    // a newer-wins tie-breaker when multiple tabs race to load. Without this
    // field the race guard in data/app.js (R20.30) silently never fires.
    unsigned long savedAt=prefs.getULong("savedAt",0);
    prefs.end();
    doc["freqX"]=freqX; doc["freqY"]=freqY;
    doc["shaperType"]=shType;
    doc["shaperTypeX"]=shTypeX; doc["shaperTypeY"]=shTypeY;
    doc["confidence"]=conf;
    doc["savedAt"]=savedAt;
    doc["hasResult"]=(freqX>0&&freqY>0);
  }
  sendJson(doc);
}

void handleSaveDiag() {
  if (!checkBodyLimit(8192)) return;
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

// ============ AP watchdog / WiFi tx-power ============
unsigned long lastApCheck = 0;
int apFailCount = 0;  // counts consecutive STA reconnect failures before AP fallback
static wifi_power_t txPower = WIFI_POWER_8_5dBm;  // default WiFi TX power (overridden by cfg.txPower)


void saveMeasPsdToNVS() {
  prefs.begin("femto_mpsd", false);
  prefs.clear();
  prefs.putInt("sampleRate", measSampleRate);
  prefs.putInt("binMin", measBinMin);
  prefs.putInt("binCount", measBinCount);
  prefs.putBytes("px", measPsdX, measBinCount * sizeof(float));
  prefs.putBytes("py", measPsdY, measBinCount * sizeof(float));
  prefs.putBytes("vx", measVarX, measBinCount * sizeof(float));
  prefs.putBytes("vy", measVarY, measBinCount * sizeof(float));
  prefs.putBool("valid", true);
  prefs.end();
  Serial.printf("[NVS] measPsd saved (%d bins)\n", measBinCount);
}

void loadMeasPsdFromNVS() {
  if (!prefs.begin("femto_mpsd", true)) { prefs.end(); return; }
  memset(measPsdX, 0, sizeof(measPsdX));
  memset(measPsdY, 0, sizeof(measPsdY));
  memset(measVarX, 0, sizeof(measVarX));
  memset(measVarY, 0, sizeof(measVarY));
  memset(measJerkX, 0, sizeof(measJerkX));
  memset(measJerkY, 0, sizeof(measJerkY));
  measSampleRate = (int)DSP_FS_DEFAULT;
  measBinMin = 0;
  measBinCount = 0;
  measPsdValid = prefs.getBool("valid", false);
  if (measPsdValid) {
    const int savedBinMin = prefs.getInt("binMin", -1);
    const int savedBinCount = prefs.getInt("binCount", 0);
    const int savedSampleRate = prefs.getInt("sampleRate", 0);
    const size_t pxLen = prefs.getBytesLength("px");
    const size_t pyLen = prefs.getBytesLength("py");
    const size_t vxLen = prefs.getBytesLength("vx");
    const size_t vyLen = prefs.getBytesLength("vy");
    if (savedBinCount > 0 &&
        savedBinCount <= MEAS_MAX_BINS &&
        savedBinMin >= 0 &&
        (savedBinMin + savedBinCount) <= DSP_NBINS &&
        pxLen == (size_t)(savedBinCount * sizeof(float)) &&
        pyLen == (size_t)(savedBinCount * sizeof(float)) &&
        vxLen == (size_t)(savedBinCount * sizeof(float)) &&
        vyLen == (size_t)(savedBinCount * sizeof(float))) {
      measSampleRate = savedSampleRate > 0 ? savedSampleRate : (int)DSP_FS_DEFAULT;
      measBinMin = savedBinMin;
      measBinCount = savedBinCount;
      prefs.getBytes("px", measPsdX, pxLen);
      prefs.getBytes("py", measPsdY, pyLen);
      prefs.getBytes("vx", measVarX, vxLen);
      prefs.getBytes("vy", measVarY, vyLen);
      Serial.printf("[NVS] measPsd restored (%d bins)\n", measBinCount);
    } else if (cfg.sampleRate == (int)DSP_FS_DEFAULT &&
               pxLen == 59 * sizeof(float) &&
               pyLen == 59 * sizeof(float) &&
               vxLen == 59 * sizeof(float) &&
               vyLen == 59 * sizeof(float)) {
      measSampleRate = (int)DSP_FS_DEFAULT;
      measBinMin = 6;
      measBinCount = 59;
      prefs.getBytes("px", measPsdX, pxLen);
      prefs.getBytes("py", measPsdY, pyLen);
      prefs.getBytes("vx", measVarX, vxLen);
      prefs.getBytes("vy", measVarY, vyLen);
      Serial.println("[NVS] measPsd restored (legacy 59 bins)");
    } else {
      // R10.1: treat valid=false as "no data" - clear the arrays to be safe
      measPsdValid = false;
      measSampleRate = (int)DSP_FS_DEFAULT;
      measBinMin = 0;
      measBinCount = 0;
      memset(measPsdX, 0, sizeof(measPsdX));
      memset(measPsdY, 0, sizeof(measPsdY));
      memset(measVarX, 0, sizeof(measVarX));
      memset(measVarY, 0, sizeof(measVarY));
      memset(measJerkX, 0, sizeof(measJerkX));
      memset(measJerkY, 0, sizeof(measJerkY));
      Serial.println("[NVS] measPsd skipped (sample rate/bin metadata mismatch) - arrays cleared");
    }
  }
  prefs.end();
}

// ============ GET /api/psd ============
// axis query parameter selects source:
//   axis=x   -> dspDualPsdX
//   axis=y   -> dspDualPsdY
//   (default) -> accumulated single-axis PSD (with per-bin variance)
// [Round 3] In MEAS_DONE mode we return the stored snapshot rather than
// the live accumulator, so the client sees a stable post-print result.
void handleGetPsd() {
  const float freqRes = dspFreqRes();
  const int binMin = dspBinMin();
  const int binMax = dspBinMax();
  // v1.0: Print-Measure mode returns the snapshot saved at print_stop
  if (server.hasArg("mode") && strcmp(server.arg("mode").c_str(),"print")==0) {
    if (!measPsdValid) {
      server.send(200, "application/json", "{\"ok\":false,\"err\":\"no measurement data\"}");
      return;
    }
    const float savedFreqRes = ((float)measSampleRate) / DSP_N;
    JsonDocument doc;
    doc["ok"] = true;
    doc["mode"] = "print";
    doc["freqRes"] = savedFreqRes;
    doc["sampleRate"] = measSampleRate;
    doc["binMin"] = measBinMin;
    doc["binCount"] = measBinCount;
    // Peak summary from the last print_stop snapshot. data/app.js reads
    // peakPowerX/Y (via `d.peakPowerX || 0`) when building lastShaperResult;
    // without these fields the UI silently shows power=0 for both axes.
    doc["peakFreqX"]  = peakFreqX;
    doc["peakFreqY"]  = peakFreqY;
    doc["peakPowerX"] = peakPowerX;
    doc["peakPowerY"] = peakPowerY;
    doc["segsX"]      = segCountX;
    doc["segsY"]      = segCountY;
    // X-axis bins
    JsonArray bx = doc["binsX"].to<JsonArray>();
    for (int i = 0; i < measBinCount; i++) {
      JsonObject b = bx.add<JsonObject>();
      b["f"] = (i + measBinMin) * savedFreqRes;
      b["v"] = measPsdX[i];
      b["var"] = measVarX[i];
    }
    // Y-axis bins
    JsonArray by = doc["binsY"].to<JsonArray>();
    for (int i = 0; i < measBinCount; i++) {
      JsonObject b = by.add<JsonObject>();
      b["f"] = (i + measBinMin) * savedFreqRes;
      b["v"] = measPsdY[i];
      b["var"] = measVarY[i];
    }
    // Phase 2: jerk PSD (derivative spectrum, F(f))
    JsonArray jx = doc["jerkX"].to<JsonArray>();
    JsonArray jy = doc["jerkY"].to<JsonArray>();
    for (int i = 0; i < measBinCount; i++) {
      jx.add(measJerkX[i]);
      jy.add(measJerkY[i]);
    }
    doc["jerkBroadnessX"] = dspJerkBroadness(dspJerkPsdX);
    doc["jerkBroadnessY"] = dspJerkBroadness(dspJerkPsdY);
    // bgPsd
    if (dspBgSegs > 0) {
      JsonArray bg = doc["bgPsd"].to<JsonArray>();
      for (int k = binMin; k <= binMax; k++) bg.add(dspBgPsd[k]);
    }
    sendJson(doc);
    return;
  }

  // axis query parameter: "x" => dspDualPsdX, "y" => dspDualPsdY,
  // anything else (including "current" / missing) => single-axis accumulator.
  const char* axis = server.hasArg("axis") ? server.arg("axis").c_str() : "current";
  const bool useX = (strcmp(axis, "x") == 0);
  const bool useY = (strcmp(axis, "y") == 0);

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
  doc["axis"]      = useX ? "x" : (useY ? "y" : "current");
  // PSD bins (18.75~200Hz). Source depends on axis:
  //  - axis=x/y => dspDualPsdX/Y (dual-axis spectra, populated in live+print)
  //  - default  => dspPsdAccum (single-axis accumulator, with per-bin variance)
  JsonArray bins = doc["bins"].to<JsonArray>();
  for (int k = binMin; k <= binMax; k++) {
    JsonObject b = bins.add<JsonObject>();
    b["f"] = k * freqRes;
    if (useX) {
      b["v"]   = dspDualPsdX[k];
      b["var"] = 0.0f;
    } else if (useY) {
      b["v"]   = dspDualPsdY[k];
      b["var"] = 0.0f;
    } else {
      b["v"]   = dspPsdAccum[k];
      b["var"] = dspPsdVar[k];
    }
  }
  // peaks[] comes from dsp.h dspFindPeaks() (consumed by diagnostic.js Stage 2)
  JsonArray peaksArr = doc["peaks"].to<JsonArray>();
  for (int i = 0; i < st.peakCount; i++) {
    JsonObject pk = peaksArr.add<JsonObject>();
    pk["f"]    = st.peaks[i].freq;
    pk["v"]    = st.peaks[i].power;
    pk["prom"] = st.peaks[i].prominence;
  }
  // Background PSD snapshot (client-side noise-floor subtraction uses this)
  if (dspBgSegs > 0) {
    JsonArray bg = doc["bgPsd"].to<JsonArray>();
    for (int k = binMin; k <= binMax; k++) {
      bg.add(dspBgPsd[k]);
    }
    doc["bgSegs"] = dspBgSegs;
  }
  sendJson(doc);
}

// ============ POST /api/measure ============
// body: {"cmd":"print_start"|"print_stop"|"stop"|"reset"}
void handleMeasure() {
  if (!checkBodyLimit(8192)) return;
  JsonDocument req;
  if (deserializeJson(req, server.arg("plain"))) { server.send(400,"text/plain","JSON error"); return; }
  const char* cmd = req["cmd"] | "reset";

  JsonDocument res;

  if (strcmp(cmd,"print_start")==0) {
    // Reject early if the accelerometer failed to initialise - otherwise the
    // handler happily enters MEAS_PRINT and the loop's 5-second silence
    // detector (R20.35) aborts with a confusing "disconnect" message.
    if (!adxlOK) {
      res["ok"] = false; res["error"] = "adxl_not_ready";
      sendJson(res); return;
    }
    // v1.0: start a dual-axis print measurement (resets the dual DSP)
    if (!cfg.useCalWeights) {
      res["ok"] = false; res["error"] = "calibration_required";
      sendJson(res); return;
    }
    // print_start: stop any live SSE streaming and reset the dual-axis DSP
    // accumulators so the fresh capture does not inherit stale live-mode PSDs.
    liveMode = false;
    dspResetDual();
    measState = MEAS_PRINT;
    ledState  = LED_BLINK;
    res["ok"] = true; res["state"] = "print";
    Serial.println("[MEAS] print measurement started (dual-axis DSP)");
  }
  else if (strcmp(cmd,"print_stop")==0) {
    // v1.0: finalise print measurement and snapshot the PSDs.
    // Guard: without an active print, dspDualPsd* holds stale/zero data and
    // we'd happily persist it to NVS with measPsdValid=true. Reject if
    // not currently in MEAS_PRINT so the snapshot reflects real samples.
    if (measState != MEAS_PRINT) {
      res["ok"] = false;
      res["error"] = "not_in_print";
      res["state"] = (measState == MEAS_DONE) ? "done" : "idle";
      sendJson(res); return;
    }
    dspUpdateDual();
    // Take a snapshot of the current PSDs so future reads are stable
    memset(measPsdX, 0, sizeof(measPsdX));
    memset(measPsdY, 0, sizeof(measPsdY));
    memset(measVarX, 0, sizeof(measVarX));
    memset(measVarY, 0, sizeof(measVarY));
    memset(measJerkX, 0, sizeof(measJerkX));
    memset(measJerkY, 0, sizeof(measJerkY));
    measSampleRate = cfg.sampleRate;
    measBinMin = dspBinMin();
    measBinCount = currentPsdBinCount();
    for (int k = measBinMin, i = 0; i < measBinCount; k++, i++) {
      measPsdX[i] = dspDualPsdX[k]; measPsdY[i] = dspDualPsdY[k];
      measVarX[i] = dspDualVarX[k]; measVarY[i] = dspDualVarY[k];
      measJerkX[i] = dspJerkPsdX[k]; measJerkY[i] = dspJerkPsdY[k];
    }
    measPsdValid = true;
    saveMeasPsdToNVS();  // persist the snapshot across reboots
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
    Serial.printf("[MEAS] done: X:%.1fHz/%d Y:%.1fHz/%d gate:%.0f%% corr:%.0f%%\n",
      peakFreqX, segCountX, peakFreqY, segCountY,
      dspDualGateRatio()*100, dspDualCorrelation()*100);
  }
  else if (strcmp(cmd,"stop")==0) {
    // Stop command: finalise the current measurement as DONE (not a full reset).
    // If we are mid-print, snapshot the PSD peaks so the client can still read them.
    if (measState == MEAS_PRINT) {
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


// ============ GET /api/measure/status ============
void handleMeasStatus() {
  JsonDocument doc;
  // v1.0: three measurement states (IDLE=0, PRINT=1, DONE=2)
  const char* stStr[] = {"idle","print","done"};
  doc["state"]       = stStr[measState];
  doc["measState"]   = stStr[measState];
  // Print-Measure fields: include X/Y convergence + gate ratio
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
      if (fabs(k * dspFreqRes() - st.peakFreq) > 15.0f) { noise += dspPsdAccum[k]; nc++; }
    }
    if (nc > 0 && noise/nc > 0) doc["snrDb"] = 10.0f * log10f(st.peakPower / (noise/nc));
  }
  sendJson(doc);
}

// ============ Deep sleep timeout ============
// 5 minutes of inactivity before the MCU drops into deep sleep to save power.
#define DEEP_SLEEP_TIMEOUT_MS  (5 * 60 * 1000)
static unsigned long lastActivityMs = 0;

// ============ Live-mode SSE handler ============
// v0.9: live SSE stream broadcasts the short-time FFT PSD as it accumulates
void handleLiveStream() {
  WiFiClient client = server.client();
  client.println("HTTP/1.1 200 OK");
  client.println("Content-Type: text/event-stream");
  client.println("Cache-Control: no-cache");
  client.println("Connection: keep-alive");
  client.println("Access-Control-Allow-Origin: *");
  client.println();
  // R72: stop any previous live client (avoids orphan sockets)
  if (liveSSEClient && liveSSEClient.connected()) {
    liveSSEClient.stop();
  }
  liveSSEClient = client;
  liveSSEClient.setTimeout(3);  // R27.1: 3s send timeout so a stuck client cannot block the loop
  liveMode = true;
  dspReset();
  // Dual-axis accumulators drive the live SSE payload (bx[]/by[] come from
  // dspDualPsdX/Y). Without resetting them here, the first frames of a new
  // live session carry stale data from a prior print or live session - most
  // visibly when reconnecting after a MEAS_DONE finish. Only reset when not
  // in an active print so we don't wipe an in-progress measurement.
  if (measState != MEAS_PRINT) {
    dspResetDual();
  }

  liveSegReset = 0;
  Serial.println("[LIVE] SSE stream started");
}

void handleLiveStop() {
  liveMode = false;
  if (liveSSEClient.connected()) liveSSEClient.stop();
  server.send(200, "application/json", "{\"ok\":true}");
  Serial.println("[LIVE] SSE stream stopped");
}

// v0.9: WiFi scan endpoint
void handleWifiScan() {
  // WiFi.scanNetworks blocks the main loop for up to 3.3 s (11 channels x
  // 300 ms). During that window the ADXL FIFO (32 samples = 10 ms at
  // 3200Hz) overflows repeatedly and the DSP gets a 3.3 s gap in its
  // segment stream - a full print measurement run can be spoiled by a
  // settings-page WiFi scan. Reject during an active print.
  if (measState == MEAS_PRINT) {
    server.send(409, "application/json",
      "{\"ok\":false,\"error\":\"scan_blocked_during_measurement\"}");
    return;
  }
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
  // R68: Brown-out detection - ESP32-C3 sdkconfig default ~2.7V BOD is enabled
  #ifdef CONFIG_ESP_SYSTEM_BROWNOUT_DET
  // No runtime code needed - handled by hardware + sdkconfig
  #endif
  // USB CDC: wait up to 3s for Serial to come up (host may connect late)
  unsigned long waitStart = millis();
  while (!Serial && (millis() - waitStart < 3000)) { delay(10); }
  delay(200);

  // Detect wake-up cause (deep sleep recovery path)
  esp_sleep_wakeup_cause_t wakeup = esp_sleep_get_wakeup_cause();
  if (wakeup == ESP_SLEEP_WAKEUP_GPIO) {
    Serial.println("[WAKE] GPIO wakeup (reset button)");
  } else if (wakeup != ESP_SLEEP_WAKEUP_UNDEFINED) {
    Serial.printf("[WAKE] cause: %d\n", wakeup);
  }

  lastActivityMs = millis();

  Serial.println("=== FEMTO SHAPER v0.9 ===");

  // R31/R78: mount LittleFS with format-on-failure disabled
  //         (auto-format on failure can wipe user files silently)
  // On failure we format explicitly instead of using begin(true).
  if (!LittleFS.begin(false)) {
    Serial.println("[ERROR] LittleFS mount failed - attempting reformat (DATA WILL BE LOST)");
    LittleFS.format();
    if (!LittleFS.begin(false)) {
      Serial.println("[FATAL] LittleFS unusable even after format - API-only mode");
    } else {
      Serial.println("[LittleFS] reformat + remount OK");
    }
  } else {
    Serial.println("[LittleFS] mount OK");
  }
  File root = LittleFS.open("/");
  File f = root.openNextFile();
  while (f) { Serial.printf("  %s (%dB)\n",f.name(),f.size()); f=root.openNextFile(); }

  loadConfig();  // load config (includes GPIO pin mapping used below)
  // Apply GPIO pin mapping now that we have the (possibly NVS) values
  pinMode(cfg.pinLED, OUTPUT);
  digitalWrite(cfg.pinLED, HIGH);  // OFF
  pinMode(cfg.pinReset, INPUT_PULLUP); // reset button

  adxlOK = adxlInit();
  Serial.printf("[ADXL] %s\n", adxlOK ? "OK" : "FAIL");

  // Restore background PSD from NVS.
  // v0.8 legacy format: 513-bin flat array keyed as "b0". Detect and purge so
  // the current 59-bin format (loadBgPsdFromNVS) can take over.
  {
    prefs.begin("femto_bg", true);  // read-only probe
    bool hasLegacy = prefs.isKey("b0");
    prefs.end();
    if (hasLegacy) {
      prefs.begin("femto_bg", false);  // reopen for write
      prefs.clear();
      prefs.end();
      Serial.println("[NVS] Cleared legacy 513-bin bgPsd");
    }
  }
  loadBgPsdFromNVS();
  loadMeasPsdFromNVS();  // v1.0: restore last measurement PSD snapshot

  // ============ WiFi bring-up (AP / STA by cfg.wifiMode) ============
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

  // Try STA mode first (if configured)
  if (strcmp(cfg.wifiMode,"sta")==0 && strlen(cfg.staSSID) > 0) {
    Serial.printf("[WiFi] STA mode ->connecting to '%s'...\n", cfg.staSSID);
    WiFi.mode(WIFI_STA);
    WiFi.setHostname(cfg.hostname);  // v1.0: mDNS hostname
    WiFi.setTxPower(txPower);
    WiFi.begin(cfg.staSSID, cfg.staPass);

    // Wait up to 15s for STA association
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
      Serial.println("[WiFi] STA failed - fallback to AP mode");
      WiFi.disconnect(true);
      delay(100);
    }
  }

  // AP fallback (also the default when STA is not configured)
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
      Serial.printf("[WiFi] AP start failed - retry %d/3\n", attempt);
      WiFi.softAPdisconnect(true);
      delay(200);
    }

    Serial.printf("[WiFi] AP: %s @ %s (TX: %ddBm) Heap: %u\n",
      AP_SSID, WiFi.softAPIP().toString().c_str(), txPowerLevel, ESP.getFreeHeap());

    if (!apStarted) {
      Serial.println("[WiFi] AP failed - reboot in 5s");
      delay(5000);
      ESP.restart();
    }
  }

  // DNS server: when in AP mode, redirect every hostname to the captive portal.
  if (!staConnected) {
    dnsServer.start(53, "*", AP_IP);
    Serial.println("[DNS] captive-portal DNS started");
  }

  // mDNS: advertise <hostname>.local (STA mode only)
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

  server.on("/api/config",      HTTP_GET,  handleGetConfig);
  server.on("/api/noise",       HTTP_GET,  handleGetNoise);
  server.on("/api/config",      HTTP_POST, handlePostConfig);
  server.on("/api/debug",       HTTP_GET,  handleDebugGet);
  server.on("/api/debug",       HTTP_POST, handleDebugPost);
  server.on("/api/led",         HTTP_POST, handleLed);
  server.on("/api/result",      HTTP_GET,  handleLoadResult);
  server.on("/api/result",      HTTP_POST, handleSaveResult);
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
  server.on("/api/wifi/scan",      HTTP_GET,  handleWifiScan);
  server.on("/api/reboot",         HTTP_POST, []() {
    server.send(200, "application/json", "{\"ok\":true}");
    delay(500);
    ESP.restart();
  });
  // R18.23: factory reset - wipes all NVS namespaces.
  //         POST /api/reset?all=1 clears everything and reboots.
  // R26.1: cap the query string at 4 bytes so "all=1" is the only valid value.
  server.on("/api/reset", HTTP_POST, []() {
    String allArg = server.arg("all");
    if (allArg.length() > 4) { server.send(400, "application/json", "{\"ok\":false,\"error\":\"bad_arg\"}"); return; }
    bool all = (allArg == "1");
    if (all) {
      // Must match every namespace written anywhere in this firmware:
      //   "femto"       - cfg (loadConfig / saveConfig)
      //   "femto_bg"    - background PSD (saveBgPsdToNVS)
      //   "femto_mpsd"  - measured PSD snapshot (saveMeasPsdToNVS)
      //   "femto_res"   - last shaper result (handleSaveResult) *not "femto_result"*
      //   "femto_diag"  - diagnosis report (handleSaveDiag)
      const char* ns[] = {"femto", "femto_bg", "femto_mpsd", "femto_res", "femto_diag"};
      const size_t nsCount = sizeof(ns) / sizeof(ns[0]);
      for (size_t i = 0; i < nsCount; i++) {
        if (prefs.begin(ns[i], false)) { prefs.clear(); prefs.end(); }
      }
      Serial.println("[RESET] Factory reset - all NVS cleared");
      server.send(200, "application/json", "{\"ok\":true,\"reset\":\"all\"}");
    } else {
      server.send(200, "application/json", "{\"ok\":true,\"reset\":\"none\"}");
    }
    delay(500);
    ESP.restart();
  });
  server.on("/favicon.ico", []() { server.send(204,"text/plain",""); });

  // ============ Captive-portal probe URLs ============
  // Android/iOS/Windows/Firefox all probe well-known URLs to detect
  // captive portals; we respond 302 to the portal root so the phone/PC
  // shows the "sign in to network" prompt.
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
    server.send(200, "text/plain", "success");  // Firefox captive-portal probe
  });
  // SPA fallback: unknown URLs serve index.html so client-side routing works
  // + avoids 404s on direct tab reloads.
  server.onNotFound([]() {
    serveFile("/index.html", "text/html");
  });

  server.begin();
  Serial.println("[HTTP] server ready at http://192.168.4.1");
}

// Main loop and background-noise bootstrap.
static const int BOOT_NOISE_TARGET = 1024 + 9 * DSP_STEP; // 10 segments (~0.8 s)

void loop() {
  dnsServer.processNextRequest();  // Keep captive-portal DNS responsive.
  server.handleClient();

  if (adxlOK) {
    adxlUpdate();

    // Capture a startup background PSD before Wi-Fi or UI activity adds noise.
    if (!bootNoiseDone && measState == MEAS_IDLE) {
      if (bootNoiseSamples == 0) {
        dspBgSegs = 0;           // Start fresh before deciding whether to keep or fall back.
        dspReset();
      }
      while (adxlCount > 0 && bootNoiseSamples < BOOT_NOISE_TARGET) {
        AdxlSample s = adxlBuf[adxlHead];
        adxlHead  = (adxlHead + 1) % ADXL_BUF_SIZE;
        adxlCount--;
        // Project startup capture onto the calibrated X axis when available.
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
          // Compare early vs late segments so a shaky startup capture can be rejected.
          // dspBgPsd already contains the first 5 segments from dsp.h.
          // _psdSum / _segCount is the total average, so derive the later average from it.
          float eFirst = 0, eSecond = 0;
          for (int k = dspBinMin(); k <= dspBinMax(); k++) {
            if (_segCount <= 0) break;
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
            // Stable enough: keep the live capture as the background PSD.
            dspUpdateAccum();
            for (int k = dspBinMin(); k <= dspBinMax(); k++)
              dspBgPsd[k] = dspPsdAccum[k];
            saveBgPsdToNVS();
            Serial.printf("[BOOT] bgPsd OK (ratio=%.2f, %d samples)\n", ratio, bootNoiseSamples);
          } else {
            // Startup noise was inconsistent, so fall back to the last saved PSD.
            loadBgPsdFromNVS();
            Serial.printf("[BOOT] bgPsd inconsistent (ratio=%.2f) ->NVS fallback\n", ratio);
          }
        } else {
          // No valid startup capture; restore the last saved background PSD.
          loadBgPsdFromNVS();
          Serial.println("[BOOT] Capture failed ->NVS fallback restored");
        }
        // Recompute the sweep-detection baseline from the final background PSD.
        dspBgEnergy = 0;
        for (int k = dspBinMin(); k <= dspBinMax(); k++) dspBgEnergy += dspBgPsd[k];
        if (dspBgEnergy < 50.0f) dspBgEnergy = 50.0f;
        Serial.printf("[BOOT] bgEnergy=%.0f ->sweep threshold base\n", dspBgEnergy);
        dspReset();  // Resume normal sweep detection after boot-noise capture.
      }
    }

    // Print Measure DSP pipeline.
    else if (measState == MEAS_PRINT) {
      const float scale = 0.0039f * 9.80665f;  // Convert raw ADXL units to m/s^2.
      // R20.35: Abort if the ADXL stream goes silent for too long during a run.
      static uint32_t _measStartMs = 0;
      static uint32_t _measSamples = 0;
      if (_measStartMs == 0) { _measStartMs = millis(); _measSamples = 0; }
      if (millis() - _measStartMs > 5000 && _measSamples < 100) {
        Serial.println("[ADXL] disconnect detected during measurement - aborting");
        measState = MEAS_IDLE;
        ledState = LED_OFF;
        _measStartMs = 0; _measSamples = 0;
        return;
      }
      while (adxlCount > 0) {
        AdxlSample s = adxlBuf[adxlHead];
        adxlHead  = (adxlHead + 1) % ADXL_BUF_SIZE;
        adxlCount--;
        _measSamples++;
        float ax = s.x * scale, ay = s.y * scale, az = s.z * scale;
        float projX = cfg.calWx[0]*ax + cfg.calWx[1]*ay + cfg.calWx[2]*az;
        float projY = cfg.calWy[0]*ax + cfg.calWy[1]*ay + cfg.calWy[2]*az;
        dspFeedDual(projX, projY);
      }
      if (dspDualNewSeg) {
        dspDualNewSeg = false;
        if (liveSSEClient.connected()) {
          dspUpdateDual();
          // Array reference alias to the file-scope static buffer (preserves
          // sizeof(buf) in all the len-checks below). See _sseBuf declaration.
          char (&buf)[sizeof(_sseBuf)] = _sseBuf;
          // fr/bm expose the bin geometry so clients can label axes correctly
          // at any cfg.sampleRate (live chart used to hard-code 3.125Hz/bin).
          int len = snprintf(buf, sizeof(buf),
            "data: {\"m\":\"print\",\"sx\":%d,\"sy\":%d,\"st\":%d,\"gr\":%.2f,\"fr\":%.4f,\"bm\":%d,\"bx\":[",
            dspDualSegCountX(), dspDualSegCountY(), dspDualSegTotal(), dspDualGateRatio(),
            dspFreqRes(), dspBinMin());
          int binMin = dspBinMin();
          int binMax = dspBinMax();
          for (int k=binMin; k<=binMax && len<(int)sizeof(buf)-12; k++) {
            if (k>binMin && len<(int)sizeof(buf)-2) buf[len++]=',';
            float v = dspDualPsdX[k];
            if (v<0.01f && len<(int)sizeof(buf)-2) { buf[len++]='0'; }
            else if (v>=100) len+=snprintf(buf+len,sizeof(buf)-len,"%.0f",v);
            else if (v>=1)   len+=snprintf(buf+len,sizeof(buf)-len,"%.1f",v);
            else             len+=snprintf(buf+len,sizeof(buf)-len,"%.2f",v);
          }
          len += snprintf(buf+len, sizeof(buf)-len, "],\"by\":[");
          for (int k=binMin; k<=binMax && len<(int)sizeof(buf)-12; k++) {
            if (k>binMin && len<(int)sizeof(buf)-2) buf[len++]=',';
            float v = dspDualPsdY[k];
            if (v<0.01f && len<(int)sizeof(buf)-2) { buf[len++]='0'; }
            else if (v>=100) len+=snprintf(buf+len,sizeof(buf)-len,"%.0f",v);
            else if (v>=1)   len+=snprintf(buf+len,sizeof(buf)-len,"%.1f",v);
            else             len+=snprintf(buf+len,sizeof(buf)-len,"%.2f",v);
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
        // In live mode, keep dual-axis DSP running outside of print measurement too.
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
            projX = ax; projY = ay;  // Default to the sensor's native X/Y axes.
          }
          dspFeedDual(projX, projY);
        }
        // Publish SSE updates every cfg.liveSegs segments and reset after 30 segments.
        int segNow = dspDualSegTotal();
        if (segNow - liveSegReset >= cfg.liveSegs) {
          liveSegReset = segNow;
          dspUpdateDual();
          if (liveSSEClient.connected()) {
            // Reuse the shared static SSE buffer (see _sseBuf declaration and
            // BF-R14-001). Array reference preserves sizeof() behaviour for
            // the len-checks below.
            char (&buf)[sizeof(_sseBuf)] = _sseBuf;
            // fr/bm added so clients can derive Hz-per-bin at any sampleRate.
            int len = snprintf(buf, sizeof(buf),
              "data: {\"m\":\"live\",\"sx\":%d,\"sy\":%d,\"fr\":%.4f,\"bm\":%d,\"bx\":[",
              dspDualSegTotal(), dspDualSegTotal(),
              dspFreqRes(), dspBinMin());
            int binMin = dspBinMin();
            int binMax = dspBinMax();
            for (int k=binMin; k<=binMax && len<(int)sizeof(buf)-12; k++) {
              if (k>binMin && len<(int)sizeof(buf)-2) buf[len++]=',';
              float v = dspDualPsdX[k];
              if (v<0.01f && len<(int)sizeof(buf)-2) { buf[len++]='0'; }
              else if (v>=100) len+=snprintf(buf+len,sizeof(buf)-len,"%.0f",v);
              else if (v>=1)   len+=snprintf(buf+len,sizeof(buf)-len,"%.1f",v);
              else             len+=snprintf(buf+len,sizeof(buf)-len,"%.2f",v);
            }
            len += snprintf(buf+len, sizeof(buf)-len, "],\"by\":[");
            for (int k=binMin; k<=binMax && len<(int)sizeof(buf)-12; k++) {
              if (k>binMin && len<(int)sizeof(buf)-2) buf[len++]=',';
              float v = dspDualPsdY[k];
              if (v<0.01f && len<(int)sizeof(buf)-2) { buf[len++]='0'; }
              else if (v>=100) len+=snprintf(buf+len,sizeof(buf)-len,"%.0f",v);
              else if (v>=1)   len+=snprintf(buf+len,sizeof(buf)-len,"%.1f",v);
              else             len+=snprintf(buf+len,sizeof(buf)-len,"%.2f",v);
            }
            float pkX = dspDualFindPeak(dspDualPsdX, 1, NULL);
            float pkY = dspDualFindPeak(dspDualPsdY, 1, NULL);
            len += snprintf(buf+len, sizeof(buf)-len,
              "],\"pkx\":%.1f,\"pky\":%.1f}\n\n", pkX, pkY);
            liveSSEClient.write((uint8_t*)buf, len);
          }
          // Reset periodically so the live PSD stays responsive instead of growing forever.
          if (segNow >= 30) {
            dspResetDual();
            liveSegReset = 0;
          }
          if (!liveSSEClient.connected()) { liveMode = false; }
        }
      } else {
        // Keep the raw ring buffer from overflowing when DSP is idle.
        if (adxlCount > 32) {
          uint8_t drop = adxlCount - 4;
          adxlHead = (adxlHead + drop) % ADXL_BUF_SIZE;
          adxlCount -= drop;
        }
      }
    }
  }

  // ============ 30-second AP watchdog + heap-pressure check ============
  if (millis() - lastApCheck > 30000) {
    lastApCheck = millis();

    // Free heap check - if below 40KB, WiFi stack may become unstable
    uint32_t freeHeap = ESP.getFreeHeap();
    if (freeHeap < 40000) {
      Serial.printf("[HEAP] low: %u bytes - WiFi may become unstable\n", freeHeap);
      // Only reboot if we are idle - avoid killing an active measurement
      if (measState == MEAS_IDLE || measState == MEAS_DONE) {
        if (freeHeap < 20000) {
          Serial.println("[HEAP] critical low - rebooting");
          ESP.restart();
        }
      }
    }

    // WiFi status check + recovery.
    // During MEAS_PRINT we avoid the fallback / reinit paths (each has
    // ~300-900 ms of delay() that would leave a measurement-ruining gap
    // in the DSP segment stream). Non-blocking WiFi.reconnect() is still
    // fine, so STA-reconnect is allowed; full STA->AP fallback and AP
    // reinit are deferred until the measurement ends.
    if (WiFi.status() == WL_CONNECTED) {
      // STA connected - reset AP failure counter
      apFailCount = 0;
    } else if (strcmp(cfg.wifiMode,"sta")==0 && WiFi.status() != WL_CONNECTED) {
      // STA lost its connection: try reconnect, then fall back to AP
      apFailCount++;
      Serial.printf("[WiFi] STA reconnect %d/3\n", apFailCount);
      if (apFailCount <= 2) {
        WiFi.reconnect();
      } else if (measState == MEAS_PRINT) {
        // Defer blocking fallback - don't let WiFi recovery tear up an
        // active measurement. Counter is left at 3+, so we'll retry on
        // the next 30s watchdog tick once measurement leaves PRINT.
        Serial.println("[WiFi] STA fallback deferred (MEAS_PRINT active)");
      } else {
        Serial.println("[WiFi] STA failed - fallback to AP");
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
      // AP not up. Recovery uses delay() up to ~900 ms; skip during an
      // active measurement (see comment above for rationale).
      if (measState == MEAS_PRINT) {
        Serial.println("[WiFi] AP recovery deferred (MEAS_PRINT active)");
      } else {
      apFailCount++;
      Serial.printf("[WiFi] AP recovery attempt %d/3 (heap: %u)\n", apFailCount, freeHeap);
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
        WiFi.setTxPower(txPower); // restore configured TX power
        WiFi.softAPConfig(AP_IP, AP_IP, IPAddress(255,255,255,0));
        WiFi.softAP(AP_SSID, nullptr, 1, 0, 4);
        dnsServer.start(53, "*", AP_IP);
      } else {
        Serial.println("[WiFi] Stage 3 failed - rebooting");
        ESP.restart();
      }
      }  // end of measState != MEAS_PRINT AP-recovery branch
    } else {
      apFailCount = 0;
    }
  }

  if (ledState != LED_BLINK)
    ledState = WiFi.softAPgetStationNum() > 0 ? LED_ON : LED_OFF;
  updateLed();

  // ============ GPIO reset-button watchdog ============
  // R29.1/R29.2: Reset button - edge-triggered state machine + noise filter
  // 3x consecutive LOW confirms press; fires ESP.restart() ONLY on release (HIGH transition)
  static uint8_t _resetLowCount = 0;
  static bool _resetPressed = false;
  if (digitalRead(cfg.pinReset) == LOW) {
    if (_resetLowCount < 3) _resetLowCount++;
    if (_resetLowCount >= 3 && !_resetPressed) {
      _resetPressed = true;
      Serial.println("[RESET] Button pressed (release to restart)");
    }
  } else {
    if (_resetPressed) {
      Serial.println("[RESET] Button released - restarting");
      delay(100);
      ESP.restart();
    }
    _resetLowCount = 0;
    _resetPressed = false;
  }

  // ============ Activity watchdog (5-minute idle deep-sleep) ============
  // Any connected client or active measurement postpones sleep.
  if (WiFi.softAPgetStationNum() > 0 || measState != MEAS_IDLE) {
    lastActivityMs = millis();
  }
  // Sleep after 5 minutes of no activity
  if (millis() - lastActivityMs > DEEP_SLEEP_TIMEOUT_MS) {
    Serial.println("[SLEEP] 5min idle ->deep sleep (press reset to wake)");
    WiFi.mode(WIFI_OFF);
    delay(100);
    esp_deep_sleep_enable_gpio_wakeup(1ULL << cfg.pinReset, ESP_GPIO_WAKEUP_GPIO_LOW);
    esp_deep_sleep_start();
  }
}
