// ============ FEMTO SHAPER i18n ============
// English is the embedded base language.
// Additional languages are loaded from /lang/{code}.json at runtime.
// Add a new language: drop a {code}.json file in data/lang/ and list it in manifest.json.

const LANG_EN = {
  tab_shaper:'Shaper', tab_diag:'Diagnostic', tab_live:'Live', tab_settings:'Settings',
  peak_x:'Peak X', peak_y:'Peak Y', shaper:'Shaper', max_accel:'Max Accel',
  freq_response:'Frequency Response',
  btn_apply:'⚡ Apply Result', btn_start_measure:'Start Measure', btn_stop_measure:'Stop Measure',
  measure_title:'Vibration Measurement',
  measure_guide:'Attach the sensor to the printer and print any model to measure.<br>Calibration automatically separates X/Y axes.',
  measuring:'Measuring...',
  log_ready:'Ready.',
  shaper_perf:'Performance', shaper_lowvib:'Low vibration',
  apply_title:'Apply Input Shaper Result',
  apply_edit_hint:'You can adjust values before applying.',
  apply_copy:'Copy G-code', apply_download:'Download G-code',
  fusion_high:'High Confidence', fusion_medium:'Medium',
  diag_overview:'Overview',
  diag_empty_title:'Printer Health Check',
  diag_empty_desc:'Run a measurement in the Shaper tab first.<br>Diagnostics will automatically analyze your printer.',
  diag_belt:'Belt Asymmetry', diag_carriage:'Carriage Looseness',
  diag_frame:'Frame Compliance', diag_symmetry:'Axis Asymmetry',
  diag_status:'Status', diag_complexity:'Complexity Score',
  diag_test_results:'Test Results', diag_recommended:'Recommended Action',
  diag_not_run:'Not run', diag_normal:'Normal', diag_warning:'Warning',
  diag_run_is_first:'Run Quick Measure first to enable Stage 1 analysis.',
  diag_belt_title:'Belt Compare', diag_belt_desc:'Compare A/B belt tension via PSD peak.',
  belt_a_peak:'Belt A Peak', belt_b_peak:'Belt B Peak',
  diag_carriage_title:'Carriage/Bearing', diag_carriage_desc:'Detect bearing wear via HF non-harmonic peaks.',
  diag_frame_title:'Frame Stiffness', diag_frame_desc:'Detect frame flex via spectral spread.',
  diag_symmetry_title:'Axis Symmetry', diag_symmetry_desc:'Compare X vs Y resonance frequency.',
  diag_ok:'No anomaly detected',
  stab_basic:'Basic', stab_adv:'Advanced', stab_log:'Log', stab_sys:'System',
  energy:'Energy', dominant:'Peak',
  btn_start_live:'Start Live', btn_stop_live:'Stop',
  live_guide_title:'What is this chart?',
  sec_printer:'Printer Config', build_x:'Build X (mm)', build_y:'Build Y (mm)',
  max_accel_set:'Max Accel (mm/s²)', max_feed:'Max Feed (mm/s)',
  kin_type:'Kinematics', kin_corexy:'CoreXY', kin_corexz:'CoreXZ', kin_cart:'Cartesian', kin_delta:'Delta',
  sample_rate:'Sample Rate (Hz)',
  sec_firmware:'Firmware & EEPROM',
  eeprom_save:'EEPROM Save',
  eeprom_no:'Temp only (recommended)', eeprom_yes:'Include M500 (EEPROM)',
  eeprom_hint:'Temp only = no M500. Permanent = M500 auto.',
  btn_save:'Save', btn_reset:'Reset',
  config_go_settings:'Settings →',
  demo_banner:'ADXL345 not connected — showing demo data. Not actual measurements.',
  onboard_title:'Welcome to FEMTO SHAPER',
  onboard_desc:'Axis calibration is required before first measurement. Place the sensor on your printer and calibrate.',
  onboard_cal:'Start Calibration', onboard_dismiss:'Dismiss',
  cal_step1:'Hold printer completely still for 10 seconds.',
  cal_step2:'Move the print head back and forth along the X-axis.',
  cal_fail_move:'X-axis movement not detected. Move faster or with greater range.',
  cal_fail_gravity:'Gravity detection failed. Check sensor connection.',
  cal_gravity_ok:'Gravity axis detected', cal_done:'Calibration complete!', cal_saved:'Saved — applied immediately.',
  save_blocked:'Settings not loaded — reconnect first',
  chart_x_empty:'Press [Measure] below, then run G-code from SD card',
  chart_y_empty:'Y-axis starts automatically after X-axis',
  gpio_warn:'Pin changes require ESP32 restart. Default: SCK=4, MISO=2, MOSI=3, CS=1, INT1=0',
  adxl_esp_fail:'ESP32 not connected',
  adxl_demo_msg:'ADXL345 not connected — showing demo. Not actual results.',
  saving:'Saving...', save_ok:'Settings saved successfully.',
  save_fail:'Save failed: ', result_saving:'Saving result...',
  btn_save_result:'Save Result',
  guide_excellent:'🟢 High-speed printer — Apply directly!',
  guide_good:'🟢 Good — Suitable for most prints.',
  guide_ok:'🟡 OK — Effective at slower speeds.',
  guide_low:'🔴 Low — Check belts/mounts/frame, then re-test.',
  warn_low_conf:'🔴 Low confidence — check belt/mount/frame and re-measure.',
  live_hint_default:'Real-time FFT spectrum. Axis mapping auto-set during IS measurement.',
  live_hint_mapped:'Real-time FFT spectrum. Axis map: ',
  adxl_log_hint:'Press button to check ADXL345 status.',
  val_pm_none:'Print & Measure not done — cross-validation recommended (fan off).',
  val_no_peak:'No Quick peak — check measurement conditions.',
  val_klipper_hint:'Klipper — paste into printer.cfg. RRF supports single frequency only — X applied.',
  val_temp_hint:'Temporary. For permanent: run M500 manually.',
  val_quick_unconfirmed:'Quick peak not confirmed by Print — possible fan interference.',
  log_adxl_ok:'ADXL345 connected (DevID: ',
  log_adxl_fail:'ADXL345 not connected — switching to demo mode',
  log_wiring:'Check wiring: ', log_conn_err:'Connection error: ', log_error:'Error: ',
  log_nvs_ok:'Result saved to NVS', log_nvs_fail:'Result save failed: ',
  log_restored:'Previous result restored: ',
  log_psd_note:' (PSD not restored — re-measurement recommended)',
  belt_na_cart:'Belt Compare is for CoreXY/CoreXZ printers only. Your Cartesian printer has independent X and Y belts — compare them individually using the Input Shaper measurement.',
  belt_na_delta:'Belt Compare is not applicable for Delta printers.',
  diag_na:'N/A', log_debug_reset:'Reset to defaults', log_report_done:'Report generated',
  log_save_fail:'Save failed',
  log_settings_fail:'Settings load failed — showing defaults. DO NOT save.',
  log_applied:'Applied', result_save_ok:'Result saved', result_save_fail:'Save failed: ',
  adxl_conn_fail:'ADXL345 connection failed',
  cal_desc:'Maps sensor axes to printer axes. Works at any angle.',
  cal_ready:'Press Start', cal_title:'Axis Calibration', cal_x_detected:'X-axis detected',
  debug_log:'Ready',
  warn_no_resonance:'No clear resonance detected — results show peak frequency estimates only.',
  pm_no_data:'No PSD data available', pm_corr_high:'X/Y separation poor — re-run calibration',
  pm_corr_ok:'X/Y separation good', pm_analysis_err:'Analysis failed',
  log_recommend:'Recommended:',
  pm_start:'Measurement started — start printing',
  pm_collecting:'Dual collecting... keep printing',
  pm_analyzing:'Measurement done — analyzing...',
  pm_ready:'Sufficient data collected! Press [Done] to start analysis.',
  pm_progress:'Collecting',
  pm_cal_required:'Axis calibration required. Run calibration in Settings.',
  language:'Language', lang_label:'Display language',

  conf_note:'This value is the signal quality of the measurement. Lower % means you should re-measure before applying.',
  warn_low_conf_detail:'Measurement confidence is low. Check sensor mounting and print conditions, then re-measure.',
  cal_start_announce:'Calibration is starting now. Follow the instructions below.',
  cal_onboard_confirm:'Calibration will start now and move you to Settings. Continue?',
  pm_min_segs_note:'Minimum measurement segments reached. Longer measurement time can produce more accurate results.',

  conf_band_high:'High', conf_band_medium:'Medium', conf_band_low:'Low',
  conf_guide_high:'Signal quality is strong enough for applying the result.',
  conf_guide_medium:'Usable, but you may re-measure if you want a cleaner result.',
  conf_guide_low:'Measurement signal quality is low. Check sensor mounting and print conditions, then re-measure.',
  conf_section_title:'Test Confidence', conf_signal_quality:'Measurement signal quality',

  verdict_apply:'APPLY', verdict_review:'REVIEW', verdict_retry:'RETRY', verdict_unknown:'UNKNOWN',

  diag_belt_zone_title:'{f}Hz Belt zone resonance ({ax}-axis)',
  diag_corexy_belt_desc:'This frequency is determined by belt tension. Similar frequencies on both axes is normal for CoreXY.',
  diag_corexy_belt_action:'Check belt tension is even. Pluck both belts — same pitch = OK.',
  diag_belt_desc:'Resonance from belt tension.',
  diag_belt_action:'Check belt tension.',
  diag_carriage_zone_title:'{f}Hz Carriage/hotend resonance ({ax}-axis)',
  diag_carriage_zone_desc:'Resonance from printhead and carriage mass. Loose bolts make this peak stronger.',
  diag_carriage_zone_action:'Check hotend mount bolts. Also inspect carriage wheels/rails.',
  diag_frame_zone_title:'{f}Hz Frame resonance ({ax}-axis)',
  diag_frame_zone_desc:'Resonance from frame rigidity. Appears when frame is weak or bolts are loose.',
  diag_frame_zone_action:'Tighten all frame corner bolts. Ensure printer is on a solid surface.',
  diag_generic_zone_title:'{f}Hz Resonance detected ({ax}-axis)',
  diag_generic_zone_desc:'Input shaper will automatically suppress vibration at this frequency.',
  diag_generic_zone_action:'Apply the shaper result to your printer.',
  diag_cart_y_desc:'The bed (Y-axis) is heavy, so resonance frequency is low. This is normal for Cartesian printers.',
  diag_harmonic_title:'{n} harmonic(s) detected — auto-handled',
  diag_harmonic_desc:'Integer multiples of fundamental frequency. Input shaper handles these automatically. ({list})',
  diag_fan_title:'{n} fan vibration(s) — not shaper target',
  diag_fan_desc:'Vibration from cooling fans. Cannot be fixed by input shaper. Anti-vibration mounts recommended.',
  diag_fan_action:'Install fan anti-vibration mounts.',
  diag_warn_attention:'Attention needed', diag_warn_check_n:'Please check {n} item(s)',
  diag_printer_good:'Printer looks good',
  diag_printer_good_desc:'Apply input shaper results to improve print quality',
  diag_no_resonance:'No clear resonance',
  diag_no_resonance_desc:'Check sensor attachment or measure longer',
  diag_all_clear:'All clear — everything looks normal',

  live_cal_not_run:'Calibration not run — using raw sensor axes. Run calibration in Settings for accurate X/Y separation.',
  live_cal_needed:'Calibration needed\nRun it in Settings first',

  kin_guide_corexy:'CoreXY — move the printhead diagonally or do zigzag moves to excite both belts.',
  kin_guide_cartesian:'Cartesian — move X and Y separately for clean axis separation.',
  kin_guide_indirect:'Indirect axis sensing — convergence takes longer. More printing time recommended.',
  kin_guide_direct:'Direct sensing on {ax}-axis.',
  kin_guide_slow_axis:'{ax}-axis uses indirect sensing. Convergence takes longer (current: ±{c}Hz)',
  kin_guide_converged:'{ax}-axis converged (±{c}Hz)',
};

