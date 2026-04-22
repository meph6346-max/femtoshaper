// ============================================================
// FEMTO SHAPER ESP32-C3 Firmware v0.8
// ?類???????쒓낯??癲ル슢?꾤땟戮⑤뭄?
//   1. CS pinMode??SPI.begin() ???⑤챷??????源놁젳 (??れ꽔??域밸Ŧ逾???袁⑸젻泳?)
//   2. FIFO bypass??紐?ream ??ш낄援?????域밸Ŧ遊????⑤베堉?
//   3. GPIO0 INT1: INPUT_PULLUP ???ㅼ굣??(??딅텑??嶺? ???源놁젳??
//   4. adxl_test.js ??繹먮끏裕????⑤베堉?
//   5. ??縕??묒땡?handleSaveBelt/LoadBelt ?????//   6. adxlFifoReady ISR????節뉗땡????ㅼ뒧??(?濡ろ뜑??????ㅼ뒦????癰귙끋源?
//   7. INT_SOURCE ????????ISR ?濚밸Ŧ援욃ㅇ?//
// ?嶺뚮Ĳ????袁⑸즲?節덈빝?(??筌뤾퍓??:
//   SCL ??GPIO4 (SCK/MISO)
//   SDO ??GPIO2 (MISO)
//   SDA ??GPIO3 (MOSI)
//   CS  ??GPIO1
//   INT1??GPIO0
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

