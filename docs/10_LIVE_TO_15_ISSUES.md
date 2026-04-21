# 10. 라이브 스펙트럼 (청진기)

## 설계 철학
의사의 청진기: 모든 소리를 들려준다. 필터링은 의사 머리에서.
FEMTO 라이브: 모든 주파수를 보여준다. 판단은 사용자가.
- 배경 차감 없음, 팬 필터 없음, 하모닉 분류 없음
- 0.01 floor만 적용 (양자화 노이즈 차단)
- 추천/경고/진단 표시 없음

## 시각 신호 3종
```
1. 히트맵 색상: 자주 나타나는 빈 = 진한색
   hitMap[i] = hitMap[i] × 0.985 + (active ? 0.015 : 0)
   파랑(차가움) → 초록 → 노랑 → 주황(뜨거움)
   
2. 피크홀드: 순간 피크의 점선 잔상
   peakHold[i] = max(peakHold[i] × 0.97, current[i])
   2초 반감기로 자연 하강

3. 상태 라인: 5초마다 hitMap 상위 3빈
   "📍 44Hz · 87Hz"
```

## 사용 시나리오
- 프레임 두드리기 → 순간 피크 → 홀드 잔상으로 주파수 확인
- 볼트 조이기 전후 → 히트맵 색상 변화 관찰
- 벨트 퉁기기 → 양쪽 주파수 비교
- 핫엔드 잡기 → 특정 피크 사라짐 관찰
- 팬 켜기 → RPM÷60 Hz에서 지속 피크

## SSE 전송
- ESP32: cfg.liveSegs 세그마다 (기본 2 = 160ms = 6fps)
- 30세그마다 롤링 리셋 (PSD 신선도)
- 데이터: bx/by 각 59 float + pk 피크 주파수

## UI 컨트롤
- [📌 Hold]: 피크홀드 ON/OFF 토글
- [↺]: 히트맵 + 홀드 + 상태 초기화
- 힌트 오버레이: "시작을 누르고 프린터를 만져보세요"

---

# 11. NVS 저장소

## 네임스페이스
| 이름 | 내용 | 크기 | 시점 |
|------|------|------|------|
| femto | 전체 Config 구조체 | ~500B | 설정 저장 시 |
| femto_res | 측정 결과 (freq, shaper, confidence) | ~100B | 결과 저장 시 |
| femto_bg | 배경 PSD (59빈 float) | 236B | 부팅 시 자동 |
| femto_mpsd | 측정 PSD 백업 (X/Y PSD+Var 4배열) | 944B | print_stop 시 |
| femto_belt | 벨트 진단 결과 | ~50B | 진단 시 |
| femto_diag | 진단 상태 | ~50B | 진단 시 |

## 파티션 (partitions.csv)
```
nvs,    data, nvs,    0x9000,   0x8000    # 32KB NVS
app0,   app,  ota_0,  0x10000,  0x1C0000  # 1.75MB 앱
spiffs, data, spiffs, 0x1D0000, 0x230000  # 2.19MB LittleFS
```

## 안전 규칙
- NVS 18KB 이상 사용 금지 — WiFi 불안정 유발 (실경험)
- 현재 ~2KB 사용 → 여유 충분
- 과도한 NVS 쓰기 회피 (Flash wear)

---

# 12. WiFi & 네트워크

## AP 모드 (기본)
- SSID: `FEMTO-SHAPER` (패스워드 없음)
- IP: 192.168.4.1
- DNS서버: 모든 도메인 → 자기 IP (캡티브 포털)
- 캡티브 포털: 모든 OS 감지 URL → 302 리다이렉트
  - `/connecttest.txt`, `/generate_204`, `/hotspot-detect.html` 등
- mDNS: 비활성 (DNS서버와 충돌)

## STA 모드
- 사용자 WiFi 접속 → DHCP IP
- `WiFi.setHostname(cfg.hostname)` → WiFi.begin() 전에 호출
- `MDNS.begin(cfg.hostname)` → STA 연결 성공 후에만
- hostname.local로 접속 가능
- 실패 → AP 모드 자동 폴백

## hostname 설정
- NVS 저장 (femto_res 네임스페이스)
- 유효성: 영문소문자+숫자+하이픈, 빈값→"femto"
- UI: 실시간 .local 프리뷰

---

# 13. 빌드 & 배포 & 테스트

## 빌드
```bash
pio run -t erase && pio run -t upload && pio run -t uploadfs
```
erase 필수: 레거시 NVS 손상 방지.