let curLang = 'en';
let _langPack = {};

function t(k) {
  return _langPack[k] ?? LANG_EN[k] ?? k;
}

function tp(k, vars) {
  let s = t(k);
  if (vars) for (const [key, val] of Object.entries(vars)) {
    s = s.split('{' + key + '}').join(String(val == null ? '' : val));
  }
  return s;
}

async function _loadLangPack(code) {
  if (!code || code === 'en') { _langPack = {}; curLang = 'en'; return true; }
  try {
    const r = await fetch('/lang/' + code + '.json');
    if (!r.ok) return false;
    _langPack = await r.json();
    curLang = code;
    return true;
  } catch(e) { return false; }
}

async function fetchLangManifest() {
  try {
    const r = await fetch('/lang/manifest.json');
    return r.ok ? await r.json() : [];
  } catch(e) { return []; }
}

async function populateLangDropdown() {
  const sel = document.getElementById('s_lang');
  if (!sel) return;
  const langs = await fetchLangManifest();
  sel.innerHTML = '<option value="en">English</option>';
  langs.forEach(l => {
    const opt = document.createElement('option');
    opt.value = l.code;
    opt.textContent = l.name || l.code;
    sel.appendChild(opt);
  });
  sel.value = curLang;
}

function _applyLang() {
  document.documentElement.lang = curLang;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const v = t(el.getAttribute('data-i18n'));
    if (v !== undefined) el.textContent = v;
  });
  document.querySelectorAll('[data-i18n-opt]').forEach(el => {
    const v = t(el.getAttribute('data-i18n-opt'));
    if (v !== undefined) el.textContent = v;
  });
  const lb = document.getElementById('liveBtnTxt');
  if (lb) lb.textContent = t('btn_start_live');
  const langSel = document.getElementById('s_lang');
  if (langSel) langSel.value = curLang;
  ['logShaper', 'logAdxl', 'logDebug'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.children.length > 0) {
      el.innerHTML = '<div class="log-line log-info">[' + curLang.toUpperCase() + '] Language changed — applies to new messages</div>';
    }
  });
}

async function setLang(code) {
  await _loadLangPack(code);
  localStorage.setItem('fs_lang', curLang);
  _applyLang();
}

// Load saved language pack on startup (non-blocking; applies once ready).
(function () {
  const saved = localStorage.getItem('fs_lang') || 'en';
  curLang = saved;
  if (saved !== 'en') {
    fetch('/lang/' + saved + '.json')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(pack => { _langPack = pack; _applyLang(); })
      .catch(() => { curLang = 'en'; localStorage.removeItem('fs_lang'); });
  }
})();
