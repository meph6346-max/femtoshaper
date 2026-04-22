// ============ FEMTO SHAPER i18n v0.8 ============
// EN , KO . / / .

const LANG = {
  en: {
    //
    tab_shaper:'Shaper', tab_diag:'Diagnostic',
    tab_live:'Live', tab_settings:'Settings',
    // Shaper
    peak_x:'Peak X', peak_y:'Peak Y', shaper:'Shaper', max_accel:'Max Accel',
    freq_response:'Frequency Response', btn_apply:'Apply Result',
    btn_start_measure:'Start Measure', btn_stop_measure:'Stop Measure',
    measure_title:'Vibration Measurement', measure_guide:'Attach the sensor to the printer and print any model to measure.<br>Calibration automatically separates X/Y axes.', measuring:'Measuring...',
    log_ready:'Ready. Press "Measure" to begin.',
    //
    shaper_perf:'Performance', shaper_lowvib:'Low vibration',
    // Apply
    apply_title:'Apply Input Shaper Result',
    apply_edit_hint:'You can adjust values before applying.',
    apply_download:'Download .gcode', apply_copy:'Copy to clipboard',
    // Print Validation,
    fusion_high:'High Confidence', fusion_medium:'Medium',
    // Diagnostic
    diag_overview:'Overview',
    diag_empty_title:'Printer Health Check', diag_empty_desc:'Run a measurement in the Shaper tab first.<br>Diagnostics will automatically analyze your printer.', diag_belt:'Belt', diag_carriage:'Carriage',
    diag_frame:'Frame', diag_symmetry:'Symmetry',
    diag_status:'Status', diag_complexity:'Complexity',
    diag_test_results:'Test Results', diag_recommended:'Recommended Checks',
    diag_not_run:'Not run', diag_normal:'Normal',
    diag_warning:'Warning',
    diag_run_is_first:'Run Input Shaper for automatic analysis.',
    diag_belt_title:'Belt Tension Compare',
    diag_belt_desc:'Compares A/B belt paths via diagonal excitation. CoreXY/CoreXZ only.',
    diag_carriage_title:'Carriage / Bearing Check',
    diag_carriage_desc:'Short-stroke high-speed reciprocation to detect bearing play.',
    diag_frame_title:'Frame Stiffness Check',
    diag_frame_desc:'Full-stroke excitation to detect frame flex or loose joints.',
    diag_symmetry_title:'X/Y Axis Symmetry',
    diag_symmetry_desc:'Identical excitation on both axes to compare response.',
    diag_ok:'No anomaly detected',
    // Belt
    belt_a_peak:'Belt A Peak', belt_b_peak:'Belt B Peak',
    // Diagnostic G
    // Live
    live_guide_title:'What is this chart?',
    // Settings
    sec_printer:'Printer', build_x:'Build X (mm)', build_y:'Build Y (mm)',
    max_accel_set:'Max Accel (mm/s²)', max_feed:'Max Feed (mm/s)',
    kin_type:'Kinematics', kin_corexy:'CoreXY', kin_corexz:'CoreXZ',
    kin_cart:'Cartesian', kin_delta:'Delta',
    sample_rate:'Sample Rate (Hz)',
    sec_firmware:'Firmware & Apply',
    eeprom_save:'EEPROM Save',
    eeprom_no:'Temp only (recommended)', eeprom_yes:'Include M500 (EEPROM)',
    eeprom_hint:'Temp apply recommended. Run M500 after verification.', btn_save:'Save to Device',
    // Phase 4: Result Fusion
    // Phase 5: Stage 2 Diagnostic
    // Phase 5: Settings

    // UI (HTML data-i18n )
    // Tabs
    tab_shaper:'Shaper', tab_diag:'Diagnostic', tab_live:'Live', tab_settings:'Settings',
    // Shaper
    peak_x:'Peak X', peak_y:'Peak Y', shaper:'Shaper', max_accel:'Max Accel',
    freq_response:'Frequency Response', stab_basic:'Basic',stab_adv:'Advanced',stab_log:'Log',stab_sys:'System',energy:'Energy', dominant:'Peak', btn_start_live:'Start Live', btn_stop_live:'Stop', btn_apply:'⚡ Apply Result',
    // Apply
    apply_title:'Apply Input Shaper Result',
    apply_edit_hint:'You can adjust values before applying.',
    apply_copy:'Copy G-code', apply_download:'Download G-code',
    // Print & Measure,
    // Diagnostic
    tab_diag:'Diagnostic',
    diag_overview:'Overview',
    diag_empty_title:'Printer Health Check', diag_empty_desc:'Run a measurement in the Shaper tab first.<br>Diagnostics will automatically analyze your printer.', diag_status:'Status', diag_complexity:'Complexity Score',
    diag_test_results:'Test Results', diag_recommended:'Recommended Action',
    diag_run_is_first:'Run Quick Measure first to enable Stage 1 analysis.',
    // Diagnostic
    diag_belt_title:'Belt Compare', diag_belt:'Belt Asymmetry', diag_belt_desc:'Compare A/B belt tension via PSD peak.',
    belt_a_peak:'Belt A Peak', belt_b_peak:'Belt B Peak',
    diag_carriage_title:'Carriage/Bearing', diag_carriage:'Carriage Looseness',
    diag_carriage_desc:'Detect bearing wear via HF non-harmonic peaks.',
    diag_frame_title:'Frame Stiffness', diag_frame:'Frame Compliance',
    diag_frame_desc:'Detect frame flex via spectral spread.',
    diag_symmetry_title:'Axis Symmetry', diag_symmetry:'Axis Asymmetry',
    diag_symmetry_desc:'Compare X vs Y resonance frequency.',
    // Settings
    sec_printer:'Printer Config', build_x:'Build X (mm)', build_y:'Build Y (mm)',
    max_accel_set:'Max Accel (mm/s²)', max_feed:'Max Feed (mm/s)',
    kin_type:'Kinematics', sample_rate:'Sample Rate (Hz)',
    sec_firmware:'Firmware & EEPROM',
    eeprom_save:'EEPROM Save', eeprom_hint:'Temp only = no M500. Permanent = M500 auto.', btn_save:'Save', log_ready:'Ready.',
    // Live
    // Misc
    config_go_settings:'Settings →',
    // v0.8 UI
    demo_banner:'ADXL345 not connected — showing demo data. Not actual measurements.',

    onboard_title:'Welcome to FEMTO SHAPER',
    onboard_desc:'Axis calibration is required before first measurement. Place the sensor on your printer and calibrate.',
    onboard_cal:'Start Calibration', onboard_dismiss:'Dismiss',
    cal_step1:'Hold printer completely still for 10 seconds.',
    cal_step2:'Move the print head back and forth along the X-axis.',
    cal_fail_move:'X-axis movement not detected. Move faster or with greater range.',
    cal_fail_gravity:'Gravity detection failed. Check sensor connection.',
    cal_gravity_ok:'Gravity axis detected', cal_done:'Calibration complete!', cal_saved:'Saved — applied immediately.',
    save_blocked:'Settings not loaded — reconnect first',    chart_x_empty:'Press [Measure] below, then run G-code from SD card',
    chart_y_empty:'Y-axis starts automatically after X-axis',
    gpio_warn:'Pin changes require ESP32 restart. Default: SCK=4, MISO=2, MOSI=3, CS=1, INT1=0',
    // Diagnostic
    // ,
    // ADXL
    adxl_esp_fail:'ESP32 not connected',
    adxl_demo_msg:'ADXL345 not connected — showing demo. Not actual results.',
    //
    saving:'Saving...', save_blocked:'Settings not loaded — reconnect first', save_ok:'Settings saved successfully.',
    save_fail:'Save failed: ', result_saving:'Saving result...',
    btn_save_result:'Save Result',
    //
    guide_excellent:'🟢 High-speed printer — Apply directly!',
    guide_good:'🟢 Good — Suitable for most prints.',
    guide_ok:'🟡 OK — Effective at slower speeds.',
    guide_low:'🔴 Low — Check belts/mounts/frame, then re-test.',
    warn_low_conf:'🔴 Low confidence — check belt/mount/frame and re-measure.',
    // Live ,
    live_hint_default:'Real-time FFT spectrum. Axis mapping auto-set during IS measurement.',
    live_hint_mapped:'Real-time FFT spectrum. Axis map: ',
    // HTML
    adxl_log_hint:'Press button to check ADXL345 status.',
    // Validator
    val_pm_none:'Print & Measure not done — cross-validation recommended (fan off).',
    val_no_peak:'No Quick peak — check measurement conditions.',
    val_klipper_hint:'Klipper — paste into printer.RRF supports single frequency only — X applied.',
    val_temp_hint:'Temporary. For permanent: run M500 manually.',
    val_quick_unconfirmed:'Quick peak not confirmed by Print — possible fan interference.',
    // Log
    log_adxl_ok:'ADXL345 connected (DevID: ',
    log_adxl_fail:'ADXL345 not connected — switching to demo mode',
    log_wiring:'Check wiring: ',
    log_conn_err:'Connection error: ',
    log_error:'Error: ',
    log_nvs_ok:'Result saved to NVS',
    log_nvs_fail:'Result save failed: ',
    // Belt
    // Diag,
    log_restored:'Previous result restored: ',
    log_psd_note:' (PSD not restored — re-measurement recommended)',
    belt_na_cart:'Belt Compare is for CoreXY/CoreXZ printers only. Your Cartesian printer has independent X and Y belts — compare them individually using the Input Shaper measurement.',
    belt_na_delta:'Belt Compare is not applicable for Delta printers.',
    diag_na:'N/A',log_debug_reset:'Reset to defaults',log_report_done:'Report generated',log_save_fail:'Save failed',log_settings_fail:'Settings load failed — showing defaults. DO NOT save.',
    log_applied:'Applied',result_save_ok:'Result saved',result_save_fail:'Save failed: ',adxl_conn_fail:'ADXL345 connection failed',
    cal_desc:'Maps sensor axes to printer axes. Works at any angle.',
    cal_ready:'Press Start',
    cal_title:'Axis Calibration',
    cal_x_detected:'X-axis detected',
    debug_log:'Ready',
    warn_no_resonance:'No clear resonance detected — results show peak frequency estimates only.',
    diag_warning:'Warning — machine inspection recommended, shaper effect limited',
    pm_no_data:'No PSD data available',
    pm_corr_high:'X/Y separation poor — re-run calibration',
    pm_corr_ok:'X/Y separation good',
    pm_analysis_err:'Analysis failed',
    log_recommend:'Recommended:',
    pm_start:'Measurement started — start printing',
    pm_collecting:'Dual collecting... keep printing',
    pm_analyzing:'Measurement done — analyzing...',
    pm_ready:'Sufficient data collected! Press [Done] to start analysis.',
    pm_progress:'Collecting',
    pm_cal_required:'Axis calibration required. Run calibration in Settings.'
  },
  ko: {
    tab_shaper:'쉐이퍼', tab_diag:'진단', tab_live:'실시간', tab_settings:'설정',
    peak_x:'X축 피크', peak_y:'Y축 피크', shaper:'쉐이퍼', max_accel:'최대 가속도',
    freq_response:'주파수 응답', btn_apply:'결과 적용',
    btn_start_measure:'측정 시작', btn_stop_measure:'측정 완료',
    measure_title:'진동 측정', measure_guide:'센서를 프린터에 부착하고, 아무 모델이나 출력하면서 측정합니다.<br>캘리브레이션이 X/Y를 자동 분리합니다.', measuring:'측정 중...',
    log_ready:'준비 완료. "측정"을 누르세요.',
    shaper_perf:'성능 우선', shaper_lowvib:'저진동',
    apply_title:'인풋 쉐이퍼 결과 적용',
    apply_edit_hint:'적용 전 값을 수정할 수 있습니다.',
    apply_download:'.gcode 다운로드', apply_copy:'클립보드 복사',
    fusion_high:'신뢰도 높음', fusion_medium:'보통',
    diag_overview:'개요',
    diag_empty_title:'프린터 상태 진단', diag_empty_desc:'Shaper 탭에서 측정을 먼저 진행하세요.<br>측정 결과를 바탕으로 프린터 상태를 자동 분석합니다.', diag_belt:'벨트', diag_carriage:'캐리지',
    diag_frame:'프레임', diag_symmetry:'대칭',
    diag_status:'상태', diag_complexity:'복잡도',
    diag_test_results:'테스트 결과', diag_recommended:'권장 점검',
    diag_not_run:'미실행', diag_normal:'정상',
    diag_warning:'주의',
    diag_run_is_first:'인풋 쉐이퍼 실행 시 자동 분석됩니다.',
    diag_belt_title:'벨트 장력 비교',
    diag_belt_desc:'대각선 가진으로 A/B 벨트 경로를 비교합니다. CoreXY/CoreXZ 전용.',
    diag_carriage_title:'캐리지 / 베어링 점검',
    diag_carriage_desc:'짧은 스트로크 고속 왕복으로 베어링 유격이나 캐리지 느슨함을 감지합니다.',
    diag_frame_title:'프레임 강성 점검',
    diag_frame_desc:'풀 스트로크 가진으로 프레임 휨이나 조인트 느슨함을 감지합니다.',
    diag_symmetry_title:'X/Y 축 대칭성',
    diag_symmetry_desc:'양 축에 동일 가진을 적용하여 기계적 응답을 비교합니다.',
    diag_ok:'이상 없음',
    belt_a_peak:'벨트 A 피크', belt_b_peak:'벨트 B 피크',
    stab_basic:'기본설정',stab_adv:'고급설정',stab_log:'로그',stab_sys:'시스템',energy:'에너지', dominant:'지배 주파수', btn_start_live:'실시간 시작', btn_stop_live:'정지',
    live_guide_title:'이 차트는 무엇인가요?',
    sec_printer:'프린터', build_x:'빌드 X (mm)', build_y:'빌드 Y (mm)',
    max_accel_set:'최대 가속도 (mm/s²)', max_feed:'최대 이송속도 (mm/s)',
    kin_type:'키네마틱스', kin_corexy:'CoreXY', kin_corexz:'CoreXZ',
    kin_cart:'Cartesian', kin_delta:'Delta',
    sample_rate:'샘플링 레이트 (Hz)',
    sec_firmware:'펌웨어 & 적용',
    eeprom_save:'EEPROM 저장',
    eeprom_no:'임시 적용만 (권장)', eeprom_yes:'M500 포함 (EEPROM)',
    eeprom_hint:'임시 적용 권장. 확인 후 M500 수동 실행.', btn_save:'장치에 저장',
    // Phase 4: Result Fusion
    // Phase 5: Stage 2
    // Phase 5: Settings

    // UI (KO)
    tab_shaper:'쉐이퍼', tab_diag:'진단', tab_live:'실시간', tab_settings:'설정',
    peak_x:'X 피크', peak_y:'Y 피크', shaper:'쉐이퍼', max_accel:'최대 가속',
    freq_response:'주파수 응답', dominant:'주공진', btn_apply:'⚡ 결과 적용',
    apply_title:'인풋쉐이퍼 결과 적용',
    apply_edit_hint:'적용 전 값을 수정할 수 있습니다.',
    apply_copy:'G코드 복사', apply_download:'G코드 다운로드',
    diag_overview:'개요',
    diag_empty_title:'프린터 상태 진단', diag_empty_desc:'Shaper 탭에서 측정을 먼저 진행하세요.<br>측정 결과를 바탕으로 프린터 상태를 자동 분석합니다.', diag_status:'상태', diag_complexity:'복잡도',
    diag_test_results:'검사 결과', diag_recommended:'권장 조치',
    diag_run_is_first:'Quick Measure를 먼저 실행해 주세요.',
    diag_belt_title:'벨트 비교', diag_belt:'벨트 비대칭', diag_belt_desc:'A/B벨트 장력 비교.',
    belt_a_peak:'A벨트 피크', belt_b_peak:'B벨트 피크',
    diag_carriage_title:'캐리지/베어링', diag_carriage:'캐리지 느슨함',
    diag_carriage_desc:'베어링 마모를 고주파 피크로 감지.',
    diag_frame_title:'프레임 강성', diag_frame:'프레임 강성 부족',
    diag_frame_desc:'주파수 분포로 프레임 진동 감지.',
    diag_symmetry_title:'축 대칭', diag_symmetry:'축 비대칭',
    diag_symmetry_desc:'X/Y 공진 주파수 비교.',
    sec_printer:'프린터 설정', build_x:'X 크기 (mm)', build_y:'Y 크기 (mm)',
    max_accel_set:'최대 가속도 (mm/s²)', max_feed:'최대 속도 (mm/s)',
    kin_type:'키네마틱스', sample_rate:'샘플레이트 (Hz)',
    sec_firmware:'펌웨어 & EEPROM',
    eeprom_save:'EEPROM 저장', eeprom_hint:'임시=M500 없음. 영구=M500 자동.', btn_save:'저장', log_ready:'준비 완료.',
    config_go_settings:'설정 →',
    // v0.8 UI
    demo_banner:'ADXL345 미연결 — 데모 데이터로 표시 중입니다. 실제 측정 결과가 아닙니다.',

    onboard_title:'FEMTO SHAPER에 오신 것을 환영합니다',
    onboard_desc:'첫 측정 전에 축 캘리브레이션이 필요합니다. 센서를 프린터에 장착하고 캘리브레이션을 진행하세요.',
    onboard_cal:'캘리브레이션 시작', onboard_dismiss:'닫기',
    cal_step1:'프린터를 10초간 완전히 정지시켜 주세요.',
    cal_step2:'프린트 헤드를 X축 방향으로 앞뒤로 움직여 주세요.',
    cal_fail_move:'X축 이동이 감지되지 않았습니다. 더 빠르게 또는 더 큰 범위로 움직여 주세요.',
    cal_fail_gravity:'중력 감지 실패. 센서 연결을 확인하세요.',
    cal_gravity_ok:'중력 축 감지 완료', cal_done:'캘리브레이션 완료!', cal_saved:'저장됨 — 즉시 적용.',
    save_blocked:'설정 미로드 — 재연결 후 시도하세요',    chart_x_empty:'아래 [측정] 버튼을 누르고 G코드를 실행하세요',
    chart_y_empty:'X축 측정 후 자동으로 Y축이 진행됩니다',
    gpio_warn:'핀 변경 시 ESP32 재시작 필요. 기본: SCK=4, MISO=2, MOSI=3, CS=1, INT1=0',
    adxl_esp_fail:'ESP32 미연결',
    adxl_demo_msg:'ADXL345 미연결 — 데모 모드. 실제 결과가 아닙니다.',
    saving:'저장 중...', save_blocked:'Settings not loaded — reconnect first', save_ok:'설정이 저장되었습니다.',
    save_fail:'저장 실패: ', result_saving:'결과 저장 중...',
    btn_save_result:'결과 저장',
    guide_excellent:'🟢 고속 프린터 — 바로 적용 가능합니다!',
    guide_good:'🟢 양호 — 대부분의 프린트에 적합합니다.',
    guide_ok:'🟡 보통 — 느린 프린트에서 효과적입니다.',
    guide_low:'🔴 낮음 — 벨트/마운트/프레임 점검 후 재측정 권장.',
    warn_low_conf:'🔴 신뢰도 낮음 — 벨트/마운트/프레임 점검 후 재측정하세요.',
    live_hint_default:'실시간 FFT 스펙트럼. 축 매핑은 IS 측정 시 자동 설정됩니다.',
    live_hint_mapped:'실시간 FFT 스펙트럼. 축 매핑: ',
    adxl_log_hint:'버튼을 눌러 ADXL345 상태를 확인하세요.',
    val_pm_none:'Print & Measure 미수행 — 교차검증 권장 (팬 OFF).',
    val_no_peak:'Quick 피크 없음 — 측정 조건 확인 필요.',
    val_klipper_hint:'Klipper — printer.cfg에RRF는 단일 주파수만 지원 — X축만 적용됨.',
    val_temp_hint:'임시 적용. 영구 저장: M500 수동 실행.',
    val_quick_unconfirmed:'Quick 피크가 Print에서 미확인 — 팬 간섭 가능.',
    log_adxl_ok:'ADXL345 연결 확인 (DevID: ',
    log_adxl_fail:'ADXL345 미연결 — 데모 모드로 전환됩니다',
    log_wiring:'배선 확인: ',
    log_conn_err:'연결 오류: ',
    log_error:'오류: ',
    log_nvs_ok:'결과 NVS 저장 완료',
    log_nvs_fail:'결과 저장 실패: ',
    log_restored:'이전 측정 복원: ',
    log_psd_note:' (PSD 미복원 — 재측정 권장)',
    belt_na_cart:'벨트 비교는 CoreXY/CoreXZ 전용 기능입니다. Cartesian(베드슬링어) 프린터는 X와 Y 벨트가 독립적이므로, Input Shaper 측정으로 각 축을 개별 확인하세요.',
    belt_na_delta:'벨트 비교는 Delta 프린터에 적용되지 않습니다.',
    diag_na:'해당 없음',log_debug_reset:'기본값으로 초기화',log_report_done:'리포트 생성 완료',log_save_fail:'저장 실패',log_settings_fail:'설정 로드 실패 — 기본값 표시 중. 저장하지 마세요.',
    log_applied:'적용됨',result_save_ok:'결과 저장 완료',result_save_fail:'저장 실패: ',adxl_conn_fail:'ADXL345 연결 실패',
    cal_desc:'센서 축과 프린터 축을 자동 매핑합니다. 비스듬한 설치도 OK.',
    cal_ready:'시작 버튼을 누르세요',
    cal_title:'축 캘리브레이션',
    cal_x_detected:'X축 감지 완료',
    debug_log:'준비',
    warn_no_resonance:'명확한 공진이 감지되지 않았습니다 — 피크 주파수 기준 추정값입니다.',
    diag_warning:'경고 — 기계 점검 권장, 쉐이퍼 효과 제한적',
    pm_no_data:'PSD 데이터 없음',
    pm_corr_high:'X/Y 분리 불량 — 캘리브레이션 재실행 권장',
    pm_corr_ok:'X/Y 분리 양호',
    pm_analysis_err:'분석 실패',
    log_recommend:'추천:',
    pm_start:'측정 시작 — 출력을 시작하세요',
    pm_collecting:'듀얼 수집 중... 출력을 계속하세요',
    pm_analyzing:'측정 완료 — 분석 중...',
    pm_ready:'충분한 데이터 수집 완료! [완료] 버튼을 눌러 분석을 시작하세요.',
    pm_progress:'수집',
    pm_cal_required:'축 캘리브레이션이 필요합니다. 설정에서 캘리브레이션을 실행하세요.'
  }
};

let curLang = localStorage.getItem('fs_lang') || 'en';
function t(k) { return LANG[curLang]?.[k] || LANG.en[k] || k; }
function setLang(lang) {
  curLang = lang;
  localStorage.setItem('fs_lang', lang);
  document.documentElement.lang = lang;
  document.querySelectorAll('.lb').forEach(b =>
    b.classList.toggle('active', b.textContent.trim() === lang.toUpperCase()));
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const v = LANG[lang]?.[el.getAttribute('data-i18n')];
    if (v !== undefined) el.textContent = v;
  });
  document.querySelectorAll('[data-i18n-opt]').forEach(el => {
    const v = LANG[lang]?.[el.getAttribute('data-i18n-opt')];
    if (v !== undefined) el.textContent = v;
  });
  const lb = document.getElementById('liveBtnTxt');
  if (lb) lb.textContent = t('btn_start_live');
  // R17.21:
  ['logShaper', 'logAdxl', 'logDebug'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.children.length > 0) {
      el.innerHTML = '<div class="log-line log-info">[' + lang.toUpperCase() + '] ' +
        (lang === 'ko' ? '언어 전환됨 - 새 메시지부터 적용됩니다' : 'Language changed - applies to new messages') +
        '</div>';
    }
  });
}
