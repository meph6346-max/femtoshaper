// ============ FEMTO SHAPER Chart Engine v0.9 Chart.js ============
const _charts = {};

function _getOrCreate(canvasId, config) {
  // R19.27: destroy() /
  if (_charts[canvasId]) {
    try { _charts[canvasId].destroy(); } catch (e) { /*  already destroyed  */ }
    delete _charts[canvasId];
  }
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  _charts[canvasId] = new Chart(canvas.getContext('2d'), config);
  return _charts[canvasId];
}

function drawPSD(canvasId, data, peakHz, color, extraPeaks) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (!data || data.length === 0) {
    if (_charts[canvasId]) {
      try { _charts[canvasId].destroy(); } catch (e) {}
      delete _charts[canvasId];
    }
    // R19.25: (stale )
    try { canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); } catch (e) {}
    return;
  }
  const labels = data.map(d => typeof d==='object' ? d.f : 0);
  const values = data.map(d => typeof d==='object' ? d.v : d);
  const baseColor = color || '#2196F3';
  const peakColors = ['#FF5252','#FB8C00','#FFEB3B','#4CAF50','#9C27B0'];  // / / / /
  const allPeaks = [peakHz, ...(extraPeaks||[])].filter(f=>f>0);
  const pointBg = labels.map(f => {
    for (let p=0; p<allPeaks.length; p++) {
      if (Math.abs(f - allPeaks[p]) < 2) return peakColors[p] || '#FF5252';
    }
    return 'transparent';
  });
  const pointR = labels.map(f => {
    for (let p=0; p<allPeaks.length; p++) {
      if (Math.abs(f - allPeaks[p]) < 2) return Math.max(3, 5 - p);
    }
    return 0;
  });

  _getOrCreate(canvasId, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: baseColor,
        backgroundColor: baseColor + '18',
        fill: true, tension: 0.35, borderWidth: 1.5,
        pointBackgroundColor: pointBg, pointRadius: pointR, pointHoverRadius: 5,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 250 },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: {
          title: (i) => i[0].label + ' Hz',
          label: (i) => 'PSD: ' + i.raw.toFixed(1),
        }}
      },
      scales: {
        x: {
          type:'linear', min:0, max:150,
          title:{display:true,text:'Frequency (Hz)',color:'#888',font:{size:10}},
          ticks:{color:'#888',stepSize:25,font:{size:9}},
          grid:{color:'rgba(255,255,255,0.06)'},
        },
        y: { min:0, ticks:{display: typeof debugShowPsd!=='undefined'&&debugShowPsd, color:'#666', font:{size:8}, maxTicksLimit:4}, grid:{color:'rgba(255,255,255,0.04)'} }
      },
      interaction: { intersect:false, mode:'index' },
    }
  });
  const emptyEl = document.getElementById(canvasId + 'Empty');
  if (emptyEl) emptyEl.style.display = values.some(v=>v>0) ? 'none' : '';
}

function drawBeltChart(aData, bData, peakA, peakB) {
  const canvas = document.getElementById('cBelt');
  if (!canvas) return;
  const labelsA = (aData||[]).map(d=>d.f);
  const valuesA = (aData||[]).map(d=>d.v);
  const valuesB = (bData||[]).map(d=>d.v);

  _getOrCreate('cBelt', {
    type: 'line',
    data: {
      labels: labelsA,
      datasets: [
        { label:'A (X)', data:valuesA, borderColor:'#2196F3', backgroundColor:'rgba(33,150,243,0.08)',
          fill:true, tension:0.35, borderWidth:1.5, pointRadius:0, pointHoverRadius:4 },
        { label:'B (Y)', data:valuesB, borderColor:'#4CAF50', backgroundColor:'rgba(76,175,80,0.08)',
          fill:true, tension:0.35, borderWidth:1.5, pointRadius:0, pointHoverRadius:4 },
      ]
    },
    options: {
      responsive:true, maintainAspectRatio:false, animation:{duration:250},
      plugins: {
        legend:{display:true,position:'top',labels:{color:'#aaa',font:{size:10},boxWidth:12}},
        tooltip:{callbacks:{title:(i)=>i[0].label+' Hz'}},
      },
      scales: {
        x:{type:'linear',min:0,max:150,ticks:{color:'#888',stepSize:25,font:{size:9}},grid:{color:'rgba(255,255,255,0.06)'}},
        y:{min:0,ticks:{display: typeof debugShowPsd!=='undefined'&&debugShowPsd, color:'#666', font:{size:8}, maxTicksLimit:4},grid:{color:'rgba(255,255,255,0.04)'}},
      },
      interaction:{intersect:false,mode:'index'},
    }
  });
}

