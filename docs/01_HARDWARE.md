# 01. 하드웨어

## BOM ($3)
| 부품 | 모델 | 가격 | 역할 |
|------|------|------|------|
| MCU | ESP32-C3 SuperMini | $1.5 | WiFi + SPI + 연산 |
| 가속도계 | ADXL345 | $1.5 | 3축 가속도 측정 |
| 기타 | USB-C 케이블, 양면테이프 | — | 전원, 부착 |

## SPI 핀 배치 (v2 일렬 연결)
| 신호 | GPIO | 방향 | 비고 |
|------|------|------|------|
| SCK | 9 | ESP→ADXL | SPI Clock |
| MISO (SDO) | 1 | ADXL→ESP | SPI Data Out |
| MOSI (SDA) | 0 | ESP→ADXL | SPI Data In |
| CS | 4 | ESP→ADXL | Chip Select (Active Low) |
| INT1 | 3 | ADXL→ESP | 인터럽트 (현재 폴링 사용) |
| INT2 | 2 | ADXL→ESP | 미사용 |
| LED | 8 | 출력 | Built-in LED (Active Low) |
| VCC | 3.3V | — | ADXL 전원 |
| GND | GND | — | 공통 그라운드 |

**딥슬립 웨이크:** EN핀 ↔ GND 택트 스위치

## ADXL345 설정
- SPI: 5MHz, Mode 3, MSB First
- 범위: ±16g (Full Resolution 12bit)
- 샘플레이트: 3200Hz (BW_RATE = 0x0F)
- FIFO: Stream 모드, 32샘플 배치 폴링
- 최소 감지: 0.0039g ≈ 0.038 m/s²

## ESP32-C3 SuperMini 사양
- CPU: RISC-V 160MHz single-core
- RAM: 400KB SRAM (사용 ~18KB = 4.5%)
- Flash: 4MB (앱 1.75MB + LittleFS 2.19MB + NVS 32KB)
- WiFi: 802.11 b/g/n 2.4GHz
- USB-C: 전원 + 시리얼 디버그

## 센서 부착
프린터 핫엔드(프린트헤드)에 양면테이프로 부착. 부착 각도는 캘리브레이션에서 자동 보정되므로 정확한 정렬 불필요. 단, 단단히 고정해야 센서 자체 진동이 측정을 오염시키지 않음.
