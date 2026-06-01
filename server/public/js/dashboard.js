// --- Socket ---
const socketUrl = window.location.port !== '3000' ? 'http://localhost:3000' : undefined;
const socket = io(socketUrl);

// --- Typewriter ---
let typewritingInterval = null;

function typewriteText(elementId, text) {
  const el = document.getElementById(elementId);
  if (!el) return;
  clearInterval(typewritingInterval);
  el.innerHTML = '';
  let i = 0;
  const cursor = document.createElement('span');
  cursor.className = 'terminal-cursor';
  typewritingInterval = setInterval(() => {
    if (i < text.length) { el.insertBefore(document.createTextNode(text.charAt(i)), cursor); i++; }
    else clearInterval(typewritingInterval);
  }, 15);
  el.appendChild(cursor);
}

// --- TTS ---
let ttsEnabled = true;
let ttsVoices = [];
let aiHistory = [];
let currentAnalysisText = '';

function loadVoices() { ttsVoices = window.speechSynthesis?.getVoices() || []; }
loadVoices();
if (window.speechSynthesis) speechSynthesis.onvoiceschanged = loadVoices;

function speakAnalysis(text) {
  if (!text || !window.speechSynthesis || !ttsVoices.length) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.85; u.pitch = 1.0; u.volume = 1.0; u.lang = 'en-US';
  const v = ttsVoices.find(v => v.lang.startsWith('en') && /samantha|alex|karen|moira|enhanced|google/i.test(v.name))
    || ttsVoices.find(v => v.lang.startsWith('en'))
    || ttsVoices[0];
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}

function addAiHistory(text, timestamp) {
  if (!text) return;
  const prev = aiHistory[aiHistory.length - 1];
  if (prev && prev.text === text) return;
  aiHistory.push({ text, timestamp, id: Date.now() + Math.random() });
  if (aiHistory.length > 20) aiHistory.shift();
  const list = document.getElementById('ai-history-list');
  if (!list) return;
  const item = document.createElement('div');
  item.className = 'ai-history-item';
  const ts = timestamp ? new Date(timestamp).toLocaleTimeString() : '';
  const snippet = text.length > 70 ? text.substring(0, 70) + '...' : text;
  item.innerHTML = '<span class="ai-history-time">' + ts + '</span>' + escapeHtml(snippet);
  item.addEventListener('click', () => {
    currentAnalysisText = text;
    typewriteText('ai-text', text);
  });
  list.appendChild(item);
  list.scrollTop = list.scrollHeight;
}

// --- Sensor setup ---
const sensorIds = ['temp','humid','dist','smoke','airq','roll','pitch','yaw'];
const sensorColors = {
  temp: '#f97316', humid: '#06b6d4', dist: '#fbbf24', smoke: '#f43f5e',
  airq: '#22c55e', roll: '#3b82f6', pitch: '#a855f7', yaw: '#ec4899'
};

const sparklines = {};
sensorIds.forEach(id => {
  sparklines[id] = new Sparkline(`${id}-spark`, sensorColors[id], 20);
});

const plotter = new TelemetryPlotter('telemetry-plotter', [
  { name: 'Distance',    key: 'dist', color: '#fbbf24' },
  { name: 'Air Quality', key: 'airq', color: '#22c55e' },
  { name: 'Temperature', key: 'temp', color: '#f97316' }
], 50);

// --- Helpers ---
function updateStatusPill(id, text, state) {
  const el = document.getElementById(`${id}-pill`);
  if (el) { el.textContent = text; el.className = `sensor-status-pill ${state}`; }
}

function setVal(id, val, fmt = v => v) {
  const el = document.getElementById(id);
  if (el) el.textContent = (val !== null && val !== undefined && !isNaN(val)) ? fmt(val) : '--';
}

let packetCounter = 0;

