// ============ FEMTO SHAPER Settings v0.8 ============
// G코드 생성기 제거됨 → 각 탭에서 직접 다운로드
// 프린터 설정 바(pcb) 업데이트 함수 포함
// 모든 주석 한국어

// ── 설정 저장 (ESP32 NVS) ──────────────────────────────
function saveSettings(silent) {
  // BUG FIX: 설정이 로드되지 않은 상태에서 저장 → NVS 초기화 방지
  if (!_settingsLoaded) {
    const saveStatus = document.getElementById('saveStatus');
    if (saveStatus) {
      saveStatus.textContent = '⚠ ' + (t('save_blocked') || 'Settings not loaded yet — reconnect and try again');
      saveStatus.className = 'save-msg save-err'; saveStatus.style.display = 'block';
    }
    return;
  }
  const minSegs = parseInt(document.getElementById('s_minSegs')?.value || '100');
  const cfg = {
    buildX:     parseInt(document.getElementById('s_buildX').value),
    buildY:     parseInt(document.getElementById('s_buildY').value),
    accel:      parseInt(document.getElementById('s_accel').value),
    feedrate:   parseInt(document.getElementById('s_feedrate').value),
    kin:        document.getElementById('s_kin').value,
    sampleRate: parseInt(document.getElementById('s_sampleRate').value),
    axesMap: 'custom',  // 캘리브레이션 전용
    firmware:   document.getElementById('s_firmware')?.value  || 'marlin_is',
    eepromSave: document.getElementById('s_eepromSave')?.value === 'yes',
    scv:        parseFloat(document.getElementById('s_scv')?.value || '5.0'),
    damping:    parseFloat(document.getElementById('s_damping')?.value || '0.1'),
    targetSm:   parseFloat(document.getElementById('s_targetSm')?.value || '0.12'),
    demoMode:   document.getElementById('s_demoMode')?.checked || false,
    minSegs:    minSegs,
    pinSCK:     parseInt(document.getElementById('s_pinSCK')?.value || '9'),
    pinMISO:    parseInt(document.getElementById('s_pinMISO')?.value || '1'),
    pinMOSI:    parseInt(document.getElementById('s_pinMOSI')?.value || '0'),
    pinCS:      parseInt(document.getElementById('s_pinCS')?.value || '4'),
    pinINT1:    parseInt(document.getElementById('s_pinINT1')?.value || '3'),
    pinLED:     parseInt(document.getElementById('s_pinLED')?.value || '8'),
    pinReset:   parseInt(document.getElementById('s_pinReset')?.value || '10'),
    wifiMode:   document.getElementById('s_wifiMode')?.value || 'ap',
    staSSID:    document.getElementById('s_staSSID')?.value || '',
    staPass:    document.getElementById('s_staPass')?.value || '',
    hostname:   (document.getElementById('s_hostname')?.value || 'femto').toLowerCase().replace(/[^a-z0-9\-]/g,'') || 'femto',
    powerHz:    parseInt(document.getElementById('s_powerHz')?.value || '60'),
    liveSegs:   parseInt(document.getElementById('s_liveSegs')?.value || '2'),
  };

  // ESP32 NVS에 설정 저장
  const saveStatus = silent ? null : document.getElementById('saveStatus');
  if (saveStatus) { saveStatus.textContent = t('saving'); saveStatus.className = 'save-msg save-pending'; saveStatus.style.display = 'block'; }

  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  })
    .then(r => { if (!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
    .then(() => {
      if (saveStatus) { saveStatus.textContent = '✓ '+t('save_ok'); saveStatus.className = 'save-msg save-ok'; }
      const ob = document.getElementById('onboardBanner'); if (ob) ob.style.display = 'none';
      updateAllPcb();
      // minValidSegs 동기화
      fetch('/api/debug', { method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ minValidSegs: minSegs }) }).catch(e => console.warn('API:', e.message));
    })
    .catch((e) => {
      if (saveStatus) { saveStatus.textContent = '✗ '+t('save_fail')+e.message; saveStatus.className = 'save-msg save-err'; }
    });
  // 3초 후 메시지 숨김
  setTimeout(() => { if (saveStatus) saveStatus.style.display = 'none'; }, 4000);
}

// ── 설정 로드 (ESP32 NVS) ──────────────────────────────
let _settingsLoaded = false;  // 로드 완료 플래그 — 미완료 시 저장 차단

function loadSettings(retryCount) {
  if (retryCount === undefined) retryCount = 0;
  fetch('/api/config')
    .then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(cfg => {
      // !== undefined 가드: 0, false, '' 값도 정상 로드
      const el = (id) => document.getElementById(id);
      if (cfg.buildX    !== undefined && el('s_buildX'))    el('s_buildX').value = cfg.buildX;
      if (cfg.buildY    !== undefined && el('s_buildY'))    el('s_buildY').value = cfg.buildY;
      if (cfg.accel     !== undefined && el('s_accel'))     el('s_accel').value = cfg.accel;
      if (cfg.feedrate  !== undefined && el('s_feedrate'))  el('s_feedrate').value = cfg.feedrate;
      if (cfg.kin       !== undefined && el('s_kin'))       el('s_kin').value = cfg.kin;
      if (cfg.sampleRate!== undefined && el('s_sampleRate'))el('s_sampleRate').value = cfg.sampleRate;
      if (cfg.firmware  !== undefined && el('s_firmware'))  el('s_firmware').value = cfg.firmware;
      if (el('s_eepromSave')) el('s_eepromSave').value = cfg.eepromSave ? 'yes' : 'no';
      if (cfg.scv       !== undefined && el('s_scv'))       el('s_scv').value = cfg.scv;
      if (cfg.damping   !== undefined && el('s_damping'))   el('s_damping').value = cfg.damping;
      if (cfg.targetSm  !== undefined && el('s_targetSm'))  el('s_targetSm').value = cfg.targetSm;
      if (el('s_demoMode')) el('s_demoMode').checked = !!cfg.demoMode;
      // GPIO
      if (cfg.pinSCK    !== undefined && el('s_pinSCK'))    el('s_pinSCK').value = cfg.pinSCK;
      if (cfg.pinMISO   !== undefined && el('s_pinMISO'))   el('s_pinMISO').value = cfg.pinMISO;
      if (cfg.pinMOSI   !== undefined && el('s_pinMOSI'))   el('s_pinMOSI').value = cfg.pinMOSI;
      if (cfg.pinCS     !== undefined && el('s_pinCS'))     el('s_pinCS').value = cfg.pinCS;
      if (cfg.pinINT1   !== undefined && el('s_pinINT1'))   el('s_pinINT1').value = cfg.pinINT1;
      if (cfg.pinLED    !== undefined && el('s_pinLED'))    el('s_pinLED').value = cfg.pinLED;
      if (cfg.pinReset  !== undefined && el('s_pinReset'))  el('s_pinReset').value = cfg.pinReset;
      if (cfg.minSegs   !== undefined && el('s_minSegs'))   el('s_minSegs').value = cfg.minSegs;
      // WiFi
      if (cfg.wifiMode && el('s_wifiMode')) {
        el('s_wifiMode').value = cfg.wifiMode;
        // filterPowerHz 동기화
        if (cfg.powerHz !== undefined && el('s_powerHz')) el('s_powerHz').value = cfg.powerHz;
        if (cfg.liveSegs !== undefined && el('s_liveSegs')) el('s_liveSegs').value = cfg.liveSegs;
        if (typeof filterPowerHz !== 'undefined') filterPowerHz = cfg.powerHz || 60;
        const sf = document.getElementById('staFields');
        if (sf) sf.style.display = cfg.wifiMode === 'sta' ? '' : 'none';
      }
      if (cfg.staSSID !== undefined && el('s_staSSID')) el('s_staSSID').value = cfg.staSSID;
      if (cfg.hostname && el('s_hostname')) {
        el('s_hostname').value = cfg.hostname;
        const preview = document.getElementById('hostnamePreview');
        if (preview) preview.textContent = cfg.hostname;
        const link = document.getElementById('sysHostLink');
        if (link) { link.href = 'http://'+cfg.hostname+'.local'; link.textContent = cfg.hostname+'.local'; }
      }
      // password: don't load for security — show placeholder only
      // WiFi status
      const ws = document.getElementById('wifiStatus');
      if (ws) {
        const mode = cfg.wifiActiveMode || 'ap';
        const ip = cfg.wifiIP || '192.168.4.1';
        ws.innerHTML = '📶 ' + mode.toUpperCase() + ' — <b>' + ip + '</b>';
      }

      _settingsLoaded = true;
      updateAllPcb();
      updateKinUI();

      // v0.9: 온보딩 배너 (캘리브레이션 미완료)
      const needsCal = !cfg.useCalWeights;
      const banner = document.getElementById('onboardBanner');
      if (banner) banner.style.display = needsCal ? '' : 'none';

      // v0.9: 캘리브레이션 가중치를 전역에 로드
      if (cfg.useCalWeights && cfg.calWx && cfg.calWy) {
        _calWeights = { wx: cfg.calWx, wy: cfg.calWy, wz: null };
      }
      // v1.0: 팬 피크 로드 (캘리브레이션에서 감지)
      if (cfg.fanPeaks && typeof loadFanPeaks === 'function') {
        loadFanPeaks(cfg.fanPeaks);
      }
    })
    .catch((e) => {
      if (retryCount < 3) {
        // 캡티브 포털 redirect 등으로 실패 → 2초 후 재시도
        setTimeout(() => loadSettings(retryCount + 1), 2000);
      } else {
        // 3회 실패 → 경고
        appLog('logShaper', '<span class="log-err">⚠</span> ' + t('log_settings_fail') + '');
        _settingsLoaded = false;
      }
      updateAllPcb();
      updateKinUI();
    });
}