## 테스트
```bash
# 단일
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

테스트는 Node.js VM. DOM 목업 + Chart.js 목업 포함. ESP32 없이 JS 로직 검증.

## 13개 테스트 스위트 (390라운드)
| 스위트 | 라운드 | 범위 |
|--------|--------|------|
| esp32_pm40 | 40 | ESP32 목업 |
| bughunt20 | 20 | 경계값 |
| bugfinal30 | 30 | 통합 |
| v10_30r | 30 | 파이프라인 |
| v10_uiux | 30 | UI/UX |
| v10_attack | 30 | 엣지 케이스 |
| v10_full | 30 | 전체 |
| v10_calc | 30 | 계산 정확도 |
| v10_zero | 30 | 무결점 |
| v10_field | 30 | 실기 수정 |
| v10_final | 30 | 최종 |
| v10_halluc | 30 | 환각 검증 |
| v10_integ | 30 | 통합 (practical+live+PSD) |

---

# 14. 설계 결정 기록 (ADR)

| # | 결정 | 이유 | 기각된 대안 |
|---|------|------|------------|
| 1 | G-code 스윕 삭제 | Zero Coupling 원칙 | chirp 유지 → Klipper 전용 |
| 2 | 1024-pt FFT | 3.125Hz 해상도, ESP32 RAM 한계 | 2048-pt → RAM 부족 |
| 3 | 연속 가중치 게이트 | 이진보다 안정, 등속도 미량 기여 | 이진 게이트 → 경계 불안정 |
| 4 | PSD 백업 배열 | 라이브 오염 방지 | NVS만 → 재부팅 전 복원 불가 |
| 5 | 피크 검출 1곳 통합 | 다중 경로 → 불일치 버그 경험 | 탭별 독립 → 결과 불일치 |
| 6 | JS에서 쉐이퍼 분석 | ESP32 RAM으로 5종 스윕 불가 | ESP32 분석 → 메모리 부족 |
| 7 | Catmull-Rom 보간 | 3.125→0.5Hz, 정밀도 6배 | 선형 → 피크 위치 오차 |
| 8 | 하모닉 최소오차 매칭 | first-match → 오분류 경험 | break → 120Hz를 42Hz 3차로 잘못 분류 |
| 9 | 라이브 필터 없음 | 청진기=모든 소리 | 배경 차감 → 원인 추적 불가 |
| 10 | mDNS STA 전용 | AP에서 DNS서버가 전 도메인 가로챔 | AP mDNS → 충돌 |
| 11 | 2세그 SSE (변수) | 1세그=12fps → WiFi 버벅 | 하드코딩 → 프린터별 조정 불가 |
| 12 | NVS 2KB 제한 | 18KB+ → WiFi 불안정 실경험 | 무제한 → 시스템 불안정 |
| 13 | K-value 공식 수정 | K=exp(-ζπ/√(1-ζ²)), 이전 공식은 √K 생성 | 이전=Kfemto=√Kklipper |

---

# 15. 알려진 제한 & PENDING

## 알려진 제한
| 항목 | 상태 | 영향 |
|------|------|------|
| PSD 해상도 3.125Hz | 설계 | Lorentzian 피팅으로 ±0.1Hz 보정 |
| 주파수 범위 18.75~200Hz | 설계 | 3D프린터 공진 대역 커버 |
| 동시 접속 1명 | ESP32 | SSE + WebServer 동시 1클라 |
| CORS 없음 | 설계 | 같은 ESP32 서빙 |
| DSP_BIN_MIN=3 (18.75Hz) | 물리 | 8~12Hz 프레임 진동은 Stage 1에서 감지 불가 |

## PENDING (다음 작업)
- [ ] S1 실기 재테스트 (mDNS, 라이브 청진기, 추천 설정)
- [ ] corr 95~97% 원인 (센서 위치 or 캘리브레이션)
- [ ] 라이브 2세그 버벅임 확인
- [ ] TinyBee 통합 (API 연동, SSE)
- [ ] v2.0: 배터리, ML 진단, golden dataset
- [ ] 진단 v1.0+: Adaptive threshold, Weighted 진단, Peak Stability

## 설계 원칙
```
"확진 아닌 방향 제시"           — 진단
"붙이고 출력하면 끝"            — UX
"잘 맞추는 능력보다,            — 판정
 틀렸을 때 적용하지 않는 능력"
"라이브 = 청진기"               — 추천 없음
```
