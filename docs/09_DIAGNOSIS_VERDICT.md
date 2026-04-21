# 09. 진단 & 판정

## 진단 시스템 (diagnostic.js)

### 설계 원칙
- **"확진이 아닌 방향 제시"** — 단정하지 않음
- 피크별 zone 분류 + 키네마틱 맥락 설명 + 액션 권고

### 종합 상태
- 🟢 양호: 경고 없음, 공진 정상 범위
- 🟡 주의: 경고 있음 (벨트, 구조, 고주파)
- 🔵 공진 없음: 피크 미감지

### 키네마틱별 진단 (kinematics.js)
```
CoreXY:
  <30Hz    frame    프레임 강성 부족
  30-120Hz belt     벨트+캐리지 공진 (정상 범위)
  >120Hz   hotend   핫엔드 마운트
  X/Y 비대칭 → A/B 벨트 텐션 차이
  대칭성 비교 가능 (A+B = X+Y 연동)

Cartesian:
  X축: 직접 측정 (캐리지)
  Y축: 간접 (베드), 저주파 정상
  벨트 비교: 항상 Normal (독립 축)
  대칭성: 항상 Normal

CoreXZ: X+Z 연동, Y 독립
Delta: 벨트/캐리지/대칭 N/A (3타워 대칭)
```

### 피크별 카드 구조
```
[아이콘] [축] [주파수] — [zone]
  [키네마틱 맥락 설명]
  💡 [액션 권고]
  🎵 하모닉 (있으면): "84Hz = 42Hz의 2차"
  🌀 팬 (있으면): "90Hz — 팬 진동으로 분류"
```

### 진단 features (extractFeatures)
```
xyAsym: X/Y 주파수 비대칭도 (0~1)
peakSpread: |peakX - peakY| Hz
hfCount: 고주파 피크 수 (>75Hz + >1.8×main)
hfRel: 고주파/메인 상대 크기
peakCountX/Y: 축별 피크 수
```

---

## 판정 엔진 (validator.js)

### Layer 1: 측정 품질 (calcMeasurementQuality)
| 항목 | 배점 | 기준 |
|------|------|------|
| 캘리브레이션 | 20 | 필수. 미완료=critical |
| gateRatio | 25 | ≥20%=25, ≥10%=15, ≥3%=5, <3%=critical |
| 상관계수 | 20 | <0.5=20, <0.8=10, ≥0.8=critical |
| 수렴도 | 20 | <기준=20, <2×=10, 그 외=warn |
| 데이터량 | 15 | ≥200=15, ≥50=8, <50=critical |

### Layer 2: 결과 신뢰도 (calcResultConfidence)
| 항목 | 배점 | 기준 |
|------|------|------|
| 피크 존재 | 30 | 피크 ≥1 |
| SNR | 25 | ≥15dB=25, ≥8dB=15 |
| confidence | 25 | ≥50%=25, ≥15%=15 |
| maxAccel | 20 | ≥2000=20, ≥500=10 |

### 판정 3단계
```
APPLY:  크리티컬 0 + 경고 ≤1 + 스코어 ≥60%
REVIEW: 경고 ≥2 또는 스코어 <60%
RETRY:  크리티컬 ≥1
```

### 추가 경고 (practical 기반)
| ID | 조건 | 메시지 |
|----|------|--------|
| accel_limit | maxAccel < userAccel | "가속도를 maxAccel로 제한하세요" |
| smoothing_exceed | userSmoothing > targetSm | "스무딩 초과" |
| speed_unreachable | feed > maxReachSpeed | "속도 미도달" |
| low_excitation | accelRatio < 5% | "가감속 부족" |

### Apply G-code (generateApplyGcode)
```
marlin_is:  M593 X F42.5 D0.1 / M593 Y F55.3 D0.1 [+ M500]
marlin_ftm: M493 S3 A42.5 D0.1 [+ M500]
klipper:    [input_shaper] shaper_freq_x=42.5 ...
rrf:        M593 P"mzv" F42.5
```