// ── 초기화 ────────────────────────────────────────────
function resetSettings() {
  document.getElementById('s_buildX').value = 120;
  document.getElementById('s_buildY').value = 120;
  document.getElementById('s_accel').value = 3000;
  document.getElementById('s_feedrate').value = 200;
  document.getElementById('s_kin').value = 'corexy';
  document.getElementById('s_sampleRate').value = 3200;
  // axesMap: 캘리브레이션 전용
  // Phase 5 기본값
  if (document.getElementById('s_scv'))      document.getElementById('s_scv').value = '5.0';
  if (document.getElementById('s_damping'))  document.getElementById('s_damping').value = '0.1';
  if (document.getElementById('s_targetSm')) document.getElementById('s_targetSm').value = '0.12';
  if (document.getElementById('s_firmware')) document.getElementById('s_firmware').value = 'marlin_is';
  if (document.getElementById('s_eepromSave')) document.getElementById('s_eepromSave').value = 'no';
  if (document.getElementById('s_demoMode')) document.getElementById('s_demoMode').checked = false;
  // GPIO 기본값
  if (document.getElementById('s_pinSCK'))   document.getElementById('s_pinSCK').value = '9';
  if (document.getElementById('s_pinMISO'))  document.getElementById('s_pinMISO').value = '1';
  if (document.getElementById('s_pinMOSI'))  document.getElementById('s_pinMOSI').value = '0';
  if (document.getElementById('s_pinCS'))    document.getElementById('s_pinCS').value = '4';
  if (document.getElementById('s_pinINT1'))  document.getElementById('s_pinINT1').value = '3';
  if (document.getElementById('s_pinLED'))   document.getElementById('s_pinLED').value = '8';
  if (document.getElementById('s_pinReset'))  document.getElementById('s_pinReset').value = '10';
  if (document.getElementById('s_minSegs'))  document.getElementById('s_minSegs').value = '256';
  updateAllPcb();
}


// ── 프린터 설정 바 (pcb) 업데이트 ────────────────────
/**
 * 각 탭에 표시되는 프린터 설정 요약 바 갱신
 * 설정 변경 시마다 호출
 */
function getPrinterConfigText() {
  const bx = document.getElementById('s_buildX')?.value || 120;
  const by = document.getElementById('s_buildY')?.value || 120;
  const kin = document.getElementById('s_kin')?.value || 'corexy';
  const accel = document.getElementById('s_accel')?.value || 3000;
  const feed = document.getElementById('s_feedrate')?.value || 200;
  const fw = document.getElementById('s_firmware')?.value || 'marlin_is';
  const sr = document.getElementById('s_sampleRate')?.value || 3200;

  const scv = document.getElementById('s_scv')?.value || '5.0';
  const dm  = document.getElementById('s_damping')?.value || '0.1';
  return `⚙ ${bx}×${by} ${kin.toUpperCase()} | ${accel}mm/s² | SCV:${scv} | D:${dm} | ${fw} | ${sr}Hz`;
}

function updateAllPcb() {
  const text = getPrinterConfigText();

  // Shaper 탭 설정 바
  const pcbText = document.getElementById('pcbText');
  if (pcbText) pcbText.textContent = text;

  // Diagnostic 서브탭 설정 바들
  ['Belt', 'Carriage', 'Frame', 'Symmetry'].forEach(name => {
    const el = document.getElementById(`pcb${name}Text`) ||
               document.getElementById(`pcb${name}`)?.querySelector('span');
    if (el) el.textContent = text;
  });
}


// ── 설정 읽기 헬퍼 ────────────────────────────────────
// 다른 모듈에서 현재 설정값을 읽을 때 사용
function getCfgScv()      { return parseFloat(document.getElementById('s_scv')?.value      || '5.0'); }
function getCfgDamping()  { return parseFloat(document.getElementById('s_damping')?.value  || '0.1'); }
function getCfgTargetSm() { return parseFloat(document.getElementById('s_targetSm')?.value || '0.12'); }
function getCfgAccel()    { return parseInt(document.getElementById('s_accel')?.value       || '5000'); }
function getCfgFeedrate() { return parseInt(document.getElementById('s_feedrate')?.value    || '300'); }
function getCfgBuildX()   { return parseInt(document.getElementById('s_buildX')?.value      || '250'); }
function getCfgBuildY()   { return parseInt(document.getElementById('s_buildY')?.value      || '250'); }
function getCfgMinSegs()  { return parseInt(document.getElementById('s_minSegs')?.value || '100'); }
// v1.0: gcode.js에서 이동 — 리포트/분석에서 사용
function getSettingsCfg() {
  return {
    buildX: parseInt(document.getElementById('s_buildX')?.value||'250'),
    buildY: parseInt(document.getElementById('s_buildY')?.value||'250'),
    accel: parseInt(document.getElementById('s_accel')?.value||'5000'),
    feedrate: parseInt(document.getElementById('s_feedrate')?.value||'300'),
    kin: document.getElementById('s_kin')?.value||'corexy',
    firmware: document.getElementById('s_firmware')?.value||'marlin_is',
    scv: parseFloat(document.getElementById('s_scv')?.value||'5'),
    damping: parseFloat(document.getElementById('s_damping')?.value||'0.1'),
    targetSm: parseFloat(document.getElementById('s_targetSm')?.value||'0.12'),
    sampleRate: parseInt(document.getElementById('s_sampleRate')?.value||'3200'),
  };
}