let _liveChart = null;
let liveDataY = new Array(59).fill(0);
// +
let _peakHold = new Array(59).fill(0);
let _hitMap = new Array(59).fill(0);
let _peakHoldOn = true;
let _liveFrameCount = 0;
let _lastLiveStatusUpdate = 0;

function togglePeakHold() {
  _peakHoldOn = !_peakHoldOn;
  const btn = document.getElementById('livePeakHoldBtn');
  if (btn) btn.className = _peakHoldOn ? 'btn btn-pri btn-sm' : 'btn btn-out btn-sm';
  if (!_peakHoldOn) _peakHold.fill(0);
}
function resetLiveHistory() {
  _peakHold.fill(0); _hitMap.fill(0); _liveFrameCount = 0;
  const st = document.getElementById('liveStatus');
  if (st) st.textContent = '';
}

// R19.28: Live destroy ( )
function destroyLiveChart() {
  if (_liveChart) {
    try { _liveChart.destroy(); } catch (e) {}
    _liveChart = null;
  }
  _peakHold.fill(0);
  _hitMap.fill(0);
  liveDataY.fill(0);
  _liveFrameCount = 0;
}

function drawLiveFrame(liveData, dataY) {
  const canvas = document.getElementById('cLive');
  if (!canvas) return;
  // R19.26: NaN/Infinity - SSE Chart.js
  if (!Array.isArray(liveData)) liveData = [];
  for (let i = 0; i < liveData.length; i++) {
    if (!Number.isFinite(liveData[i])) liveData[i] = 0;
  }
  if (dataY) {
    for (let i = 0; i < dataY.length && i < liveDataY.length; i++) {
      liveDataY[i] = Number.isFinite(dataY[i]) ? dataY[i] : 0;
    }
  }

  //
  const maxV = Math.max(...liveData, 1);
  const threshold = maxV * 0.05;
  for (let i=0; i<59; i++) {
    // :
    if (_peakHoldOn) _peakHold[i] = Math.max(_peakHold[i] * 0.97, liveData[i]);
    // :
    _hitMap[i] = _hitMap[i] * 0.985 + ((liveData[i] > threshold) ? 0.015 : 0);
  }
  _liveFrameCount++;

  // :
  const xColors = liveData.map((v, i) => {
    const h = Math.min(1, _hitMap[i] * 5); // 0~1
    if (h < 0.1) return 'rgba(136,192,208,0.5)';     //
    if (h < 0.3) return 'rgba(136,192,208,0.8)';     //
    if (h < 0.5) return 'rgba(163,190,140,0.8)';     //
    if (h < 0.7) return 'rgba(235,203,139,0.85)';    //
    return 'rgba(208,135,112,0.9)';                    // ( )
  });

  // Bin geometry may be overridden per-frame via window.liveBinMin / liveFreqRes
  // (set by live.js from the SSE "bm"/"fr" fields). Defaults are the 3200Hz
  // geometry so behaviour is unchanged when the server does not send them.
  const binMinLive  = (typeof window.liveBinMin  === 'number' && window.liveBinMin  > 0) ? window.liveBinMin  : 6;
  const freqResLive = (typeof window.liveFreqRes === 'number' && window.liveFreqRes > 0) ? window.liveFreqRes : 3.125;
  const labels = [];
  for (let i=0; i<liveData.length; i++) labels.push(((i+binMinLive)*freqResLive).toFixed(1));

  //
  const hint = document.getElementById('liveHint');
  if (hint && liveData.some(v => v > 0.1)) hint.style.display = 'none';

  if (!_liveChart) {
    _liveChart = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label:'X', data:[...liveData], backgroundColor:xColors, borderWidth:0, barPercentage:1.0, categoryPercentage:1.0 },
          { label:'Y', data:[...liveDataY], backgroundColor:'rgba(235,203,139,0.35)', borderWidth:0, barPercentage:1.0, categoryPercentage:1.0 },
          //
          { label:'Hold', data:_peakHoldOn?[..._peakHold]:[], type:'line', borderColor:'rgba(255,255,255,0.3)', borderWidth:1, pointRadius:0, fill:false, borderDash:[2,2] },
        ]
      },
      options: {
        responsive:true, maintainAspectRatio:false,
        animation:{duration:0},
        plugins:{legend:{display:false},tooltip:{callbacks:{
          title:(i)=>i[0].label+' Hz',
          label:(i)=>i.datasetIndex===2?'':((i.datasetIndex===0?'X':'Y')+': '+i.raw.toFixed(1)),
        }}},
        scales: {
          x:{ticks:{color:'#999',font:{size:9},autoSkip:true,maxTicksLimit:10,
              callback:function(val){const f=parseFloat(this.getLabelForValue(val));return(f%25<3.2)?f.toFixed(0):null}},
            grid:{color:'rgba(255,255,255,0.06)'},
            title:{display:true,text:'Hz',color:'#555',font:{size:9},padding:{top:2}}},
          y:{min:0,ticks:{display:false},grid:{color:'rgba(255,255,255,0.03)',drawTicks:false}},
        },
        layout:{padding:{left:2,right:4,top:4,bottom:0}},
      }
    });
  } else {
    if (!_liveChart.data?.datasets?.[0]) return;
    _liveChart.data.datasets[0].data = [...liveData];
    _liveChart.data.datasets[0].backgroundColor = xColors;
    if (_liveChart.data.datasets[1]) _liveChart.data.datasets[1].data = [...liveDataY];
    if (_liveChart.data.datasets[2]) _liveChart.data.datasets[2].data = _peakHoldOn ? [..._peakHold] : [];
    _liveChart.update('none');
  }

  // : 5 (60 )
  const now = Date.now();
  if (now - _lastLiveStatusUpdate > 5000 && _liveFrameCount > 30) {
    _lastLiveStatusUpdate = now;
    const st = document.getElementById('liveStatus');
    if (st) {
      // hitMap - use dynamic bin geometry (falls back to 3200Hz defaults)
      const hmBinMin  = (typeof window.liveBinMin  === 'number' && window.liveBinMin  > 0) ? window.liveBinMin  : 6;
      const hmFreqRes = (typeof window.liveFreqRes === 'number' && window.liveFreqRes > 0) ? window.liveFreqRes : 3.125;
      let topBins = [];
      for (let i=0; i<_hitMap.length && i<liveData.length; i++) {
        if (_hitMap[i] > 0.15) topBins.push({f:((i+hmBinMin)*hmFreqRes), h:_hitMap[i]});
      }
      topBins.sort((a,b) => b.h - a.h);
      if (topBins.length > 0) {
        const top = topBins.slice(0, 3).map(b => b.f.toFixed(0)+'Hz').join(' · ');
        st.textContent = '📍 ' + top;
        st.style.color = 'var(--tx2)';
      } else {
        st.textContent = '';
      }
    }
  }
}

