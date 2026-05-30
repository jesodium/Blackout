let logsHistory = [], currentLogFilter = 'all';

function addLog(text, type = 'info') {
  logsHistory.push({ text, type, timestamp: new Date().toLocaleTimeString(), id: Date.now() + Math.random().toString(36).substr(2, 5) });
  if (logsHistory.length > 80) logsHistory.shift();
  renderLogs();
}

function renderLogs() {
  const el = document.getElementById('log-stream');
  if (!el) return;
  const filtered = logsHistory.filter(l => {
    if (currentLogFilter === 'all') return true;
    if (currentLogFilter === 'alerts') return l.type === 'warn' || l.type === 'danger';
    return l.type === currentLogFilter;
  });
  el.innerHTML = filtered.map(l => {
    const cls = { warn: 'log-warn', danger: 'log-danger', ai: 'log-ai', system: 'log-system' }[l.type] || '';
    return `<div class="log-item ${cls}">
      <span class="log-time">[${l.timestamp}]</span>
      <span class="log-text">${escapeHtml(l.text)}</span>
    </div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}

function escapeHtml(t) {
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

function setupLogFilters() {
  document.querySelectorAll('.log-filter-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      document.querySelectorAll('.log-filter-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      currentLogFilter = e.target.getAttribute('data-filter');
      renderLogs();
    });
  });
}