// ── 디버그 설정 ──────────────────────────────────────────
// 디버그 파라미터는 NVS가 아닌 런타임 변경 (재부팅 시 기본값 복원)

// ── 디버그 설정 — localStorage 영구 저장 ──
const _debugDefaults = {
  LowConfWarn:true, ShowNoise:false, ForceResult:false, ShowPsd:false,
  SnrGate:8, AbsMult:5, BgRatio:3.0, HarmRange:6.25, HarmCount:4, FloorPct:0.3,
  SnrOn:true, AbsOn:true, BgOn:true, HarmOn:true, HfCut:true,
  MinSegs:80, MinConf:15, MinAccel:500,
  // v1.0: Print Measure 파라미터
  PmConvX:1.0, PmConvY:1.0, PmMinSegs:200,
  PmEmaAlpha:0.03, PmDcAlpha:0.001, PmPeakHist:8, PmCorrWarn:0.8,
  // v1.0: 캘리브레이션 파라미터
  CalMinSegs:100, CalEnergyGate:3.0, CalFanEnabled:false, CalFanSegs:50, CalPollMs:20,
};
// Print Measure 공개 변수 (kinematics.js, measure.js에서 참조)
var pmConvX = 1.0, pmConvY = 1.0, pmMinSegs = 200;
var pmEmaAlpha = 0.03, pmDcAlpha = 0.001, pmPeakHist = 8, pmCorrWarn = 0.8;
// 캘리브레이션 변수
var calMinSegs = 100, calEnergyGate = 3.0, calFanEnabled = false, calFanSegs = 50, calPollMs = 20;

function _loadDebugFromStorage() {
  try {
    const s = localStorage.getItem('femtoDebug');
    if (!s) return;
    const d = JSON.parse(s);
    if (d.LowConfWarn !== undefined) debugLowConfWarn = d.LowConfWarn;
    if (d.ShowNoise !== undefined) debugShowNoise = d.ShowNoise;
    if (d.ShowPsd !== undefined) debugShowPsd = d.ShowPsd;
    if (d.PsdThreshold !== undefined) filterPsdThreshold = d.PsdThreshold;
    if (d.ForceResult !== undefined) debugForceResult = d.ForceResult;
    if (d.SnrGate !== undefined) debugSnrGate = d.SnrGate;
    if (d.AbsMult !== undefined) debugAbsMult = d.AbsMult;
    if (d.BgRatio !== undefined) debugBgRatio = d.BgRatio;
    if (d.HarmRange !== undefined) debugHarmRange = d.HarmRange;
    if (d.HarmCount !== undefined) debugHarmCount = d.HarmCount;
    if (d.FloorPct !== undefined) debugFloorPct = d.FloorPct;
    if (d.SnrOn !== undefined) debugSnrOn = d.SnrOn;
    if (d.AbsOn !== undefined) debugAbsOn = d.AbsOn;
    if (d.BgOn !== undefined) debugBgOn = d.BgOn;
    if (d.HarmOn !== undefined) debugHarmOn = d.HarmOn;
    if (d.HfCut !== undefined) debugHfCut = d.HfCut;
    if (d.MinSegs !== undefined) debugMinSegs = d.MinSegs;
    if (d.MinConf !== undefined) debugMinConf = d.MinConf;
    if (d.MinAccel !== undefined) debugMinAccel = d.MinAccel;
    // v1.0: PM 파라미터
    if (d.PmConvX !== undefined) pmConvX = d.PmConvX;
    if (d.PmConvY !== undefined) pmConvY = d.PmConvY;
    if (d.PmMinSegs !== undefined) pmMinSegs = d.PmMinSegs;
    if (d.PmEmaAlpha !== undefined) pmEmaAlpha = d.PmEmaAlpha;
    if (d.PmDcAlpha !== undefined) pmDcAlpha = d.PmDcAlpha;
    if (d.PmPeakHist !== undefined) pmPeakHist = d.PmPeakHist;
    if (d.PmCorrWarn !== undefined) pmCorrWarn = d.PmCorrWarn;
    // 캘리브레이션
    if (d.CalMinSegs !== undefined) calMinSegs = d.CalMinSegs;
    if (d.CalEnergyGate !== undefined) calEnergyGate = d.CalEnergyGate;
    if (d.CalFanEnabled !== undefined) calFanEnabled = d.CalFanEnabled;
    if (d.CalFanSegs !== undefined) calFanSegs = d.CalFanSegs;
    if (d.CalPollMs !== undefined) calPollMs = d.CalPollMs;
  } catch(e) {}
}
function _saveDebugToStorage() {
  try {
    localStorage.setItem('femtoDebug', JSON.stringify({
      LowConfWarn:debugLowConfWarn, ShowNoise:debugShowNoise, ShowPsd:debugShowPsd, PsdThreshold:filterPsdThreshold,
      ForceResult:debugForceResult, SnrGate:debugSnrGate, AbsMult:debugAbsMult,
      BgRatio:debugBgRatio, HarmRange:debugHarmRange, HarmCount:debugHarmCount,
      FloorPct:debugFloorPct, SnrOn:debugSnrOn, AbsOn:debugAbsOn, BgOn:debugBgOn,
      HarmOn:debugHarmOn, HfCut:debugHfCut, MinSegs:debugMinSegs, MinConf:debugMinConf,
      MinAccel:debugMinAccel,
      PmConvX:pmConvX, PmConvY:pmConvY, PmMinSegs:pmMinSegs,
      PmEmaAlpha:pmEmaAlpha, PmDcAlpha:pmDcAlpha, PmPeakHist:pmPeakHist, PmCorrWarn:pmCorrWarn,
      CalMinSegs:calMinSegs, CalEnergyGate:calEnergyGate, CalFanEnabled:calFanEnabled, CalFanSegs:calFanSegs, CalPollMs:calPollMs
    }));
  } catch(e) {}
}

// v1.0: 키네마틱 변경 시 PM 기본값 업데이트
function updatePmDefaultsForKin() {
  const kin = getCfgKin();
  const p = typeof getKinProfile === 'function' ? getKinProfile(kin) : null;
  if (!p) return;
  const el = (id) => document.getElementById(id);
  // 키네마틱 기본값을 placeholder로 표시 (사용자가 변경 안 했으면 적용)
  if (el('s_pmConvX')) el('s_pmConvX').placeholder = p.axes.x.convergenceHz;
  if (el('s_pmConvY')) el('s_pmConvY').placeholder = p.axes.y.convergenceHz;
  if (el('s_pmMinSegs')) el('s_pmMinSegs').placeholder = Math.max(p.axes.x.minActiveSegs, p.axes.y.minActiveSegs);
}