// (HTML)
function shaperTable(containerId, analysis) {
  const el = document.getElementById(containerId);
  if (!el || !analysis?.recommended?.performance) return;
  const { shapers, recommended } = analysis;
  const perfName = recommended.performance.name;
  const lowvibName = recommended.lowVibration?.name || '';

  el.innerHTML = shapers.map(s => {
    const col = s.vibrPct < 1 ? '#4CAF50' : s.vibrPct < 5 ? '#FB8C00' : '#FF5252';
    const pct = Math.min(100, s.vibrPct * 15);
    let tag = '';
    if (s.name === perfName && s.name === lowvibName) tag = '<span class="rec-tag rec-p">P+L</span>';
    else if (s.name === perfName) tag = '<span class="rec-tag rec-p">PERF</span>';
    else if (s.name === lowvibName) tag = '<span class="rec-tag rec-l">LOW</span>';
    const isRec = s.name === perfName;
    return `<div class="sr${isRec ? ' rec' : ''}">
      <div class="sn">${s.name}${tag}</div><div class="sf">${s.freq.toFixed(1)}</div>
      <div class="sv" style="color:${col}">${s.vibrPct.toFixed(1)}%</div>
      <div class="sa">${s.maxAccel.toLocaleString()}</div>
      <div class="ss">${s.smoothing.toFixed(2)}</div>
      <div class="sb"><div class="bb"><div class="bf" style="width:${pct}%;background:${col}"></div></div></div>
    </div>`;
  }).join('');
}