// v0.9: String ??癰귙끋源??????살쓴?? JSON ???쑩?젆??類????(?????????袁⑸젻泳?)
static char _jbuf[8192];  // v1.0: ????PSD (binsX+binsY+bgPsd) ~6.2KB
inline void sendJson(JsonDocument& doc) {
  // R32: measureJson() predicts length before serializing to prevent truncation
  size_t need = measureJson(doc);
  if (need + 1 >= sizeof(_jbuf)) {
    Serial.printf("[JSON] Response too large: %u > %u
", (unsigned)need, (unsigned)sizeof(_jbuf));
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
  if (server.arg("plain").length() > maxBytes) {
    server.send(413, "application/json", "{\"ok\":false,\"error\":\"body_too_large\"}");
    return false;
  }
  return true;
}
DNSServer   dnsServer;
Preferences prefs;

// ???? Config (??ш끽維????癲ル슢?꾤땟?????縕?????????? ????????????????????????????
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
  // v0.9: ??癲????⑤???????⑤젰????좊읈?濚욌꼬?댄꺍??(?類?뺨??щ빝?????
  // printerX = calWx[0]*ax + calWx[1]*ay + calWx[2]*az
  float  calWx[3] = {1, 0, 0};  // ??れ삀??? ADXL X ????ш끽諭욥??X
  float  calWy[3] = {0, 1, 0};  // ??れ삀??? ADXL Y ????ш끽諭욥??Y
  bool   useCalWeights = false;
  // v0.9: WiFi STA 癲ル슢?꾤땟???
  char wifiMode[8] = "ap";
  char staSSID[33] = "";
  char staPass[65] = "";
  char hostname[32] = "femto";  // v1.0: mDNS ?嶺뚮ㅎ?ц짆?嶺뚮ㅎ?붹뤃?(hostname.local)
  int    powerHz  = 60;  // ??ш끽維????낆뒩????(60/50/0)
  int    liveSegs = 2;   // ??繹먮끏???SSE ??ш끽維뽬땻???낆뒩??곷뎨?(?嶺뚮∥梨??沃섅굥???
} cfg;

// ???? LED (Active Low, GPIO8 = BUILTIN LED) ??????????????????????
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

// ??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已?
// ADXL345 ??筌먦끇??????
// ??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已?

// ???? ?嶺뚮Ĳ????? ?袁⑸즲?節덈빝?????????????????????????????????????????????????????????????????????????
#define ADXL_SCK   4   // GPIO4 = SCK  (SCL??
#define ADXL_MISO  2   // GPIO2 = MISO (SDO??
#define ADXL_MOSI  3   // GPIO3 = MOSI (SDA??
#define ADXL_CS    1   // GPIO1 = CS
#define ADXL_INT1  0   // GPIO0 = INT1 (RISING癲?????

// ???? ??????袁⑸뙃 ??낆뒩???????????????????????????????????????????????????????????????????????????
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

// ???? ???얜?源?????깼???삳읁???????????????????????????????????????????????????????????????????????????
struct AdxlSample { int16_t x, y, z; };

// ???? ???ㅺ컼???怨뚮뼚?????????????????????????????????????????????????????????????????????????????????
static bool    adxlOK    = false;
static bool    bootNoiseDone = false;
static int     bootNoiseSamples = 0;
static uint8_t adxlDevId = 0;

#define ADXL_BUF_SIZE 64
static AdxlSample adxlBuf[ADXL_BUF_SIZE];
static uint8_t    adxlHead  = 0;
static uint8_t    adxlCount = 0;

static volatile bool adxlFifoReady = false;  // ISR????節뉗땡????ㅼ뒧??
// ???얜?源???源낇꼧??癲ル쉵?猷??
static uint32_t adxlRateSamples   = 0;
static uint32_t adxlRateStart     = 0;
static float    adxlRateHz        = 0.0f;
static bool     adxlRateMeasuring = false;

// ???? ISR ????????????????????????????????????????????????????????????????????????????????????????????
void IRAM_ATTR adxlISR() {
  adxlFifoReady = true;
}

// ???? SPI R/W ??????????????????????????????????????????????????????????????????????????????????
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

// ???? ?縕?猿녿뎨??????????????????????????????????????????????????????????????????????????????????????
bool adxlInit() {
  Serial.printf("[ADXL] ??: SCK=%d MISO=%d MOSI=%d CS=%d INT1=%d\n",
    cfg.pinSCK, cfg.pinMISO, cfg.pinMOSI, cfg.pinCS, cfg.pinINT1);

  // CS???沃섅굥?? HIGH??(SPI ?????????ㅺ컼??
  pinMode(cfg.pinCS, OUTPUT);
  digitalWrite(cfg.pinCS, HIGH);
  delay(10);

  // SPI ??筌믨퀣援???SS=-1????嚥▲꺃彛?CS ??ш끽維??  SPI.end();  // ?????????⑤챷?????ㅺ컼????????  SPI.begin(cfg.pinSCK, cfg.pinMISO, cfg.pinMOSI, -1);
  SPI.setFrequency(1000000);  // ?縕?猿녿뎨????1MHz (???源놁젳?????Β?띾쭡)
  SPI.setDataMode(SPI_MODE3);
  delay(50);  // SPI ???源놁젳??????
  // INT1 ?? ???源놁젳
  pinMode(cfg.pinINT1, INPUT_PULLUP);
  delay(10);

  // DevID ??熬곣뱿逾???3???????  adxlDevId = 0;
  for (int attempt = 1; attempt <= 3; attempt++) {
    // CS ?????ADXL345 SPI ???ㅺ컼???域밸Ŧ遊??
    digitalWrite(cfg.pinCS, HIGH);
    delay(5);
    digitalWrite(cfg.pinCS, LOW);
    delay(1);
    digitalWrite(cfg.pinCS, HIGH);
    delay(5);

    adxlDevId = spiRead(REG_DEVID);
    Serial.printf("[ADXL] ??筌먲퐣??%d/3: DevID=0x%02X %s\n",
      attempt, adxlDevId, adxlDevId == 0xE5 ? "OK" : "FAIL");

    if (adxlDevId == 0xE5) break;
    delay(50);
  }

  if (adxlDevId != 0xE5) {
    Serial.println("[ADXL] ?縕?猿녿뎨??????됰꽡 ???袁⑸즲?節덈빝??嶺뚮Ĳ?됮?");
    Serial.printf("  SCK???좊퀎IO%d  MISO???좊퀎IO%d  MOSI???좊퀎IO%d  CS???좊퀎IO%d\n",
      cfg.pinSCK, cfg.pinMISO, cfg.pinMOSI, cfg.pinCS);
    return false;
  }

  // SPI ????뽦뵣??5MHz??????(?嶺뚮Ĳ?놅쭕????筌?????뽦뵣)
  SPI.setFrequency(5000000);

  spiWrite(REG_POWER_CTL, 0x00);  // Standby
  delay(5);

  // BW_RATE: Settings sampleRate ??ADXL BW_RATE ??????袁⑸뙃 癲ル슢???⑸눀?
  uint8_t bwRate = 0x0F; // ??れ삀???3200Hz
  if      (cfg.sampleRate <= 400)  bwRate = 0x0C;
  else if (cfg.sampleRate <= 800)  bwRate = 0x0D;
  else if (cfg.sampleRate <= 1600) bwRate = 0x0E;
  else                             bwRate = 0x0F;
  spiWrite(REG_BW_RATE, bwRate);
  // R66: ?怨뚮┛ ??readback 野꺜筌?(SPI ???뻿 ??곴맒 鈺곌퀗由?揶쏅Ŋ?)
  {
    uint8_t vr = spiRead(REG_BW_RATE);
    if (vr != bwRate) {
      Serial.printf("[ADXL] BW_RATE verify FAILED: wrote 0x%02X, read 0x%02X\n", bwRate, vr);
      return false;
    }
  }
  Serial.printf("[ADXL] BW_RATE=0x%02X (%dHz) verified\n", bwRate, cfg.sampleRate);
  spiWrite(REG_DATA_FORMAT, 0x08);  // Full Res, 嶺?g

  // FIFO: bypass ??stream (?域밸Ŧ遊??
  spiWrite(REG_FIFO_CTL, 0x00);  // bypass
  delay(1);
  spiWrite(REG_FIFO_CTL, 0x99);  // Stream + WM=25

  spiWrite(REG_INT_MAP,    0x00);  // 癲ル슢?꾤땟?嶺?INT1
  spiWrite(REG_INT_ENABLE, 0x02);  // ???⑤슣?됵┼??뵯??먯물???筌????
  // ISR ?濚밸Ŧ援욃ㅇ???INT_SOURCE ??????  spiRead(REG_INT_SOURCE);

  attachInterrupt(digitalPinToInterrupt(cfg.pinINT1), adxlISR, RISING);

  spiWrite(REG_POWER_CTL, 0x08);  // Measurement ON
  delay(5);

  // ?濡ろ떟?癲? ???Β??????????袁⑸뙃 ??熬곣뱿逾????獒??  int16_t tx, ty, tz;
  spiReadXYZ(tx, ty, tz);
  Serial.printf("[ADXL] ?縕?猿녿뎨????Β???? X=%d Y=%d Z=%d\n", tx, ty, tz);
  Serial.printf("[ADXL] ?縕?猿녿뎨????ш끽維?? %dHz / 嶺?g FR / Stream(WM=25)\n", cfg.sampleRate);
  return true;
}

// ???? FIFO ??筌먦끉???????????????????????????????????????????????????????????????????????????????
static uint32_t _adxlOverflowCount = 0;  // R33: FIFO overflow ??源??燁삳똻???static void adxlDrainFifo() {
  uint8_t rawStatus = spiRead(REG_FIFO_STATUS);
  // R33: ADXL345 FIFO_STATUS bit 7 = overflow ??뽯뻻 - loop() 筌왖??揶쏅Ŋ?
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
  // GPIO0 ISR ??됰씭???????? FIFO STATUS ??????袁⑸뙃 癲ル슣???????鶯?
  // ISR?????쑩?쭪??嚥?????鴉????Ъ? ????嚥??????鶯???⑥???????
  if (adxlFifoReady) {
    adxlFifoReady = false;
    adxlDrainFifo();
  } else {
    // ???鶯? FIFO?????⑤슣?됵┼??뵯??먯물?25) ???⑤?彛??????野껊갭????筌먦끉???    uint8_t entries = spiRead(REG_FIFO_STATUS) & 0x3F;
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

// ??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已?
// ADXL API
// ??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已?

// ???? ??釉먮폏?遺룹쐺????源놁젳 API ????????????????????????????????????????????????????????????????????????
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
  // ISR ???μ쪠?? SPI?????癲ル슣????癲ル슔?됭짆??XYZ ??熬곣뱿逾?
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
    server.send(200, "application/json", "{\"ok\":true,\"msg\":\"癲ル쉵?猷????筌믨퀣援?"}");
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

// ??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已?
// Config
// ??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已??誘딆궠已?
// Config??????????ㅿ폍??????モ닪???bool saveConfig();  // ??ш끽紐욤????モ닪??(loadConfig?????癲???딅텑??????嶺뚮ㅎ???

void loadConfig() {
  // 癲???딅텑?????좊즴??: NVS??"femto" ???源낆뿮????됱뱻???⑤８痢??좊읈? ???⑤챶?뺧┼???れ삀???筌?????  bool firstBoot = false;
  if (!prefs.begin("femto", true)) {  // read-only?????⑤９苑???釉뚰????嶺뚮Ĳ?됮?    prefs.end();
    firstBoot = true;
    Serial.println("[NVS] 癲???딅텑???????れ삀??????源놁젳 ????);
    saveConfig();  // ??れ삀???筌ｋ〃泥???걬??NVS ??獄쏅똻??
  } else {
    prefs.end();
  }

  // ?嶺뚮Ĳ?놅쭕??棺??짆?삠궘?
  // R1.1: read-phase begin() ??쎈솭 ??defaults ?醫? (cfg ??밴쉐??揶?
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
  // v0.9: 癲????⑤???????⑤젰????좊읈?濚욌꼬?댄꺍???棺??짆?삠궘?
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

  // DSP ??釉먯뒭???minSegs ????뗫탿??  dspMinValidSegs = cfg.minSegs;

  dspMinValidSegs = cfg.minSegs;
  dspSetSampleRate((float)cfg.sampleRate);

  // R71: Config ?醫륁뒞??野꺜筌?(NVS ?癒?맒/bit-flip ??defaults 癰귣벀??
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
  // ??ъ쁽 甕곕뗄??野꺜筌?(??뺤쒔 POST??constrain???筌?NVS 嚥≪뮆諭???뽯퓠???????
  cfg.buildX   = constrain(cfg.buildX, 30, 1000);
  cfg.buildY   = constrain(cfg.buildY, 30, 1000);
  cfg.accel    = constrain(cfg.accel, 100, 50000);
  cfg.feedrate = constrain(cfg.feedrate, 10, 1000);
  cfg.sampleRate = constrain(cfg.sampleRate, 400, 3200);
  cfg.minSegs  = constrain(cfg.minSegs, 10, 500);

  // R5.1/R18.24: 筌?꼶?곲뇡??쟿??곷?甕겸돧苑ｅ첎? 疫꿸퀡??첎?[1,0,0]/[0,1,0]????揶쏅벡?ｆ에?useCalWeights=false
  bool isDefaultCal = (cfg.calWx[0] == 1.0f && cfg.calWx[1] == 0.0f && cfg.calWx[2] == 0.0f &&
                       cfg.calWy[0] == 0.0f && cfg.calWy[1] == 1.0f && cfg.calWy[2] == 0.0f);
  if (cfg.useCalWeights && isDefaultCal) {
    cfg.useCalWeights = false;
    Serial.println("[CFG] useCalWeights=true with default vectors - forced to false");
  }
  // R42: Cal 甕겸돧苑???μ맄 ?類?뇣??(???????봔??덈꺖????뺚봺?袁る뱜嚥?magnitude揶쎛 1.0???袁⑤빜 ????됱벉)
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
    // 筌띾슣鍮??類?뇣???袁⑸퓠??magnitude揶쎛 ??곴맒??롢늺 useCalWeights ??쑵??源딆넅
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

// R4.2: NVS ?怨뚮┛ ??쎈솭 揶쏅Ŋ? - 筌띾뜆?筌?putInt 野껉퀗?득에??癒?뼊 (0 = ??쎈솭)
// 獄쏆꼹?싧첎? true = ?源껊궗, false = NVS ??/??쎈솭
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
  // R4.2: liveSegs ?怨뚮┛ 野껉퀗?득에?NVS 揶쎛??밴쉐 ?癒?젟 (0 = ??쎈솭/??)
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
  // ??ш끽維??WiFi ???ㅺ컼??  doc["wifiConnected"]=(WiFi.status()==WL_CONNECTED);
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
  if (!checkBodyLimit(8192)) return;
  JsonDocument doc;
  if (deserializeJson(doc,server.arg("plain"))) { server.send(400,"text/plain","JSON error"); return; }

  // R20.32: 筌β돦??餓λ쵐肉??sampleRate ??DSP ???뵬沃섎챸苑?癰궰野?筌△뫀??(FFT ????곴맒???븍뜄? 癰귣똻??
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

  // R60.1/2/3: ??ъ쁽 ?袁⑤굡 甕곕뗄??野꺜筌?(???땾/0/?⑥눖猷??揶?椰꾧퀡?)
  if (doc["buildX"].is<int>())      cfg.buildX     = constrain(doc["buildX"].as<int>(), 30, 1000);
  if (doc["buildY"].is<int>())      cfg.buildY     = constrain(doc["buildY"].as<int>(), 30, 1000);
  if (doc["accel"].is<int>())       cfg.accel      = constrain(doc["accel"].as<int>(), 100, 50000);
  if (doc["feedrate"].is<int>())    cfg.feedrate   = constrain(doc["feedrate"].as<int>(), 10, 1000);
  // P-05/P-06 (Codex follow-up): sampleRate 癰궰野???筌?Ŋ???????-rate ?怨쀬뵠???얜똾???  // - measPsd (筌╈돦荑?rate?? ??곌볼 rate ?븍뜆?ょ㎉?獄쎻뫗?)
  // - dspBgPsd (bin 甕곕뗄?욃첎? ??묐탣??됱뵠?紐꾨퓠 ??뤵?- 疫꿸퀣??bg????롢걵??雅뚯눛???롮쨮 ??곴퐤??
  // - dspBgEnergy (sweep threshold 疫꿸퀣?揶?
  if (doc["sampleRate"].is<int>()) {
    int newSR = constrain(doc["sampleRate"].as<int>(), 400, 3200);
    if (newSR != cfg.sampleRate) {
      // ? rate ??? ?? ???
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
      bootNoiseDone = false;   // ?? ??? ??? ???
      bootNoiseSamples = 0;
      Serial.printf("[CFG] sampleRate changed %d -> %d : measPsd/bgPsd invalidated, will recapture noise\n",
                    cfg.sampleRate, newSR);
      cfg.sampleRate = newSR;
    }
  }
  if (doc["kin"].is<const char*>()) strncpy(cfg.kin, doc["kin"] | "corexy", sizeof(cfg.kin)-1);
  if (doc["axesMap"].is<const char*>()) strncpy(cfg.axesMap, doc["axesMap"] | "xyz", sizeof(cfg.axesMap)-1);
  // v0.9: 癲????⑤???????⑤젰????좊읈?濚욌꼬?댄꺍??(JS ?????筌?諭????ш끽維뽬땻?
  if (doc["calWx"].is<JsonArray>() && doc["calWx"].size() == 3) {
    cfg.calWx[0] = doc["calWx"][0]; cfg.calWx[1] = doc["calWx"][1]; cfg.calWx[2] = doc["calWx"][2];
    cfg.calWy[0] = doc["calWy"][0]; cfg.calWy[1] = doc["calWy"][1]; cfg.calWy[2] = doc["calWy"][2];
    cfg.useCalWeights = true;
  }
  // Phase 5: SCV / damping / targetSm ????  if (doc["scv"].is<float>())      cfg.scv        = doc["scv"].as<float>();
  if (doc["damping"].is<float>())  cfg.damping    = doc["damping"].as<float>();
  if (doc["targetSm"].is<float>()) cfg.targetSm   = doc["targetSm"].as<float>();
  if (doc["demoMode"].is<bool>())  cfg.demoMode   = doc["demoMode"].as<bool>();
  if (doc["firmware"].is<const char*>()) strncpy(cfg.firmware, doc["firmware"] | "marlin_is", sizeof(cfg.firmware)-1);
  if (doc["eepromSave"].is<bool>()) cfg.eepromSave = doc["eepromSave"];
  // GPIO ?? ?袁⑸즲???(??????????ㅼ굣??
  // R60.7: GPIO ?? ??깅뻻 ??????餓λ쵎??野꺜筌?  int newSCK = doc["pinSCK"].is<int>()   ? doc["pinSCK"].as<int>()   : cfg.pinSCK;
  int newMISO= doc["pinMISO"].is<int>()  ? doc["pinMISO"].as<int>()  : cfg.pinMISO;
  int newMOSI= doc["pinMOSI"].is<int>()  ? doc["pinMOSI"].as<int>()  : cfg.pinMOSI;
  int newCS  = doc["pinCS"].is<int>()    ? doc["pinCS"].as<int>()    : cfg.pinCS;
  int newINT1= doc["pinINT1"].is<int>()  ? doc["pinINT1"].as<int>()  : cfg.pinINT1;
  int newLED = doc["pinLED"].is<int>()   ? doc["pinLED"].as<int>()   : cfg.pinLED;
  int newRst = doc["pinReset"].is<int>() ? doc["pinReset"].as<int>() : cfg.pinReset;
  // 筌뤴뫀諭???????뺤쨮 ???????(ADXL SPI 甕곌쑴???겸뫖猷?獄쎻뫗?)
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
  if (doc["txPower"].is<int>())  cfg.txPower  = doc["txPower"];
  if (doc["minSegs"].is<int>()) {
    cfg.minSegs = constrain(doc["minSegs"].as<int>(), 10, 500);
    dspMinValidSegs = cfg.minSegs;  // DSP ??釉먯뒭???癲ル슣鍮뽳쭕???袁⑸즵???
  }
  if (doc["wifiMode"].is<const char*>()) strncpy(cfg.wifiMode, doc["wifiMode"] | "ap", sizeof(cfg.wifiMode)-1);
  if (doc["staSSID"].is<const char*>()) strncpy(cfg.staSSID, doc["staSSID"] | "", sizeof(cfg.staSSID)-1);
  if (doc["staPass"].is<const char*>()) strncpy(cfg.staPass, doc["staPass"] | "", sizeof(cfg.staPass)-1);
  if (doc["hostname"].is<const char*>()) {
    strncpy(cfg.hostname, doc["hostname"] | "femto", sizeof(cfg.hostname)-1);
    // ?嶺뚮ㅎ?ц짆?嶺뚮ㅎ?붹뤃????レ챺??? ???ㅼ굡??????쒓낮?????깅뼰, 癲ル슪?숂댆??????ㅼ쨴?
    for (int i=0; cfg.hostname[i]; i++) {
      char c = cfg.hostname[i];
      if (!((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='-')) cfg.hostname[i] = '-';
    }
    if (cfg.hostname[0]=='\0' || (!(cfg.hostname[0]>='a'&&cfg.hostname[0]<='z') && !(cfg.hostname[0]>='A'&&cfg.hostname[0]<='Z')))
      strncpy(cfg.hostname, "femto", sizeof(cfg.hostname)-1);
  }
  if (doc["powerHz"].is<int>())      cfg.powerHz  = doc["powerHz"].as<int>();
  if (doc["liveSegs"].is<int>()) {
    cfg.liveSegs = doc["liveSegs"].as<int>();
    if (cfg.liveSegs < 1) cfg.liveSegs = 1;
    if (cfg.liveSegs > 10) cfg.liveSegs = 10;
  }
  dspSetSampleRate((float)cfg.sampleRate);
  // R4.2/R20.33: NVS ?怨뚮┛ ??쎈솭(??) ???????곷섧?紐꾨퓠 筌뤿굞????癒?쑎 ?袁⑤뼎
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

// ???? ??? PSD NVS ??? (?????? ????
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

// bgPsd??NVS??blob??? ????
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

// ???? ?袁⑸즲??㏓き?PSD API ????
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
  if      (st=="on")    ledState=LED_ON;
  else if (st=="blink") ledState=LED_BLINK;
  else                  ledState=LED_OFF;
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
  if (!checkBodyLimit(8192)) return;
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

// ???? AP ??????????????????????????????????????????????????????????????????????????????????????
unsigned long lastApCheck = 0;
int apFailCount = 0;  // 3??影?됀??怨뚮옖甕걔????怨멸텭????static wifi_power_t txPower = WIFI_POWER_8_5dBm; // WiFi TX ?????(??ш끽維?????怨뚮옖甕걔??????雅??

// ???? 癲ル쉵?猷?????ㅺ컼??????????????????????????????????????????????????????????????????????????????????
// [BUG-6 ???쒓낯?? ?嶺뚮∥梨??沃섅굥????類????????곷츉???棺??짆?먰맪?? dsp.h??dspFeed()??癲ル슓釉????// main.cpp?????얜?源듸┼????????嚥?????enum MeasState { MEAS_IDLE, MEAS_PRINT, MEAS_DONE };
static MeasState measState = MEAS_IDLE;

// v1.0: ??繹먮끏???= ???살쓴鶯??濡ろ떟???⑥レ툔?????怨뺣빰????static WiFiClient liveSSEClient;
static bool  liveMode = false;
static int   liveSegReset = 0;

// v1.0: ?濡ろ뜏???(????DSP?????癲ル슣????????
static float peakFreqX = 0.0f, peakFreqY = 0.0f;
static float peakPowerX = 0.0f, peakPowerY = 0.0f;
static int   segCountX = 0, segCountY = 0;

// v1.0: 筌β돦??PSD ??산퉬??#define MEAS_MAX_BINS DSP_NBINS
static float measPsdX[MEAS_MAX_BINS], measPsdY[MEAS_MAX_BINS];
static float measVarX[MEAS_MAX_BINS], measVarY[MEAS_MAX_BINS];
// Phase 2: Jerk PSD ??산퉬??(??낆젾 ??쎈읃?紐껋쓥)
static float measJerkX[MEAS_MAX_BINS], measJerkY[MEAS_MAX_BINS];
static int   measSampleRate = (int)DSP_FS_DEFAULT;
static int   measBinMin = 0;
static int   measBinCount = 0;
static bool  measPsdValid = false;

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
      // R10.1: valid=false?????袁⑤빍??獄쏄퀣肉???????- ??묐탣??됱뵠???븍뜆?ょ㎉??怨쀬뵠?怨뺤쨮 ?브쑴苑?獄쎻뫗?
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

// ???? GET /api/psd ??PSD ???Β????+ ???醫롮뵫 ?袁⑸즵???????????????????????????
// axis ????앗꾩쒀?濡?뎄?? ?axis=x ??X ???怨좊룴?? ?axis=y ????ш끽維??PSD
// [Round 3] MEAS_DONE ??ш끽維?醫귥땡??嶺뚮ㅎ?????援???(癲ル쉵?猷???쒕춣??嶺뚮ㅎ?????FIFO ???????좊읈???
void handleGetPsd() {
  const float freqRes = dspFreqRes();
  const int binMin = dspBinMin();
  const int binMax = dspBinMax();
  // v1.0: Print Measure 癲ル슢?꾤땟??????袁⑸즲??罹?PSD ?袁⑸즵???(??繹먮끏??????怨쀬굯 ?袁⑸젻泳?)
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
    // X bins (???)
    JsonArray bx = doc["binsX"].to<JsonArray>();
    for (int i = 0; i < measBinCount; i++) {
      JsonObject b = bx.add<JsonObject>();
      b["f"] = (i + measBinMin) * savedFreqRes;
      b["v"] = measPsdX[i];
      b["var"] = measVarX[i];
    }
    // Y bins (???)
    JsonArray by = doc["binsY"].to<JsonArray>();
    for (int i = 0; i < measBinCount; i++) {
      JsonObject b = by.add<JsonObject>();
      b["f"] = (i + measBinMin) * savedFreqRes;
      b["v"] = measPsdY[i];
      b["var"] = measVarY[i];
    }
    // Phase 2: Jerk PSD (??낆젾 ??쎈읃?紐껋쓥 F(f))
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

  // axis ????앗꾩쒀?濡?뎄??癲ル슪?ｇ몭??
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
  // PSD bins (18.75~200Hz) + v0.9 ??됰슣維믢벧?
  JsonArray bins = doc["bins"].to<JsonArray>();
  for (int k = binMin; k <= binMax; k++) {
    JsonObject b = bins.add<JsonObject>();
    b["f"] = k * freqRes;
    b["v"] = dspPsdAccum[k];
    b["var"] = dspPsdVar[k];  // v0.9: ?嶺뚮∥梨??沃섅굥???????됰슣維믢벧?
  }
  // peaks[] ??dsp.h dspFindPeaks() ?濡ろ뜏???癲ル슣?????(diagnostic.js Stage 2 ????
  JsonArray peaksArr = doc["peaks"].to<JsonArray>();
  for (int i = 0; i < st.peakCount; i++) {
    JsonObject pk = peaksArr.add<JsonObject>();
    pk["f"]    = st.peaks[i].freq;
    pk["v"]    = st.peaks[i].power;
    pk["prom"] = st.peaks[i].prominence;
  }
  // ?袁⑸즲??㏓き?PSD (?嶺? ????쐠?????怨좊룴????JS??????嶺뚮ㅎ?닻얠쥉異?癲ル슓堉곤쭗?ㅒ??
  if (dspBgSegs > 0) {
    JsonArray bg = doc["bgPsd"].to<JsonArray>();
    for (int k = binMin; k <= binMax; k++) {
      bg.add(dspBgPsd[k]);
    }
    doc["bgSegs"] = dspBgSegs;
  }
  sendJson(doc);
}

// ???? POST /api/measure ??癲ル쉵?猷????筌?苑?????????????????????????????????????
// body: {"cmd":"print_start"|"print_stop"|"stop"|"reset"}
void handleMeasure() {
  if (!checkBodyLimit(8192)) return;
  JsonDocument req;
  if (deserializeJson(req, server.arg("plain"))) { server.send(400,"text/plain","JSON error"); return; }
  const char* cmd = req["cmd"] | "reset";

  JsonDocument res;

  if (strcmp(cmd,"print_start")==0) {
    // v1.0: ???살쓴鶯??濡ろ떟?????筌믨퀣援???????DSP
    if (!cfg.useCalWeights) {
      res["ok"] = false; res["error"] = "calibration_required";
      sendJson(res); return;
    }
    liveMode = false;  // ??繹먮끏????棺堉??먰맪??????살쓴鶯??濡ろ떟???癲ル슢?꾤땟????????ш낄援??    dspResetDual();
    measState = MEAS_PRINT;
    ledState  = LED_BLINK;
    res["ok"] = true; res["state"] = "print";
    Serial.println("[MEAS] ???살쓴鶯??濡ろ떟?????筌믨퀣援?(????DSP)");
  }
  else if (strcmp(cmd,"print_stop")==0) {
    // v1.0: ??? ???????
    dspUpdateDual();
    // PSD ??? (???????? ???)
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
    saveMeasPsdToNVS();  // ????????????? ???
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
    Serial.printf("[MEAS] ???살쓴鶯??濡ろ떟?????ш끽維??(X:%.1fHz/%d Y:%.1fHz/%d gate:%.0f%% corr:%.0f%%)\n",
      peakFreqX, segCountX, peakFreqY, segCountY,
      dspDualGateRatio()*100, dspDualCorrelation()*100);
  }
  else if (strcmp(cmd,"stop")==0) {
    // ?類????濚욌꼬?댄꺍? (???살쓴鶯??濡ろ떟??????獒???ш끽諭????ㅺ컼??
    if (measState == MEAS_PRINT) {
      // print_stop??????곕럡 癲ル슪?ｇ몭??
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


// ???? GET /api/measure/status ????ш끽維??癲ル쉵?猷?????ㅺ컼????????????????????
void handleMeasStatus() {
  JsonDocument doc;
  // v1.0: 3???ㅺ컼??(IDLE=0, PRINT=1, DONE=2)
  const char* stStr[] = {"idle","print","done"};
  doc["state"]       = stStr[measState];
  doc["measState"]   = stStr[measState];
  // Print Measure 癲ル슢?꾤땟???????????嶺뚮∥梨??沃섅굥??????袁⑸즵???
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

// ???? ????類ｋ렓????源놁젳 ??????????????????????????????????????????????????????????????????????????
// deep sleep timeout
#define DEEP_SLEEP_TIMEOUT_MS  (5 * 60 * 1000)  // 5?????뺤깙?????????類ｋ렓?static unsigned long lastActivityMs = 0;

// ???? setup ????????????????????????????????????????????????????????????????????????????????????????
// v0.9: ??繹먮끏???SSE ????덉쉐?域밸Ŧ留⑶뜮??????怨뺣빰??FFT PSD
void handleLiveStream() {
  WiFiClient client = server.client();
  client.println("HTTP/1.1 200 OK");
  client.println("Content-Type: text/event-stream");
  client.println("Cache-Control: no-cache");
  client.println("Connection: keep-alive");
  client.println("Access-Control-Allow-Origin: *");
  client.println();
  // R72: 疫꿸퀣???????곷섧???類ｂ봺 (orphan ?怨뚭퍙 獄쎻뫗?)
  if (liveSSEClient && liveSSEClient.connected()) {
    liveSSEClient.stop();
  }
  liveSSEClient = client;
  liveSSEClient.setTimeout(3);  // R27.1: 3s send timeout - stuck client 獄쎻뫗?
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
  if (!checkBodyLimit(8192)) return;
  JsonDocument req;
  if (deserializeJson(req, server.arg("plain"))) { server.send(400,"text/plain","JSON"); return; }
  const char* ax = req["axis"] | "a";
  // PSD ?域밸Ŧ遊????????⑤베源???肉????怨뺣빰 ??⑤베源??
  if (liveMode) { dspReset(); }
  server.send(200, "application/json", "{\"ok\":true}");
}

// v0.9: WiFi ????몃펽
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
  // R68: Brown-out detection ??뽮쉐??(USB-C ?袁⑸릍 sag 獄쎻뫗?)
  // ESP32-C3????롫굡??λ선 BOD揶쎛 疫꿸퀡???곗쨮 ??2.7V threshold - 筌뤿굞????類ㅼ뵥/?醫?
  #ifdef CONFIG_ESP_SYSTEM_BROWNOUT_DET
  // ??? sdkconfig?癒?퐣 ??뽮쉐?遺얜쭡 - 癰귢쑬猷??꾨뗀諭??븍뜇釉??  #endif
  // USB CDC ???ㅼ뒦??????(癲ル슔?됭짆? 3???????ㅼ뒦???????⑤벡??癲ル슣???몄춿?
  unsigned long waitStart = millis();
  while (!Serial && (millis() - waitStart < 3000)) { delay(10); }
  delay(200);

  // ????類ｋ렓????쒒??癲???????嶺뚮Ĳ?됮?  esp_sleep_wakeup_cause_t wakeup = esp_sleep_get_wakeup_cause();
  if (wakeup == ESP_SLEEP_WAKEUP_GPIO) {
    Serial.println("[WAKE] GPIO ???쒒??癲?(???됰씭肄???源낆춭??");
  } else if (wakeup != ESP_SLEEP_WAKEUP_UNDEFINED) {
    Serial.printf("[WAKE] ????? %d\n", wakeup);
  }

  lastActivityMs = millis();

  Serial.println("=== FEMTO SHAPER v0.9 ===");

  // R31/R78: LittleFS ?λ뜃由??- false=fail-on-missing (疫꿸퀣?????뵬 癰귣똻????뺣즲)
  // ??쎈솭 ??뽯퓠筌?筌뤿굞???format ??묐뻬 (begin(true)???얜똻?쒎쳞??????袁る퓮)
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

  loadConfig();  // NVS ???源놁젳 ?棺??짆?삠궘???GPIO ?縕?猿녿뎨????ш끽維????ш끽維??
  // GPIO ?縕?猿녿뎨??(loadConfig ??熬곣뫖????NVS ?? ???源놁젳 ?袁⑸즵???
  pinMode(cfg.pinLED, OUTPUT);
  digitalWrite(cfg.pinLED, HIGH);  // OFF
  pinMode(cfg.pinReset, INPUT_PULLUP); // reset button

  adxlOK = adxlInit();
  Serial.printf("[ADXL] %s\n", adxlOK ? "OK" : "FAIL");

  // ?袁⑸즲??㏓き?PSD: NVS ??????棺??짆?삠궘?(loop???????딅텑???癲ル슓釉????????좊즲???
  // v0.8 癲ル슢???鈺곗슜?η춯琉얩뜑????⑤젰?? ???⑤챷??513??bgPsd ?嶺뚮㉡?섌걡?  {
    prefs.begin("femto_bg", true);  // read-only ?嶺뚮Ĳ?됮?    bool hasLegacy = prefs.isKey("b0");
    prefs.end();
    if (hasLegacy) {
      prefs.begin("femto_bg", false);  // write 癲ル슢?꾤땟??????嶺뚮㉡?섌걡???ш끽維????????      prefs.clear();
      prefs.end();
      Serial.println("[NVS] Cleared legacy 513-bin bgPsd");
    }
  }
  loadBgPsdFromNVS();
  loadMeasPsdFromNVS();  // v1.0: 癲ル쉵?猷??PSD ?怨뚮옖甕??(???????癲ル슓堉곁땟?????)

  // ???? WiFi ?縕?猿녿뎨??(AP / STA 癲ル슢?꾤땟???癲ル슣???? ????
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

  // STA 癲ル슢?꾤땟?????筌먲퐣??
  if (strcmp(cfg.wifiMode,"sta")==0 && strlen(cfg.staSSID) > 0) {
    Serial.printf("[WiFi] STA mode ??connecting to '%s'...\n", cfg.staSSID);
    WiFi.mode(WIFI_STA);
    WiFi.setHostname(cfg.hostname);  // v1.0: mDNS ?嶺뚮ㅎ?ц짆?嶺뚮ㅎ?붹뤃?    WiFi.setTxPower(txPower);
    WiFi.begin(cfg.staSSID, cfg.staPass);

    // 癲ル슔?됭짆? 15??????    int wait = 0;
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
      Serial.println("[WiFi] STA failed ??fallback to AP mode");
      WiFi.disconnect(true);
      delay(100);
    }
  }

  // AP 癲ル슢?꾤땟???(??れ삀??????獒?STA ????됰꽡 ???????
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
      Serial.printf("[WiFi] AP start failed ??retry %d/3\n", attempt);
      WiFi.softAPdisconnect(true);
      delay(200);
    }

    Serial.printf("[WiFi] AP: %s @ %s (TX: %ddBm) Heap: %u\n",
      AP_SSID, WiFi.softAPIP().toString().c_str(), txPowerLevel, ESP.getFreeHeap());

    if (!apStarted) {
      Serial.println("[WiFi] AP failed ??reboot in 5s");
      delay(5000);
      ESP.restart();
    }
  }

  // DNS ??筌먦끉裕?(AP 癲ル슢?꾤땟??????節뉗땡???癲ル슓釉??????????
  if (!staConnected) {
    dnsServer.start(53, "*", AP_IP);
    Serial.println("[DNS] 癲ル슓釉????????????筌믨퀣援?);
  }

  // mDNS: hostname.local ??????癲ル슣????(STA 癲ル슢?꾤땟??????節뉗땡????モ섋린瓘苡?
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
  // adxl_test.js: ??釉먮폏?遺룹쐺???ш끽維?? v0.8???????癰귙끋源?

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
  // R18.23: Factory reset endpoint - 筌뤴뫀諭?NVS namespace ?????  // POST /api/reset?all=1 ???袁⑷퍥 ?λ뜃由?? 域?????reboot筌?  // R26.1: ?묒눖???紐꾩쁽 疫뀀챷??野꺜筌?(筌ㅼ뮆? 4獄쏅뗄??? "all=1" + ??됱읈 ???)
  server.on("/api/reset", HTTP_POST, []() {
    String allArg = server.arg("all");
    if (allArg.length() > 4) { server.send(400, "application/json", "{\"ok\":false,\"error\":\"bad_arg\"}"); return; }
    bool all = (allArg == "1");
    if (all) {
      const char* ns[] = {"femto", "femto_bg", "femto_mpsd", "femto_result"};
      for (int i = 0; i < 4; i++) {
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

  // ???? 癲ル슓釉????????????釉먮폇????????????????????????????????????????????????????????
  // Android/iOS/Windows/Firefox ??????????좊즴?? ??釉먮폇??????  // 癲ル슢?꾤땟?嶺?302 ?域밸Ŧ留㎩젆????????癲ル슓釉?????????????筌???獄쏅챷逾?
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
    server.send(200, "text/plain", "success");  // Firefox ??ш끽維?????쑩?젆?  });
  // 雅?퍔瑗띰㎖?덈┛?얜맩肉?URL ??index.html (SPA ??繹먮끏裕??+ 癲ル슓釉???????????????
  server.onNotFound([]() {
    serveFile("/index.html", "text/html");
  });

  server.begin();
  Serial.println("[HTTP] ??筌믨퀣援???http://192.168.4.1");
}

// ???? loop ??????????????????????????????????????????????????????????????????????????????????????????
static const int BOOT_NOISE_TARGET = 1024 + 9 * DSP_STEP; // 10 segments ??0.8s

void loop() {
  dnsServer.processNextRequest();  // 癲ル슓釉??????????DNS
  server.handleClient();

  if (adxlOK) {
    adxlUpdate();

    // ???? ??딅텑????袁⑸즲??㏓き?PSD 癲ル슓釉????(??????袁ⓓ? WiFi?? ?怨뚮옖筌?? ????
    if (!bootNoiseDone && measState == MEAS_IDLE) {
      if (bootNoiseSamples == 0) {
      // 癲?癲ル슣???????縕?猿녿뎨??      if (bootNoiseSamples == 0) {
        dspBgSegs = 0;           // NVS ?棺??짆?삠궘?諭苡????뺤깙???????癲ル슓釉???????源낅츛
        dspReset();
        
      }
      while (adxlCount > 0 && bootNoiseSamples < BOOT_NOISE_TARGET) {
        AdxlSample s = adxlBuf[adxlHead];
        adxlHead  = (adxlHead + 1) % ADXL_BUF_SIZE;
        adxlCount--;
        // v0.9: 癲????⑤???????⑤젰????좊읈?濚욌꼬?댄꺍?????ㅼ굣??(癲ル쉵?猷??寃뗏?????곕럡 ?????
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
          // v0.9: ?????????癲ル슪???띿물?????ш끽維곻쭚?seg 1-5) vs ??ш끽維곻쭚?seg 6-10) ????癒れ땡?堉온 ?????
          // dspBgPsd = seg 1-5 ?????(dsp.h?????seg 5 ??筌믨퀣??癲ル슓釉????
          // _psdSum/10 = seg 1-10 ??ш끽維???????          // ??ш끽維곻쭚??????= (??ш끽維??10 - ??ш끽維곻쭚?5) / 5
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
            // ?????????ш끽維????????癲ル슔?됭짆?륂렭?bgPsd??????(???嶺?)
            dspUpdateAccum();
            for (int k = dspBinMin(); k <= dspBinMax(); k++)
              dspBgPsd[k] = dspPsdAccum[k];
            saveBgPsdToNVS();
            Serial.printf("[BOOT] bgPsd OK (ratio=%.2f, %d samples)\n", ratio, bootNoiseSamples);
          } else {
            // ??????얠뒋?????WiFi ????됰꺊??熬곥룂???????怨쀬굯 ??좊읈????묐빝???NVS ?????
            loadBgPsdFromNVS();
            Serial.printf("[BOOT] bgPsd inconsistent (ratio=%.2f) ??NVS fallback\n", ratio);
          }
        } else {
          // 癲ル슓釉????????됰꽡 ??NVS ??????怨뚮옖甕??
          loadBgPsdFromNVS();
          Serial.println("[BOOT] Capture failed ??NVS fallback restored");
        }
        // v0.9: ?袁⑸즲??㏓き?????癒れ땡?堉온 ??節뚮쳮雅??????源끹렑 ??좊즴?? threshold ??れ삀??
        dspBgEnergy = 0;
        for (int k = dspBinMin(); k <= dspBinMax(); k++) dspBgEnergy += dspBgPsd[k];
        if (dspBgEnergy < 50.0f) dspBgEnergy = 50.0f;
        Serial.printf("[BOOT] bgEnergy=%.0f ??sweep threshold base\n", dspBgEnergy);
        dspReset();  // sweepDetect ???怨뺣빰 ON???⑥???怨뚮옖甕??
      }
    }

    // v1.0: Print Measure ??????DSP
    else if (measState == MEAS_PRINT) {
      const float scale = 0.0039f * 9.80665f;  // raw ??m/s嶺?
      // R20.35: ADXL disconnect detection - 筌β돦????뽰삂 ??5?λ뜃而???묐탣 沃섎챷???揶쏅Ŋ??
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
      // SSE: ?????嶺뚮∥梨??沃섅굥?????ш끽維????癲ル슣???몄춿????ㅺ컼????ш끽維뽬땻?      if (dspDualNewSeg) {
        dspDualNewSeg = false;
        if (liveSSEClient.connected()) {
          dspUpdateDual();
          char buf[2048];  // 59??????⑤베??B = ~1000B + ????
          int len = snprintf(buf, sizeof(buf),
            "data: {\"m\":\"print\",\"sx\":%d,\"sy\":%d,\"st\":%d,\"gr\":%.2f,\"bx\":[",
            dspDualSegCountX(), dspDualSegCountY(), dspDualSegTotal(), dspDualGateRatio());
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
        // v1.0: ??繹먮끏???= ????DSP ?棺堉??먰맪?癲ル슢?꾤땟???
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
            projX = ax; projY = ay;  // 雅?퍔瑗띰㎖????????源낇꼧???????
          }
          dspFeedDual(projX, projY);
        }
        // cfg.liveSegs ?嶺뚮∥梨?猿놁땡??쒖맄??SSE ??ш끽維뽬땻? 30?嶺뚮∥梨?猿놁땡??쒖맄???棺堉??먰맪??域밸Ŧ遊??
        int segNow = dspDualSegTotal();
        if (segNow - liveSegReset >= cfg.liveSegs) {
          liveSegReset = segNow;
          dspUpdateDual();
          // SSE: ????PSD ??ш끽維뽬땻?          if (liveSSEClient.connected()) {
            char buf[2048];
            int len = snprintf(buf, sizeof(buf),
              "data: {\"m\":\"live\",\"sx\":%d,\"sy\":%d,\"bx\":[",
              dspDualSegTotal(), dspDualSegTotal());
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
          // 30?嶺뚮∥梨?猿놁땡??쒖맄???棺堉??먰맪??域밸Ŧ遊??(PSD ???モ??????)
          if (segNow >= 30) {
            dspResetDual();
            liveSegReset = 0;
          }
          if (!liveSSEClient.connected()) { liveMode = false; }
        }
      } else {
        // ????????? ?類????????곷츉???鸚??袁⑸젻泳?
        if (adxlCount > 32) {
          uint8_t drop = adxlCount - 4;
          adxlHead = (adxlHead + drop) % ADXL_BUF_SIZE;
          adxlCount -= drop;
        }
      }
    }
  }

  // ???? 3??影?됀?AP ???筌욎㏃녃域뱄퐢???+ ??癲ル슢?꾤땟?????ㅻ깹??????????????????????????????????
  if (millis() - lastApCheck > 30000) {
    lastApCheck = millis();

    // ???????癲ル슪???띿물???40KB ??熬곣뫀?껓┼?WiFi ??됰씭??????ш낄援??    uint32_t freeHeap = ESP.getFreeHeap();
    if (freeHeap < 40000) {
      Serial.printf("[HEAP] ??ш낄援?? %u bytes ??WiFi ??됰씭??????좊읈???n", freeHeap);
      // ????딅텑?????癲ル쉵?猷??濚욌꼬?댄꺍????ш끽維??씤異??域?????關履??
      if (measState == MEAS_IDLE || measState == MEAS_DONE) {
        if (freeHeap < 20000) {
          Serial.println("[HEAP] ?怨멸땀?쀫씛??????域???);
          ESP.restart();
        }
      }
    }

    // WiFi ???ㅺ컼???嶺뚮Ĳ?됮?+ ?怨뚮옖甕걔??
    if (WiFi.status() == WL_CONNECTED) {
      // STA ???ㅼ뒦???嶺뚮Ĳ?놅쭕?      apFailCount = 0;
    } else if (strcmp(cfg.wifiMode,"sta")==0 && WiFi.status() != WL_CONNECTED) {
      // STA ???ㅼ뒦????? ???????펷燁???筌먲퐣??
      apFailCount++;
      Serial.printf("[WiFi] STA reconnect %d/3\n", apFailCount);
      if (apFailCount <= 2) {
        WiFi.reconnect();
      } else {
        Serial.println("[WiFi] STA failed ??fallback to AP");
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
      Serial.printf("[WiFi] AP ?怨뚮옖甕걔??%d/3 (heap: %u)\n", apFailCount, freeHeap);
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
        WiFi.setTxPower(txPower); // NVS ???源놁젳?????
        WiFi.softAPConfig(AP_IP, AP_IP, IPAddress(255,255,255,0));
        WiFi.softAP(AP_SSID, nullptr, 1, 0, 4);
        dnsServer.start(53, "*", AP_IP);
      } else {
        Serial.println("[WiFi] Stage 3 ???域???);
        ESP.restart();
      }
    } else {
      apFailCount = 0;
    }
  }

  if (ledState != LED_BLINK)
    ledState = WiFi.softAPgetStationNum() > 0 ? LED_ON : LED_OFF;
  updateLed();

  // ???? GPIO10 ?域밸Ŧ遊???類????????
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

  // ???? ????類ｋ렓?(5?????뺤깙??? ????
  // ???????⑤９苑????????濚욌꼬?댄꺍??ル쵐異?????????域밸Ŧ遊??
  if (WiFi.softAPgetStationNum() > 0 || measState != MEAS_IDLE) {
    lastActivityMs = millis();
  }
  // ???뺤깙???5????????類ｋ렓?癲ル슣????
  if (millis() - lastActivityMs > DEEP_SLEEP_TIMEOUT_MS) {
    Serial.println("[SLEEP] 5min idle ??deep sleep (press reset to wake)");
    WiFi.mode(WIFI_OFF);
    delay(100);
    esp_deep_sleep_enable_gpio_wakeup(1ULL << cfg.pinReset, ESP_GPIO_WAKEUP_GPIO_LOW);
    esp_deep_sleep_start();
  }
}