// PM UI ↔ 변수 동기
function syncPmFromUI() {
  const el = (id) => document.getElementById(id);
  pmConvX = parseFloat(el('s_pmConvX')?.value || pmConvX);
  pmConvY = parseFloat(el('s_pmConvY')?.value || pmConvY);
  pmMinSegs = parseInt(el('s_pmMinSegs')?.value || pmMinSegs);
  pmEmaAlpha = parseFloat(el('s_pmEmaAlpha')?.value || pmEmaAlpha);
  pmDcAlpha = parseFloat(el('s_pmDcAlpha')?.value || pmDcAlpha);
  pmPeakHist = parseInt(el('s_pmPeakHist')?.value || pmPeakHist);
  pmCorrWarn = parseFloat(el('s_pmCorrWarn')?.value || pmCorrWarn);
  if (el('d_showPsd')) debugShowPsd = el('d_showPsd').value === 'on';
  // 캘리브레이션
  calMinSegs = parseInt(el('s_calMinSegs')?.value || calMinSegs);
  calEnergyGate = parseFloat(el('s_calEnergyGate')?.value || calEnergyGate);
  calFanEnabled = (el('s_calFanEnabled')?.value || 'on') === 'on';
  calFanSegs = parseInt(el('s_calFanSegs')?.value || calFanSegs);
  calPollMs = parseInt(el('s_calPollMs')?.value || calPollMs);
  _saveDebugToStorage();
}
function syncPmToUI() {
  const el = (id) => document.getElementById(id);
  if (el('s_pmConvX')) el('s_pmConvX').value = pmConvX;
  if (el('s_pmConvY')) el('s_pmConvY').value = pmConvY;
  if (el('s_pmMinSegs')) el('s_pmMinSegs').value = pmMinSegs;
  if (el('s_pmEmaAlpha')) el('s_pmEmaAlpha').value = pmEmaAlpha;
  if (el('s_pmDcAlpha')) el('s_pmDcAlpha').value = pmDcAlpha;
  if (el('s_pmPeakHist')) el('s_pmPeakHist').value = pmPeakHist;
  if (el('s_pmCorrWarn')) el('s_pmCorrWarn').value = pmCorrWarn;
  if (el('d_showPsd')) el('d_showPsd').value = debugShowPsd ? 'on' : 'off';
  // 캘리브레이션
  if (el('s_calMinSegs')) el('s_calMinSegs').value = calMinSegs;
  if (el('s_calEnergyGate')) el('s_calEnergyGate').value = calEnergyGate;
  if (el('s_calFanEnabled')) el('s_calFanEnabled').value = calFanEnabled ? 'on' : 'off';
  if (el('s_calFanSegs')) el('s_calFanSegs').value = calFanSegs;
  if (el('s_calPollMs')) el('s_calPollMs').value = calPollMs;
}

let debugLowConfWarn = true;

let debugShowNoise   = false;
let debugShowPsd     = false;  // PSD Y축 수치 표시
let debugForceResult = false;
let debugSnrGate     = 8;
let debugAbsMult     = 5;
let debugBgRatio     = 3.0;
let debugHarmRange   = 6.25;
let debugHarmCount   = 4;
let debugFloorPct    = 0.3;
let debugSnrOn       = false;
let debugAbsOn       = false;
let debugBgOn        = false;
let debugHarmOn      = false;
let debugHfCut       = false;
let debugMinSegs     = 80;
let debugMinConf     = 15;
let debugMinAccel    = 500;

// 페이지 로드 시 localStorage에서 복원
_loadDebugFromStorage();

function switchSettingsTab(tab) {
  const tabs = ['basic', 'advanced', 'log', 'system'];
  const ids  = ['settingsBasic', 'settingsAdvanced', 'settingsLog', 'settingsSystem'];
  tabs.forEach((t, i) => {
    const el = document.getElementById(ids[i]);
    if (el) el.style.display = (t === tab) ? '' : 'none';
  });
  // 진단 탭과 동일 스타일: .stab.active
  document.querySelectorAll('#pg-settings > .stb .stab').forEach((b, i) => {
    b.classList.toggle('active', tabs[i] === tab);
  });
  if (tab === 'advanced') syncDebugUI();
  if (tab === 'system') updateSysInfo();
}

function syncDebugUI() {
  const el = (id) => document.getElementById(id);
  if (el('d_snrGate'))   el('d_snrGate').value   = debugSnrGate;
  if (el('d_absMult'))   el('d_absMult').value   = debugAbsMult;
  if (el('d_bgRatio'))   el('d_bgRatio').value   = debugBgRatio;
  if (el('d_harmRange')) el('d_harmRange').value  = debugHarmRange;
  if (el('d_harmCount')) el('d_harmCount').value  = debugHarmCount;
  if (el('d_floorPct'))  el('d_floorPct').value   = debugFloorPct;
  if (el('d_snrOn'))     el('d_snrOn').value      = debugSnrOn ? 'on' : 'off';
  if (el('d_absOn'))     el('d_absOn').value      = debugAbsOn ? 'on' : 'off';
  if (el('d_bgOn'))      el('d_bgOn').value       = debugBgOn ? 'on' : 'off';
  if (el('d_harmOn'))    el('d_harmOn').value     = debugHarmOn ? 'on' : 'off';
  if (el('d_hfCut'))     el('d_hfCut').value      = debugHfCut ? 'on' : 'off';
  if (el('d_showNoise')) el('d_showNoise').value  = debugShowNoise ? 'on' : 'off';
  if (el('d_showPsd')) el('d_showPsd').value  = debugShowPsd ? 'on' : 'off';
  if (el('s_psdThreshold')) el('s_psdThreshold').value = filterPsdThreshold;
  if (el('d_forceResult'))el('d_forceResult').value = debugForceResult ? 'on' : 'off';
  if (el('d_lowConfWarn'))el('d_lowConfWarn').value= debugLowConfWarn ? 'on' : 'off';
  if (el('d_minSegs'))   el('d_minSegs').value    = debugMinSegs;
  if (el('d_minConf'))   el('d_minConf').value    = debugMinConf;
  if (el('d_minAccel'))  el('d_minAccel').value   = debugMinAccel;
  // v1.0: PM 설정 동기
  syncPmToUI();
  updatePmDefaultsForKin();
}