//
function renderRecommendation(containerId, analysis) {
  const el = document.getElementById(containerId);
  if (!el || !analysis?.recommended?.performance) return;
  const { recommended, dampingRatio, confidence } = analysis;
  const p = recommended.performance, l = recommended.lowVibration, s = recommended.safe;

  let html = `► <strong>${t('shaper_perf')}</strong>: ${p.name} @ ${p.freq.toFixed(1)}Hz `
    + `(accel≤${p.maxAccel.toLocaleString()}, sm:${p.smoothing.toFixed(2)}, vibr:${p.vibrPct.toFixed(1)}%)`;
  if (l && p.name !== l.name)
    html += `<br>► <strong>${t('shaper_lowvib')}</strong>: ${l.name} @ ${l.freq.toFixed(1)}Hz `
      + `(accel≤${l.maxAccel.toLocaleString()}, sm:${l.smoothing.toFixed(2)}, vibr:${l.vibrPct.toFixed(1)}%)`;
  if (s && s.freq > 0 && s.name !== p.name && (!l || s.name !== l.name))
    html += `<br>► <strong>Safe</strong>: ${s.name} @ ${s.freq.toFixed(1)}Hz (accel≤${s.maxAccel.toLocaleString()})`;

  html += `<br><span style="color:var(--tx3)">Damping: ${(dampingRatio||0).toFixed(3)}`;
  if (confidence !== undefined) {
    const cBar = '\u2588'.repeat(Math.round(confidence*5)) + '\u2591'.repeat(5-Math.round(confidence*5));
    html += '&nbsp;|&nbsp;Confidence: ' + (confidence*100).toFixed(0) + '% ' + cBar;
  }
  html += '</span>';
  const accel = p.maxAccel;
  let guide = accel>=10000?t('guide_excellent'):accel>=5000?t('guide_good'):accel>=2000?t('guide_ok'):t('guide_low');
  html += `<div style="margin-top:4px;font-size:11px;padding:4px 8px;background:rgba(255,255,255,0.04);border-radius:4px">${guide}</div>`;
  el.innerHTML = html;
}

// PSD
function genPSD(peak, amp, noise, peak2) {
  const data = [];
  for (let f = 0; f <= 200; f += 0.5) {
    let v = noise + Math.random() * noise * 0.25;
    v += amp / (1 + Math.pow((f - peak) / 3.5, 2));
    if (peak2) v += amp * 0.3 / (1 + Math.pow((f - peak2) / 4, 2));
    v *= Math.exp(-f / 300);
    if (f < 10) v += noise * 2 * (1 - f / 10);
    data.push({ f, v: Math.max(0, v) });
  }
  return data;
}
