// ============ FEMTO SHAPER Report v1.0 ============
// Print Measure
// + +

// (Print Measure )
var _lastCorrelation = 0, _lastGateRatio = 0;
var _lastConvergenceX = 0, _lastConvergenceY = 0;
var _lastSegTotal = 0, _lastSegActive = 0;
var _prevResult = null; // ( )

function generateReport() {
  if (!xAnalysis || !yAnalysis) {
    appLog('logShaper', '<span class="log-err">\u2717</span> No analysis data');
    return;
  }
  var lang = typeof curLang !== 'undefined' ? curLang : 'en';
  var ko = lang === 'ko';
  var cfg = getSettingsCfg();
  var kin = cfg.kin || 'corexy';
  var xPerf = xAnalysis.recommended ? xAnalysis.recommended.performance : null;
  var yPerf = yAnalysis.recommended ? yAnalysis.recommended.performance : null;
  if (!xPerf || !yPerf) { appLog('logShaper','<span class="log-err">\u2717</span> No shaper recommendation'); return; }
  var safeAccel = Math.min(xPerf.maxAccel, yPerf.maxAccel);
  var peakX = peakFreqXGlobal || 0;
  var peakY = peakFreqYGlobal || 0;
  var ts = new Date().toLocaleString();

  // 1.
  var diagCtx = {
    peakX: peakX, peakY: peakY,
    peaksX: (xAnalysis.multiPeak && xAnalysis.multiPeak.peaks) || [{f:peakX,rel:1}],
    peaksY: (yAnalysis.multiPeak && yAnalysis.multiPeak.peaks) || [{f:peakY,rel:1}],
    correlation: _lastCorrelation, gateRatio: _lastGateRatio,
    convergenceX: _lastConvergenceX, convergenceY: _lastConvergenceY,
  };
  var kinDiag = typeof runKinDiagnostics === 'function' ? runKinDiagnostics(kin, diagCtx) : [];

  // 2.
  var compDiag = [];
  if (typeof compareKinResults === 'function' && _prevResult) {
    compDiag = compareKinResults(kin, _prevResult, {
      peakX:peakX, peakY:peakY,
      nPeaksX: diagCtx.peaksX.length, nPeaksY: diagCtx.peaksY.length
    });
  }

  // 3.
  var effectX = typeof estimateShaperEffect === 'function' ? estimateShaperEffect(xAnalysis) : null;
  var effectY = typeof estimateShaperEffect === 'function' ? estimateShaperEffect(yAnalysis) : null;

  // 3b. + +
  var fanHtml = '';
  if (typeof _fanHotendPsd !== 'undefined' && _fanHotendPsd && _fanHotendPsd.length > 0) {
    fanHtml = '<h2>\uD83C\uDF00 '+(ko?'팬 진동 분류':'Fan Vibration Classification')+'</h2>';
    for (var i=0; i<_fanHotendPsd.length; i++) {
      var ff = (_fanHotendPsd[i].freq||_fanHotendPsd[i].f||0).toFixed(0);
      fanHtml += '<div class="dg" style="border-left-color:#EBCB8B"><span class="di">\uD83C\uDF00</span><span>'+ff+'Hz — '
        +(ko?'팬 기여분 차감 완료. 잔여 파워가 있으면 기계 공진도 존재':'Fan contribution subtracted. Remaining power indicates mechanical resonance')
        +'</span></div>';
    }
  }
  var harmHtml = '';
  if (xAnalysis._harmonics && xAnalysis._harmonics.length > 0) {
    harmHtml = '<h2>\uD83C\uDFB5 '+(ko?'하모닉 감지':'Harmonics Detected')+'</h2>';
    for (var i=0; i<xAnalysis._harmonics.length; i++) {
      var h = xAnalysis._harmonics[i];
      harmHtml += '<div class="dg" style="border-left-color:#B48EAD"><span class="di">\uD83C\uDFB5</span><span>'+(ko?h.ko:h.en)+'</span></div>';
    }
  }
  var zoomHtml = '';
  if (xAnalysis._zoom && xAnalysis._zoom.improved) {
    zoomHtml += '<div class="dg" style="border-left-color:#88C0D0"><span class="di">\uD83D\uDD0D</span><span>X '+(ko?'줌 정밀화':'Zoom refined')+': \u03B6='+xAnalysis._zoom.damping.toFixed(3)+' Q='+xAnalysis._zoom.Q.toFixed(1)+'</span></div>';
  }
  if (yAnalysis._zoom && yAnalysis._zoom.improved) {
    zoomHtml += '<div class="dg" style="border-left-color:#88C0D0"><span class="di">\uD83D\uDD0D</span><span>Y '+(ko?'줌 정밀화':'Zoom refined')+': \u03B6='+yAnalysis._zoom.damping.toFixed(3)+' Q='+yAnalysis._zoom.Q.toFixed(1)+'</span></div>';
  }
  if (zoomHtml) zoomHtml = '<h2>\uD83D\uDD0D '+(ko?'피크 정밀 분석':'Peak Precision')+'</h2>' + zoomHtml;

  // 4.
  var healthGrade = null;
  if (typeof assessPeakHealth === 'function') {
    try {
      var feat = typeof extractFeatures === 'function'
        ? extractFeatures(realPsdX||xPsdData||[], realPsdY||yPsdData||[], peakX, peakY)
        : {nPeaksX:diagCtx.peaksX.length, nPeaksY:diagCtx.peaksY.length, peakZonesX:[], peakZonesY:[]};
      healthGrade = assessPeakHealth(feat);
    } catch(e) {}
  }

  // 5.
  var qHtml = '';
  if (_lastGateRatio > 0) {
    qHtml = '<div class="g3">'
      + '<div class="mc"><div class="ml">'+(ko?'유효 세그':'Active')+'</div><div class="mv">'+(_lastGateRatio*100).toFixed(0)+'%</div><div class="ms">'+_lastSegActive+'/'+_lastSegTotal+'</div></div>'
      + '<div class="mc"><div class="ml">'+(ko?'X/Y 분리':'Separation')+'</div><div class="mv">'+(100-_lastCorrelation*100).toFixed(0)+'%</div></div>'
      + '<div class="mc"><div class="ml">'+(ko?'수렴':'Convergence')+'</div><div class="mv">\u00B1'+Math.max(_lastConvergenceX,_lastConvergenceY).toFixed(1)+'Hz</div></div>'
      + '</div>';
  }

  // 6. HTML
  var iconMap = {good:'\u2705',info:'\u2139\uFE0F',warn:'\u26A0\uFE0F',alert:'\uD83D\uDD34'};
  var colorMap = {good:'#A3BE8C',info:'#88C0D0',warn:'#EBCB8B',alert:'#BF616A'};
  function mkDiag(items, title) {
    if (!items || items.length === 0) return '';
    var h = '<h2>' + title + '</h2>';
    for (var i=0; i<items.length; i++) {
      var d = items[i];
      var icon = iconMap[d.status] || '\u2139\uFE0F';
      var color = colorMap[d.status] || '#88C0D0';
      var text = ko ? (d.ko||d.en||'') : (d.en||d.ko||'');
      h += '<div class="dg" style="border-left-color:'+color+'"><span class="di">'+icon+'</span><span>'+text+'</span></div>';
    }
    return h;
  }

  var kinName = typeof getKinProfile === 'function' ? getKinProfile(kin).name : kin;
  var kinDiagHtml = mkDiag(kinDiag, '\uD83D\uDD0D '+(ko?'키네마틱 진단':'Kinematics') + ' <small>('+kinName+')</small>');
  var compDiagHtml = mkDiag(compDiag, '\uD83D\uDCC8 '+(ko?'이전 대비 변화':'vs Previous'));

  //
  var effHtml = '';
  if (effectX || effectY) {
    effHtml = '<h2>\uD83C\uDFAF '+(ko?'쉐이퍼 효과 추정':'Shaper Effect')+'</h2><div class="g2">';
    if (effectX && effectX.perf) effHtml += '<div class="cd"><h3>X \u2014 '+effectX.perf.name+'@'+effectX.perf.freq.toFixed(1)+'Hz</h3><div class="vl">'+effectX.perf.suppression+'% <span class="un">'+(ko?'억제':'suppr.')+'</span></div><div class="sm">'+effectX.perf.maxAccel.toLocaleString()+' mm/s\u00B2</div></div>';
    if (effectY && effectY.perf) effHtml += '<div class="cd"><h3>Y \u2014 '+effectY.perf.name+'@'+effectY.perf.freq.toFixed(1)+'Hz</h3><div class="vl">'+effectY.perf.suppression+'% <span class="un">'+(ko?'억제':'suppr.')+'</span></div><div class="sm">'+effectY.perf.maxAccel.toLocaleString()+' mm/s\u00B2</div></div>';
    effHtml += '</div>';
  }

  //
  var hHtml = '';
  if (healthGrade) {
    var gradeL = {excellent:'\uD83D\uDFE2 Excellent',normal:'\uD83D\uDFE1 Normal',caution:'\uD83D\uDFE0 Caution',warning:'\uD83D\uDD34 Warning',critical:'\u26D4 Critical'};
    hHtml = '<h2>\uD83E\uDE7A '+(ko?'피크 건강도':'Peak Health')+' \u2014 '+(gradeL[healthGrade.grade]||healthGrade.grade)+'</h2>';
    for (var i=0; i<healthGrade.findings.length; i++) {
      var f = healthGrade.findings[i];
      hHtml += '<div class="fn"><b>'+(f.freq?f.freq.toFixed(0):'?')+'Hz</b> \u2014 '+(ko?(f.desc_ko||f.desc):(f.desc||''))+'<br><span class="ac">\u2192 '+(ko?(f.action_ko||f.action):(f.action||''))+'</span></div>';
    }
  }

  // Apply
  var applyCmd = typeof generateApplyGcode === 'function'
    ? generateApplyGcode({firmware:cfg.firmware,freqX:peakX,freqY:peakY,
        shaperTypeX:(xPerf.name||'zv').toLowerCase(),shaperTypeY:(yPerf.name||'zv').toLowerCase(),
        damping:cfg.damping,saveToEeprom:cfg.eepromSave})
    : '# N/A';

  // PSD JS
  var chartFn = 'function drawRptPSD(cid,psd,peak,color,mpeaks){var c=document.getElementById(cid);if(!c)return;var ctx=c.getContext("2d");var W=c.width=c.offsetWidth*2,H=c.height=c.offsetHeight*2;ctx.scale(2,2);var w=W/2,h=H/2;var maxF=150,maxV=0;for(var i=0;i<psd.length;i++)if(psd[i].v>maxV)maxV=psd[i].v;maxV*=1.2;ctx.fillStyle="#2E3440";ctx.fillRect(0,0,w,h);ctx.strokeStyle="#3B4252";ctx.lineWidth=0.5;for(var f=0;f<=maxF;f+=25){var x=f/maxF*w;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke()}ctx.strokeStyle=color;ctx.lineWidth=1.5;ctx.beginPath();for(var i=0;i<psd.length;i++){var x=psd[i].f/maxF*w,y=h-psd[i].v/maxV*h*0.9;i===0?ctx.moveTo(x,y):ctx.lineTo(x,y)}ctx.stroke();if(peak>0){var px=peak/maxF*w;ctx.strokeStyle="#BF616A";ctx.lineWidth=1;ctx.setLineDash([4,4]);ctx.beginPath();ctx.moveTo(px,0);ctx.lineTo(px,h);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle="#ECEFF4";ctx.font="11px sans-serif";ctx.textAlign="center";ctx.fillText(peak.toFixed(1)+"Hz",px,14)}ctx.fillStyle="#4C566A";ctx.font="10px sans-serif";ctx.textAlign="center";for(var f=0;f<=maxF;f+=50)ctx.fillText(f+"",f/maxF*w,h-2)}';

  var xPJ = JSON.stringify((realPsdX||xPsdData||[]).map(function(p){return{f:+(p.f).toFixed(2),v:+(p.v).toFixed(4)}}));
  var yPJ = JSON.stringify((realPsdY||yPsdData||[]).map(function(p){return{f:+(p.f).toFixed(2),v:+(p.v).toFixed(4)}}));

  //
  var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FEMTO SHAPER Report</title><style>'
    + '*{margin:0;padding:0;box-sizing:border-box}'
    + 'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#2E3440;color:#D8DEE9;padding:20px;max-width:700px;margin:0 auto;line-height:1.6}'
    + 'h1{color:#ECEFF4;font-size:22px;text-align:center;margin-bottom:4px}'
    + 'h2{color:#88C0D0;font-size:15px;margin:20px 0 10px;border-bottom:1px solid #4C566A;padding-bottom:6px}'
    + '.sub{text-align:center;color:#81A1C1;font-size:12px;margin-bottom:16px}'
    + '.g2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0}'
    + '.g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin:12px 0}'
    + '.cd{background:#3B4252;border-radius:8px;padding:14px}'
    + '.cd h3{color:#88C0D0;font-size:13px;margin-bottom:8px}'
    + '.mc{background:#3B4252;border-radius:6px;padding:10px;text-align:center}'
    + '.ml{font-size:10px;color:#81A1C1;margin-bottom:4px}.mv{font-size:16px;font-weight:700;color:#ECEFF4}.ms{font-size:10px;color:#4C566A;margin-top:2px}'
    + '.vl{font-size:20px;font-weight:700;color:#ECEFF4}.un{font-size:12px;color:#81A1C1}.sm{font-size:11px;color:#81A1C1;margin-top:4px}'
    + '.tg{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;background:#A3BE8C30;color:#A3BE8C}'
    + '.dg{display:flex;gap:10px;padding:10px 14px;margin:6px 0;background:#ffffff08;border-left:3px solid #88C0D0;border-radius:0 8px 8px 0;font-size:13px;line-height:1.5}.di{flex-shrink:0}'
    + '.fn{padding:8px 12px;margin:4px 0;background:#3B4252;border-radius:6px;font-size:12px;line-height:1.6}.ac{color:#81A1C1;font-size:11px}'
    + 'canvas{width:100%;height:120px;border-radius:6px;margin-top:8px}'
    + 'pre{background:#3B4252;padding:12px;border-radius:8px;font-size:11px;overflow-x:auto;color:#A3BE8C;margin:8px 0}'
    + '.ft{text-align:center;margin-top:30px;color:#4C566A;font-size:11px}'
    + '@media print{body{background:#fff;color:#333}h2{color:#2E5090}.cd,.mc{border:1px solid #ddd;background:#f8f8f8}.vl,.mv{color:#333}pre{background:#f0f0f0;color:#333}}'
    + '</style></head><body>'
    + '<h1>FEMTO SHAPER</h1>'
    + '<div class="sub">'+ts+' | '+kinName+' '+cfg.buildX+'\u00D7'+cfg.buildY+'mm | '+cfg.firmware+' | v1.0</div>'
    + '<h2>\uD83D\uDCCA '+(ko?'측정 결과':'Results')+'</h2>'
    + '<div class="g2">'
    + '<div class="cd"><h3>X '+(ko?'축':'Axis')+'</h3><div class="vl">'+peakX.toFixed(1)+' <span class="un">Hz</span></div>'
    + '<div style="margin-top:6px"><span class="tg">'+xPerf.name+'</span> <span class="un">@ '+xPerf.freq.toFixed(1)+'Hz</span></div>'
    + '<div class="sm">Accel: '+xPerf.maxAccel.toLocaleString()+' | Vibr: '+xPerf.vibrPct.toFixed(1)+'%</div><canvas id="cRX"></canvas></div>'
    + '<div class="cd"><h3>Y '+(ko?'축':'Axis')+'</h3><div class="vl">'+peakY.toFixed(1)+' <span class="un">Hz</span></div>'
    + '<div style="margin-top:6px"><span class="tg">'+yPerf.name+'</span> <span class="un">@ '+yPerf.freq.toFixed(1)+'Hz</span></div>'
    + '<div class="sm">Accel: '+yPerf.maxAccel.toLocaleString()+' | Vibr: '+yPerf.vibrPct.toFixed(1)+'%</div><canvas id="cRY"></canvas></div>'
    + '</div>'
    + '<div class="cd" style="margin-top:12px"><div style="display:flex;justify-content:space-between;align-items:center">'
    + '<div><span class="sm">'+(ko?'안전 최대 가속도':'Safe Max Accel')+'</span><br><span class="vl">'+safeAccel.toLocaleString()+' <span class="un">mm/s\u00B2</span></span></div>'
    + (healthGrade ? '<div style="text-align:right"><span class="sm">'+(ko?'건강도':'Health')+'</span><br><span style="font-size:24px">'+healthGrade.icon+'</span></div>' : '')
    + '</div></div>'
    + qHtml
    + effHtml
    + fanHtml
    + harmHtml
    + zoomHtml
    + kinDiagHtml
    + compDiagHtml
    + hHtml
    + '<h2>\u26A1 '+(ko?'적용 명령':'Apply')+ ' ('+cfg.firmware+')</h2>'
    + '<pre>'+applyCmd.replace(/</g,'&lt;')+'</pre>'
    + '<div class="ft">FEMTO SHAPER v1.0 \u2014 '+(ko?'오픈소스 3D프린터 진동 분석기':'Open Source 3D Printer Vibration Analyzer')+'</div>'
    + '<script>'+chartFn+';var xP='+xPJ+';var yP='+yPJ+';window.onload=function(){drawRptPSD("cRX",xP,'+peakX+',"#5E81AC");drawRptPSD("cRY",yP,'+peakY+',"#A3BE8C")}</script>'
    + '</body></html>';

  var blob = new Blob([html], {type:'text/html'});
  window.open(URL.createObjectURL(blob), '_blank');
  // ( )
  _prevResult = {peakX:peakX, peakY:peakY, nPeaksX:diagCtx.peaksX.length, nPeaksY:diagCtx.peaksY.length};
  appLog('logShaper', '<span class="log-ok">\u2713</span> ' + (t('log_report_done')||'Report generated'));
}