async function saveDebugSettings() {
  debugSnrGate     = Math.max(1, Math.min(100, parseFloat(document.getElementById('d_snrGate')?.value||'8')));
  debugAbsMult     = Math.max(1, Math.min(50, parseFloat(document.getElementById('d_absMult')?.value||'5')));
  debugBgRatio     = Math.max(1, Math.min(20, parseFloat(document.getElementById('d_bgRatio')?.value||'3')));
  debugHarmRange   = Math.max(1, Math.min(20, parseFloat(document.getElementById('d_harmRange')?.value||'6.25')));
  debugHarmCount   = Math.max(1, Math.min(10, parseInt(document.getElementById('d_harmCount')?.value||'4')));
  debugFloorPct    = Math.max(0.1, Math.min(0.7, parseFloat(document.getElementById('d_floorPct')?.value||'0.3')));
  debugSnrOn       = (document.getElementById('d_snrOn')?.value||'on') === 'on';
  debugAbsOn       = (document.getElementById('d_absOn')?.value||'on') === 'on';
  debugBgOn        = (document.getElementById('d_bgOn')?.value||'on') === 'on';
  debugHarmOn      = (document.getElementById('d_harmOn')?.value||'on') === 'on';
  debugHfCut       = (document.getElementById('d_hfCut')?.value||'on') === 'on';
  debugShowPsd     = (document.getElementById('d_showPsd')?.value||'off') === 'on';
  debugShowNoise   = (document.getElementById('d_showNoise')?.value||'off') === 'on';
  debugLowConfWarn = (document.getElementById('d_lowConfWarn')?.value||'on') === 'on';
  debugForceResult = (document.getElementById('d_forceResult')?.value||'off') === 'on';
  filterPowerHz = parseInt(document.getElementById('s_powerHz')?.value || '60');
  filterPsdThreshold = parseFloat(document.getElementById('s_psdThreshold')?.value || '0.01');
  debugMinSegs     = Math.max(10, parseInt(document.getElementById('d_minSegs')?.value||'80'));
  debugMinConf     = Math.max(0, parseInt(document.getElementById('d_minConf')?.value||'15'));
  debugMinAccel    = Math.max(0, parseInt(document.getElementById('d_minAccel')?.value||'500'));
  // v1.0: PM 파라미터 저장
  syncPmFromUI();

  appLog('logDebug', '<span class="log-ok">\u2713</span> SNR='+debugSnrGate+' abs\xd7'+debugAbsMult+' bg='+debugBgRatio+' harm='+debugHarmRange+'Hz\xd7'+debugHarmCount);
  appLog('logDebug', '<span class="log-ok">\u2713</span> Gates: snr='+debugSnrOn+' abs='+debugAbsOn+' bg='+debugBgOn+' harm='+debugHarmOn+' hf='+debugHfCut);
  appLog('logDebug', '<span class="log-ok">\u2713</span> Valid: segs\u2265'+debugMinSegs+' conf\u2265'+debugMinConf+'% accel\u2265'+debugMinAccel);
  _saveDebugToStorage();  // localStorage 영구 저장
  // Advanced 탭의 s_ 필드도 NVS에 저장 (scv, damping, targetSm, minSegs, powerHz)
  saveSettings(true);  // silent=true
  const st = document.getElementById('debugSaveStatus');
  if (st) { st.textContent = '\u2713 Applied'; st.className = 'save-msg save-ok'; st.style.display = 'block'; }
  setTimeout(() => { if (st) st.style.display = 'none'; }, 3000);
}

function resetDebugDefaults() {
  const defs = {d_snrGate:8,d_absMult:5,d_bgRatio:3,d_harmRange:6.25,d_harmCount:4,d_floorPct:0.3,
    d_minSegs:80,d_minConf:15,d_minAccel:500};
  for (const [id,v] of Object.entries(defs)) { const el=document.getElementById(id); if(el) el.value=v; }
  ['d_snrOn','d_absOn','d_bgOn','d_harmOn','d_hfCut'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='off';});
  ['d_showNoise'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='off';});
  ['d_showPsd'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='off';});
  ['d_forceResult'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='off';});
  const th = document.getElementById('s_psdThreshold'); if (th) th.value = '0.01';
  filterPsdThreshold = 0.01;
  saveDebugSettings();  // 변수 적용 + localStorage 저장
  appLog('logDebug', `<span class="log-ok">\u21ba</span> ${t('log_debug_reset')}`);
}

// ── 축 캘리브레이션 위저드 ──────────────────────────────
// 벡터 투영 방식: 어떤 설치 각도에서도 정확한 축 매핑
// 결과: printerX = wxX·ax + wxY·ay + wxZ·az (6개 가중치)
let _calWeights = null; // {wx:[wxX,wxY,wxZ], wy:[wyX,wyY,wyZ]}

function vecNorm(v) { const m = Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]); return m > 1e-9 ? [v[0]/m,v[1]/m,v[2]/m] : [0,0,0]; }
function vecDot(a,b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
function vecCross(a,b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function vecSub(a,b) { return [a[0]-b[0],a[1]-b[1],a[2]-b[2]]; }
function vecScale(v,s) { return [v[0]*s,v[1]*s,v[2]*s]; }
function vecLen(v) { return Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]); }


// ══════════════════════════════════════════════════════
// v1.0 캘리브레이션 v2 — 공분산 기반 + 움직임 감지 + 팬 측정
// 센서 부착 각도 무관, 모든 설정은 설정 페이지에서 변경 가능
// ══════════════════════════════════════════════════════

