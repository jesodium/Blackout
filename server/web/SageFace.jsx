// the ascii face. moods live here, the motion is in SageFace.css — a mood with no css
// rule renders blank.

import { useEffect, useRef } from 'react';
import './SageFace.css';

export const MOODS = ['idle', 'scanning', 'thinking', 'clear', 'caution', 'alert', 'work'];

const FACES = {
  idle:     ['-', '_', '-'],
  scanning: ['o', '_', 'o'],
  thinking: ['>', '_', '<'],
  clear:    ['^', '_', '^'],
  caution:  [':', 'O', ''],
  alert:    ['x', '_', 'x'],
  work:     ['O', '_', 'O'],
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export default function SageFace({ mood = 'idle', gaze = true, className = '' }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!gaze || !el) return;
    const onMove = (e) => {
      const r = el.getBoundingClientRect();
      if (!r.width) return;
      const dx = clamp((e.clientX - (r.left + r.width / 2)) / (r.width * 3), -1, 1);
      const dy = clamp((e.clientY - (r.top + r.height / 2)) / (r.height * 3), -1, 1);
      el.style.setProperty('--sf-gx', (dx * 0.14).toFixed(3) + 'em');
      el.style.setProperty('--sf-gy', (dy * 0.1).toFixed(3) + 'em');
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [gaze]);

  const m = MOODS.includes(mood) ? mood : 'idle';
  const [l, mo, r] = FACES[m];
  return (
    <div ref={ref} className={`sage-face is-${m} ${className}`} aria-hidden="true">
      <span className="sf-scan">
        <span className="sf-eye sf-l"><b className="sf-open">{l}</b><b className="sf-shut">-</b></span>
        <span className="sf-mouth">{mo}</span>
        <span className="sf-eye sf-r"><b className="sf-open">{r}</b><b className="sf-shut">-</b></span>
      </span>
      <span className="sf-z">z</span>
    </div>
  );
}