function processIncomingTelemetry(d) {
  packetCounter++;
  document.getElementById('packet-counter').textContent = packetCounter;
  Scene3D.isTelemetryReceived = true;

  setVal('temp',  d.temp,  v => v.toFixed(1));
  setVal('humid', d.humid, v => v.toFixed(1));
  setVal('dist',  d.dist,  v => v.toFixed(0));
  setVal('smoke', d.smoke, v => v.toFixed(0));
  setVal('airq',  d.airq,  v => v.toFixed(0));
  setVal('roll',  d.roll,  v => v.toFixed(1));
  setVal('pitch', d.pitch, v => v.toFixed(1));
  setVal('yaw',   d.yaw,   v => v.toFixed(1));

  sensorIds.forEach(id => sparklines[id].addPoint(d[id]));
  plotter.addData(d);

  if (d.temp != null && !isNaN(d.temp)) {
    if (d.temp > 45)      updateStatusPill('temp', 'Critical', 'danger');
    else if (d.temp > 35) updateStatusPill('temp', 'High',     'warn');
    else                   updateStatusPill('temp', 'Normal',   'ok');
  }
  if (d.humid != null && !isNaN(d.humid)) {
    if (d.humid > 75 || d.humid < 20) updateStatusPill('humid', 'Out of range', 'warn');
    else                                updateStatusPill('humid', 'Good',         'ok');
  }
  if (d.smoke != null && !isNaN(d.smoke)) {
    if (d.smoke > 600)      updateStatusPill('smoke', 'Hazard',  'danger');
    else if (d.smoke > 300) updateStatusPill('smoke', 'Warning', 'warn');
    else                     updateStatusPill('smoke', 'Normal',  'ok');
  }
  if (d.airq != null && !isNaN(d.airq)) {
    if (d.airq > 800)      updateStatusPill('airq', 'Poor',     'danger');
    else if (d.airq > 450) updateStatusPill('airq', 'Moderate', 'warn');
    else                    updateStatusPill('airq', 'Good',     'ok');
  }
  if (d.roll != null && !isNaN(d.roll)) {
    if (Math.abs(d.roll) > 18)      updateStatusPill('roll', 'Tilt!',  'danger');
    else if (Math.abs(d.roll) > 8)  updateStatusPill('roll', 'Sway',   'warn');
    else                             updateStatusPill('roll', 'Stable', 'ok');
  }
  if (d.pitch != null && !isNaN(d.pitch)) {
    if (Math.abs(d.pitch) > 18)     updateStatusPill('pitch', 'Tilt!',  'danger');
    else if (Math.abs(d.pitch) > 8) updateStatusPill('pitch', 'Slope',  'warn');
    else                             updateStatusPill('pitch', 'Stable', 'ok');
  }
  updateStatusPill('yaw', 'Active', 'ok');

  if (d.roll != null && !isNaN(d.roll)) {
    Scene3D.targetRoll = d.roll * Math.PI / 180;
    document.getElementById('vis-roll').textContent = d.roll.toFixed(1);
  }
  if (d.pitch != null && !isNaN(d.pitch)) {
    Scene3D.targetPitch = d.pitch * Math.PI / 180;
    document.getElementById('vis-pitch').textContent = d.pitch.toFixed(1);
  }
  if (d.yaw != null && !isNaN(d.yaw)) {
    Scene3D.targetYaw = d.yaw * Math.PI / 180;
    document.getElementById('vis-yaw').textContent = d.yaw.toFixed(1);
  }

  document.getElementById('gyro-status').textContent = 'Gyroscope: Locked';

  if (d.dist != null && !isNaN(d.dist)) {
    document.getElementById('vis-dist').textContent = d.dist.toFixed(0);
    Scene3D.targetDist = Scene3D.SENSOR_Z + Math.min(d.dist * 0.04, 4.0);

    if (d.dist < 20)      updateStatusPill('dist', 'Alert',   'danger');
    else if (d.dist < 55) updateStatusPill('dist', 'Caution', 'warn');
    else                   updateStatusPill('dist', 'Clear',   'ok');

    const rad = isNaN(Scene3D.targetYaw) ? 0 : Scene3D.targetYaw;
    document.getElementById('vis-coord-x').textContent = (Math.sin(rad) * (d.dist / 100)).toFixed(2);

    if (Math.abs(d.dist - Scene3D.lastDist) > 3) {
      Scene3D.pingActive = true;
      Scene3D.pingTime = 0;
      Scene3D.lastDist = d.dist;
      const sev = d.dist < 20 ? 'danger' : (d.dist < 55 ? 'warn' : 'system');
      throttleLog(`Obstacle at ${d.dist.toFixed(0)} cm`, sev);
    }
  }
}

let lastLogTime = 0;
function throttleLog(text, type) {
  const now = Date.now();
  if (now - lastLogTime > 2400) { addLog(text, type); lastLogTime = now; }
}

// --- Uptime clock ---
const startEpoch = Date.now();
setInterval(() => {
  const e = Date.now() - startEpoch;
  const s = Math.floor((e / 1000) % 60);
  const m = Math.floor((e / 60000) % 60);
  const h = Math.floor(e / 3600000);
  const p = v => String(v).padStart(2, '0');
  document.getElementById('mission-clock').textContent = `${p(h)}:${p(m)}:${p(s)}`;
}, 1000);

// --- Init ---
setupLogFilters();
addLog('System ready. Waiting for connection...', 'system');

// --- AI controls ---
document.getElementById('btn-analyze')?.addEventListener('click', () => {
  document.getElementById('ai-badge').textContent = 'Analyzing...';
  document.querySelector('.ai-card')?.classList.add('analyzing');
  socket.emit('request-analysis');
});
document.getElementById('tts-enable')?.addEventListener('change', e => { ttsEnabled = e.target.checked; });

// --- Socket events ---
socket.on('connect', () => {
  document.getElementById('status-dot').className = 'status-dot active';
  document.getElementById('status-text').textContent = 'Connected';
  document.getElementById('satellite-ping').textContent = '—';
  addLog('Connected to server. Waiting for telemetry...', 'system');
});

socket.on('disconnect', () => {
  document.getElementById('status-dot').className = 'status-dot offline';
  document.getElementById('status-text').textContent = 'Disconnected';
  document.getElementById('satellite-ping').textContent = '—';
  sensorIds.forEach(id => updateStatusPill(id, '—', ''));
  document.getElementById('gyro-status').textContent = 'Gyroscope: Standby';
  addLog('Connection lost. Reconnecting...', 'danger');
});

socket.on('sensor-data', d => {
  if (!d) return;
  const lat = d.timestamp ? Math.max(0, Date.now() - d.timestamp) : NaN;
  document.getElementById('satellite-ping').textContent = isNaN(lat) ? '—' : lat + ' ms';
  processIncomingTelemetry(d);
});

socket.on('ai-analysis', d => {
  if (!d || !d.analysis) return;
  currentAnalysisText = d.analysis;
  addLog('AI analysis received.', 'ai');
  typewriteText('ai-text', d.analysis);
  addAiHistory(d.analysis, d.timestamp);
  document.getElementById('ai-badge').textContent = 'Online';
  document.querySelector('.ai-card')?.classList.remove('analyzing');
  if (ttsEnabled) speakAnalysis(d.analysis);
});