// ── 벡터 유틸 ────────────────────────────────────────
function vecLen(v){ return Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]); }
function vecNorm(v){ var l=vecLen(v); return l>1e-12 ? [v[0]/l,v[1]/l,v[2]/l] : [0,0,0]; }
function vecDot(a,b){ return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
function vecSub(a,b){ return [a[0]-b[0],a[1]-b[1],a[2]-b[2]]; }
function vecScale(v,s){ return [v[0]*s,v[1]*s,v[2]*s]; }
function vecCross(a,b){ return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }

// ── 공분산 행렬 → 주성분 (Power Iteration) ───────────
function covarianceEigen(samples, mean) {
  // 3×3 공분산 행렬 계산
  var n = samples.length;
  if (n < 5) return [1,0,0];
  var c00=0,c01=0,c02=0,c11=0,c12=0,c22=0;
  for (var i=0; i<n; i++) {
    var dx=samples[i][0]-mean[0], dy=samples[i][1]-mean[1], dz=samples[i][2]-mean[2];
    c00+=dx*dx; c01+=dx*dy; c02+=dx*dz;
    c11+=dy*dy; c12+=dy*dz; c22+=dz*dz;
  }
  c00/=n; c01/=n; c02/=n; c11/=n; c12/=n; c22/=n;
  // Power iteration: 최대 고유값의 고유벡터
  var v = [1, 0.5, 0.3]; // 초기 벡터 (대칭 방지)
  for (var iter=0; iter<20; iter++) {
    var nv = [c00*v[0]+c01*v[1]+c02*v[2], c01*v[0]+c11*v[1]+c12*v[2], c02*v[0]+c12*v[1]+c22*v[2]];
    var l = vecLen(nv);
    if (l < 1e-15) break;
    v = [nv[0]/l, nv[1]/l, nv[2]/l];
  }
  return v;
}

// ── Gram-Schmidt 직교화 ──────────────────────────────
function gramSchmidt(gVec, xVec, yVec) {
  var zHat = vecNorm(vecScale(gVec, -1)); // Z = -중력
  // X: xVec에서 Z 성분 제거
  var xPerp = vecSub(xVec, vecScale(zHat, vecDot(xVec, zHat)));
  var xMag = vecLen(xPerp);
  var xHat = vecNorm(xPerp);
  // Y: yVec에서 Z, X 성분 제거
  var yPerp = vecSub(yVec, vecScale(zHat, vecDot(yVec, zHat)));
  yPerp = vecSub(yPerp, vecScale(xHat, vecDot(yPerp, xHat)));
  var yMag = vecLen(yPerp);
  var yHat = vecNorm(yPerp);
  // 직교도 검증
  var ortho = Math.abs(vecDot(xHat, yHat));
  var angleXY = Math.acos(Math.max(-1, Math.min(1, vecDot(xHat, yHat)))) * 180 / Math.PI;
  return { wx: xHat, wy: yHat, wz: zHat, ortho: ortho, angleXY: angleXY, xMag: xMag, yMag: yMag };
}

async function startAxisCalibration() {
  var status = document.getElementById('calStatus');
  var result = document.getElementById('calResult');
  var bar = document.getElementById('calBar');
  var saveBtn = document.getElementById('calSaveBtn');
  var startBtn = document.getElementById('calStartBtn');
  if (startBtn) startBtn.disabled = true;
  if (saveBtn) saveBtn.style.display = 'none';
  if (result) result.style.display = 'none';
  _calWeights = null;

  function setS(msg) { if (status) status.innerHTML = msg; }
  function setB(pct) { if (bar) bar.style.width = Math.min(100,pct) + '%'; }
  function log(msg) { appLog('logAdxl', msg); }

  // 측정 중이면 중지
  try { await fetch('/api/measure', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{"cmd":"stop"}'}); } catch(e) {}
  await new Promise(function(r){setTimeout(r,300)});

  // 설정값 읽기
  var MIN_SEGS = calMinSegs;
  var GATE = calEnergyGate;
  var FAN_ON = calFanEnabled;
  var FAN_SEGS = calFanSegs;
  var POLL_MS = calPollMs;
  var TOTAL_PHASES = FAN_ON ? 5 : 3;

  try {
    // ═══ Phase 1: 중력 측정 ═══
    setS('📐 <b>1/'+TOTAL_PHASES+'</b> — 프린터를 정지 상태로 유지하세요 (모터OFF, 팬OFF)');
    setB(0);
    log('<span class="log-ok">▶</span> Phase 1: 중력 측정 시작');

    var gravSamples = [];
    var GRAV_COUNT = Math.max(50, MIN_SEGS);
    var bgEnergy = 0;
    for (var i=0; i<GRAV_COUNT; i++) {
      try {
        var r = await fetch('/api/adxl/raw');
        var d = await r.json();
        if (d.x !== undefined) {
          gravSamples.push([d.x, d.y, d.z]);
          var e = d.x*d.x + d.y*d.y + d.z*d.z;
          bgEnergy = bgEnergy * 0.9 + e * 0.1;
        }
      } catch(e) {}
      await new Promise(function(r){setTimeout(r,POLL_MS)});
      setB((i/GRAV_COUNT*15).toFixed(0));
    }
    if (gravSamples.length < 20) throw new Error('중력 감지 실패 — 센서 연결 확인');

    var gMean = [0,0,0];
    for (var i=0; i<gravSamples.length; i++) { gMean[0]+=gravSamples[i][0]; gMean[1]+=gravSamples[i][1]; gMean[2]+=gravSamples[i][2]; }
    gMean[0]/=gravSamples.length; gMean[1]/=gravSamples.length; gMean[2]/=gravSamples.length;
    var gMag = vecLen(gMean);
    if (gMag < 100 || gMag > 500) throw new Error('중력 비정상: |g|=' + gMag.toFixed(0));

    // 정지 상태 에너지 기준 (분산)
    var bgVar = 0;
    for (var i=0; i<gravSamples.length; i++) {
      var dx=gravSamples[i][0]-gMean[0], dy=gravSamples[i][1]-gMean[1], dz=gravSamples[i][2]-gMean[2];
      bgVar += dx*dx + dy*dy + dz*dz;
    }
    bgVar /= gravSamples.length;
    var threshold = bgVar * GATE;

    log('<span class="log-ok">✓</span> 중력 OK (' + (gMag/256).toFixed(2) + 'g) 배경 에너지: ' + bgVar.toFixed(1));
    setB(15);

    // ═══ Phase 2: X축 이동 ═══
    setS('↔ <b>2/'+TOTAL_PHASES+'</b> — 컨트롤러에서 <b>X축</b>을 왕복 이동하세요');
    log('<span class="log-ok">▶</span> Phase 2: X축 — 움직임 대기 중...');

    var xSamples = [];
    var xActive = 0;
    var xWaiting = true;
    var waitStart = Date.now();

    while (xActive < MIN_SEGS) {
      try {
        var r = await fetch('/api/adxl/raw');
        var d = await r.json();
        if (d.x !== undefined) {
          var s = [d.x - gMean[0], d.y - gMean[1], d.z - gMean[2]];
          var e = s[0]*s[0] + s[1]*s[1] + s[2]*s[2];

          if (xWaiting) {
            if (e > threshold) {
              xWaiting = false;
              log('<span class="log-ok">✓</span> X축 움직임 감지! 수집 시작');
            } else if (Date.now() - waitStart > 60000) {
              throw new Error('60초 동안 움직임 없음 — X축을 이동하세요');
            }
          }

          if (!xWaiting && e > threshold * 0.5) {
            xSamples.push(s);
            xActive++;
            setB((15 + xActive/MIN_SEGS*25).toFixed(0));
            if (xActive % 20 === 0) setS('↔ <b>2/'+TOTAL_PHASES+'</b> — X축 수집 ' + xActive + '/' + MIN_SEGS);
          }
        }
      } catch(e) {}
      await new Promise(function(r){setTimeout(r,POLL_MS)});
    }

    var xMean = [0,0,0];
    for (var i=0; i<xSamples.length; i++) { xMean[0]+=xSamples[i][0]; xMean[1]+=xSamples[i][1]; xMean[2]+=xSamples[i][2]; }
    xMean[0]/=xSamples.length; xMean[1]/=xSamples.length; xMean[2]/=xSamples.length;
    var xVec = covarianceEigen(xSamples, xMean);
    log('<span class="log-ok">✓</span> X축 완료 (' + xActive + ' segs) 방향: [' + xVec.map(function(v){return v.toFixed(2)}).join(', ') + ']');
    setB(40);

    // ═══ Phase 3: Y축 이동 ═══
    setS('↕ <b>3/'+TOTAL_PHASES+'</b> — 컨트롤러에서 <b>Y축</b>을 왕복 이동하세요');
    log('<span class="log-ok">▶</span> Phase 3: Y축 — 움직임 대기 중...');

    var ySamples = [];
    var yActive = 0;
    var yWaiting = true;
    waitStart = Date.now();

    while (yActive < MIN_SEGS) {
      try {
        var r = await fetch('/api/adxl/raw');
        var d = await r.json();
        if (d.x !== undefined) {
          var s = [d.x - gMean[0], d.y - gMean[1], d.z - gMean[2]];
          var e = s[0]*s[0] + s[1]*s[1] + s[2]*s[2];

          if (yWaiting) {
            if (e > threshold) {
              yWaiting = false;
              log('<span class="log-ok">✓</span> Y축 움직임 감지! 수집 시작');
            } else if (Date.now() - waitStart > 60000) {
              throw new Error('60초 동안 움직임 없음 — Y축을 이동하세요');
            }
          }

          if (!yWaiting && e > threshold * 0.5) {
            ySamples.push(s);
            yActive++;
            setB((40 + yActive/MIN_SEGS*25).toFixed(0));
            if (yActive % 20 === 0) setS('↕ <b>3/'+TOTAL_PHASES+'</b> — Y축 수집 ' + yActive + '/' + MIN_SEGS);
          }
        }
      } catch(e) {}
      await new Promise(function(r){setTimeout(r,POLL_MS)});
    }

    var yMean = [0,0,0];
    for (var i=0; i<ySamples.length; i++) { yMean[0]+=ySamples[i][0]; yMean[1]+=ySamples[i][1]; yMean[2]+=ySamples[i][2]; }
    yMean[0]/=ySamples.length; yMean[1]/=ySamples.length; yMean[2]/=ySamples.length;
    var yVec = covarianceEigen(ySamples, yMean);
    log('<span class="log-ok">✓</span> Y축 완료 (' + yActive + ' segs) 방향: [' + yVec.map(function(v){return v.toFixed(2)}).join(', ') + ']');
    setB(65);

    // ═══ Gram-Schmidt 직교화 ═══
    var gs = gramSchmidt(gMean, xVec, yVec);

    // ═══ Phase 4~5: 팬 측정 (옵션) ═══
    var fanPeaks = [];
    if (FAN_ON) {
      // Phase 4: 팬 ON
      setS('🌀 <b>4/'+TOTAL_PHASES+'</b> — <b>핫엔드를 60°C 이상</b>으로 설정하세요 (핫엔드팬 자동 ON)');
      log('<span class="log-ok">▶</span> Phase 4a: 핫엔드팬 — 진동 변화 대기 중...');
      setB(70);

      var fanOnSamples = [];
      var fanWaiting = true;
      var fanActive = 0;
      waitStart = Date.now();

      while (fanActive < FAN_SEGS) {
        try {
          var r = await fetch('/api/adxl/raw');
          var d = await r.json();
          if (d.x !== undefined) {
            var s = [d.x - gMean[0], d.y - gMean[1], d.z - gMean[2]];
            var e = s[0]*s[0] + s[1]*s[1] + s[2]*s[2];

            if (fanWaiting) {
              if (e > bgVar * 1.5) {
                fanWaiting = false;
                log('<span class="log-ok">✓</span> 팬 진동 감지! 수집 시작');
              } else if (Date.now() - waitStart > 30000) {
                // 30초 후 자동 시작 (감지 못 했어도)
                fanWaiting = false;
                log('<span class="log-ok">ℹ</span> 30초 경과 — 자동 수집 시작');
              }
            }

            if (!fanWaiting) {
              fanOnSamples.push([d.x, d.y, d.z]);
              fanActive++;
              setB((70 + fanActive/FAN_SEGS*10).toFixed(0));
            }
          }
        } catch(e) {}
        await new Promise(function(r){setTimeout(r,POLL_MS)});
      }
      log('<span class="log-ok">✓</span> 팬 ON 측정 완료 (' + fanActive + ' segs)');
      setB(80);

      // Phase 5: 팬 OFF
      setS('🔇 <b>5/'+TOTAL_PHASES+'</b> — <b>파츠쿨링팬을 100%</b>로 켜세요 (M106 S255), 10초 후 <b>전부 끄세요</b>');
      log('<span class="log-ok">▶</span> Phase 5: 파츠팬+OFF — 대기 중...');

      var fanOffSamples = [];
      var offWaiting = true;
      var offActive = 0;
      waitStart = Date.now();

      while (offActive < FAN_SEGS) {
        try {
          var r = await fetch('/api/adxl/raw');
          var d = await r.json();
          if (d.x !== undefined) {
            var s = [d.x - gMean[0], d.y - gMean[1], d.z - gMean[2]];
            var e = s[0]*s[0] + s[1]*s[1] + s[2]*s[2];

            if (offWaiting) {
              if (e < bgVar * 2.0) {
                offWaiting = false;
                log('<span class="log-ok">✓</span> 팬 정지 감지! 수집 시작');
              } else if (Date.now() - waitStart > 30000) {
                offWaiting = false;
                log('<span class="log-ok">ℹ</span> 30초 경과 — 자동 수집 시작');
              }
            }

            if (!offWaiting) {
              fanOffSamples.push([d.x, d.y, d.z]);
              offActive++;
              setB((80 + offActive/FAN_SEGS*10).toFixed(0));
            }
          }
        } catch(e) {}
        await new Promise(function(r){setTimeout(r,POLL_MS)});
      }
      log('<span class="log-ok">✓</span> 팬 OFF 측정 완료');

      // 팬 피크 분류: fanOn 에너지 - fanOff 에너지 차이
      var fanOnVar = [0,0,0], fanOffVar = [0,0,0];
      var fOnMean = [0,0,0], fOffMean = [0,0,0];
      for (var i=0; i<fanOnSamples.length; i++) { fOnMean[0]+=fanOnSamples[i][0]; fOnMean[1]+=fanOnSamples[i][1]; fOnMean[2]+=fanOnSamples[i][2]; }
      fOnMean[0]/=fanOnSamples.length; fOnMean[1]/=fanOnSamples.length; fOnMean[2]/=fanOnSamples.length;
      for (var i=0; i<fanOffSamples.length; i++) { fOffMean[0]+=fanOffSamples[i][0]; fOffMean[1]+=fanOffSamples[i][1]; fOffMean[2]+=fanOffSamples[i][2]; }
      fOffMean[0]/=fanOffSamples.length; fOffMean[1]/=fanOffSamples.length; fOffMean[2]/=fanOffSamples.length;

      var fanEnergyRatio = 0;
      for (var i=0; i<fanOnSamples.length; i++) { var dx=fanOnSamples[i][0]-fOnMean[0],dy=fanOnSamples[i][1]-fOnMean[1],dz=fanOnSamples[i][2]-fOnMean[2]; fanOnVar[0]+=dx*dx; fanOnVar[1]+=dy*dy; fanOnVar[2]+=dz*dz; }
      for (var i=0; i<fanOffSamples.length; i++) { var dx=fanOffSamples[i][0]-fOffMean[0],dy=fanOffSamples[i][1]-fOffMean[1],dz=fanOffSamples[i][2]-fOffMean[2]; fanOffVar[0]+=dx*dx; fanOffVar[1]+=dy*dy; fanOffVar[2]+=dz*dz; }
      var onE = (fanOnVar[0]+fanOnVar[1]+fanOnVar[2])/fanOnSamples.length;
      var offE = (fanOffVar[0]+fanOffVar[1]+fanOffVar[2])/fanOffSamples.length;
      fanEnergyRatio = offE > 0 ? onE / offE : 1;

      if (fanEnergyRatio > 1.5) {
        log('<span class="log-ok">✓</span> 팬 에너지 비율: ' + fanEnergyRatio.toFixed(1) + '× (팬 진동 감지됨)');
      } else {
        log('<span class="log-ok">ℹ</span> 팬 에너지 비율: ' + fanEnergyRatio.toFixed(1) + '× (팬 진동 미미)');
      }
    }
    setB(90);

    // ═══ 결과 ═══
    _calWeights = {
      wx: gs.wx, wy: gs.wy, wz: gs.wz,
      gMag: gMag, ortho: gs.ortho, angleXY: gs.angleXY,
      xMag: gs.xMag, yMag: gs.yMag,
      xSegs: xActive, ySegs: yActive,
      fanPeaks: fanPeaks,
      fanEnergyRatio: typeof fanEnergyRatio !== 'undefined' ? fanEnergyRatio : 0,
    };

    function descAxis(w) {
      var labels = ['aX','aY','aZ'];
      var abs = w.map(Math.abs);
      var maxI = abs.indexOf(Math.max.apply(null, abs));
      var pct = (abs[maxI] * 100).toFixed(0);
      if (pct > 95) return (w[maxI]<0?'-':'+') + labels[maxI] + ' (' + pct + '%)';
      return w.map(function(v,i) { return (v>=0?'+':'') + v.toFixed(2) + '\u00B7' + labels[i]; }).join(' ');
    }

    setS('✅ 캘리브레이션 완료!');
    setB(100);
    log('<span class="log-ok">✓</span> 직교도: ' + ((1-gs.ortho)*100).toFixed(1) + '% (X-Y ' + gs.angleXY.toFixed(1) + '\u00B0)');

    if (result) {
      result.style.display = 'block';
      var html = '<div><b>Printer X</b> = ' + descAxis(gs.wx) + '</div>'
        + '<div><b>Printer Y</b> = ' + descAxis(gs.wy) + '</div>'
        + '<div><b>Printer Z</b> = ' + descAxis(gs.wz) + ' (' + (gMag/256).toFixed(2) + 'g)</div>'
        + '<div style="margin-top:4px;font-size:11px;color:var(--tx3)">직교도: ' + ((1-gs.ortho)*100).toFixed(1) + '% | X-Y: ' + gs.angleXY.toFixed(1) + '\u00B0 | X:' + xActive + ' Y:' + yActive + ' segs</div>';
      if (FAN_ON && typeof fanEnergyRatio !== 'undefined') {
        html += '<div style="font-size:11px;color:var(--tx3)">팬 에너지 비율: ' + fanEnergyRatio.toFixed(1) + '×</div>';
      }
      if (gs.ortho > 0.15) {
        html += '<div style="color:#EBCB8B;font-size:11px;margin-top:4px">\u26A0 직교도 낮음 — X/Y 구분이 불확실합니다. 재측정을 권장합니다.</div>';
      }
      result.innerHTML = html;
    }
    if (saveBtn) saveBtn.style.display = 'inline-flex';

  } catch (e) {
    setS('\u274C ' + e.message);
    log('<span class="log-err">\u2717</span> ' + e.message);
  }
  if (startBtn) startBtn.disabled = false;
}

async function saveCalibration() {
  if (!_calWeights) return;
  try {
    var payload = { calWx: _calWeights.wx, calWy: _calWeights.wy };
    // v1.0: 팬 피크도 저장
    if (_calWeights.fanPeaks && _calWeights.fanPeaks.length > 0) {
      payload.fanPeaks = _calWeights.fanPeaks;
    }
    const r = await fetch('/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const d = await r.json();
    if (d.ok) {
      appLog('logAdxl', '<span class="log-ok">✓</span> ' + t('cal_saved'));
      // 팬 피크를 필터에 로드
      if (_calWeights.fanPeaks && typeof loadFanPeaks === 'function') {
        loadFanPeaks(_calWeights.fanPeaks);
      }
      const ob = document.getElementById('onboardBanner'); if (ob) ob.style.display = 'none';
      const st = document.getElementById('calStatus');
      if (st) st.innerHTML = '💾 ' + t('cal_saved');
    } else {
      appLog('logAdxl', '<span class="log-err">✗</span> ' + (d.error || t('log_save_fail')));
    }
  } catch (e) {
    appLog('logAdxl', '<span class="log-err">✗</span> ' + e.message);
  }
}

// ── 운동학별 UI 분기 ──
// ── 운동학별 UI 분기 ──

function getCfgKin()      { return document.getElementById('s_kin')?.value || 'corexy'; }

function updateKinUI() {
  const kin = getCfgKin();
  const beltContent = document.getElementById('beltContent');
  const beltNA = document.getElementById('beltNotApplicable');
  const beltNaText = document.getElementById('beltNaText');

  if (kin === 'corexy' || kin === 'corexz') {
    // CoreXY/CoreXZ: Belt Compare 활성
    if (beltContent) beltContent.style.display = 'block';
    if (beltNA) beltNA.style.display = 'none';
  } else {
    // Cartesian/Delta: Belt Compare 비활성 + 안내
    if (beltContent) beltContent.style.display = 'none';
    if (beltNA) beltNA.style.display = 'block';
    if (beltNaText) {
      beltNaText.textContent = kin === 'delta' ? t('belt_na_delta') : t('belt_na_cart');
    }
  }
}

// ── WiFi 스캔 ───────────────────────────────────────
async function scanWifi() {
  const btn = document.getElementById('wifiScanBtn');
  const box = document.getElementById('wifiScanResult');
  if (!box) return;
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  box.style.display = 'block';
  box.innerHTML = '<div style="padding:12px;color:var(--tx3);text-align:center">Scanning...</div>';

  try {
    const r = await fetch('/api/wifi/scan');
    const d = await r.json();
    if (!d.networks || d.networks.length === 0) {
      box.innerHTML = '<div style="padding:12px;color:var(--tx3);text-align:center">No networks found</div>';
      return;
    }
    // RSSI 순 정렬
    d.networks.sort((a, b) => b.rssi - a.rssi);
    box.innerHTML = d.networks.map(n => {
      const bars = n.rssi > -50 ? '▓▓▓▓' : n.rssi > -65 ? '▓▓▓░' : n.rssi > -75 ? '▓▓░░' : '▓░░░';
      const lock = n.enc ? '🔒' : '';
      return `<div class="wifi-item" onclick="selectWifi('${n.ssid.replace(/'/g,"\\'")}')" style="padding:8px 12px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--bg3)">
        <span>${lock} ${n.ssid}</span>
        <span style="font-family:monospace;font-size:11px;color:var(--tx3)">${bars} ${n.rssi}dBm</span>
      </div>`;
    }).join('');
  } catch (e) {
    box.innerHTML = '<div style="padding:12px;color:#FF5252">❌ Scan failed: ' + e.message + '</div>';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔍 Scan'; }
  }
}

function selectWifi(ssid) {
  const el = document.getElementById('s_staSSID');
  if (el) el.value = ssid;
  const box = document.getElementById('wifiScanResult');
  if (box) box.style.display = 'none';
  // 비밀번호 필드에 포커스
  const pw = document.getElementById('s_staPass');
  if (pw) pw.focus();
}

// ── 시스템 정보 ───────────────────────────────────────
async function updateSysInfo() {
  try {
    const r = await fetch('/api/adxl/status');
    const d = await r.json();
    const heap = document.getElementById('sysHeap');
    if (heap) heap.textContent = 'Heap: ' + (d.freeHeap ? (d.freeHeap/1024).toFixed(0) + 'KB' : '—');
    const up = document.getElementById('sysUptime');
    if (up) {
      const ms = d.uptime || 0;
      const min = Math.floor(ms / 60000);
      const hr = Math.floor(min / 60);
      up.textContent = 'Uptime: ' + (hr > 0 ? hr + 'h ' : '') + (min % 60) + 'm';
    }
  } catch(e) {}
}

function doReboot() { if (confirm('Reboot ESP32?')) fetch('/api/reboot',{method:'POST'}); }
function doFactoryReset() { if (confirm('Reset ALL settings?')) { resetSettings(); saveSettings(); } }

// ── ADXL 로그 함수 (인라인 onclick에서 분리) ──
async function checkAdxlLog() {
  const l = document.getElementById('logAdxl');
  try {
    const r = await fetch('/api/adxl/status');
    const d = await r.json();
    l.innerHTML = '<div>DevID: 0x' + (d.devId?.toString(16).toUpperCase()||'??') +
      ' | Rate: ' + d.sampleRate + 'Hz | Heap: ' + d.freeHeap + '</div>';
  } catch(e) {
    l.innerHTML = '<div style="color:#FF5252">❌ ' + e.message + '</div>';
  }
}

async function readAdxlRaw() {
  const l = document.getElementById('logAdxl');
  try {
    const r = await fetch('/api/adxl/raw');
    const d = await r.json();
    l.innerHTML = '<div>X:' + d.x + ' Y:' + d.y + ' Z:' + d.z +
      ' (' + d.xg?.toFixed(3) + 'g / ' + d.yg?.toFixed(3) + 'g / ' + d.zg?.toFixed(3) + 'g)</div>';
  } catch(e) {
    l.innerHTML = '<div style="color:#FF5252">❌ ' + e.message + '</div>';
  }
}
