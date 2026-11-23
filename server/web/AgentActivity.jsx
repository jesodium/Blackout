// Claude's live work, docked under Sage's chat. ReactBits' Agent Activity is the
// visual north star: per-step status dots, elapsed timer, a cancel control. The
// events are already on the wire — claude.js streams `claude-step` for every
// narration line and tool call, and `claude-job` brackets a delegated run. This
// just gives them somewhere to live besides the chat feed.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './AgentActivity.css';

const LIVE = new Set(['running', 'busy']);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const mmss = (ms) => {
  const s = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const LABEL = { running: 'working', busy: 'queued', done: 'done', stopped: 'stopped', failed: 'failed' };

export default function AgentActivity({ claudeBusy = false }) {
  const [open, setOpen] = useState(false);
  const [job, setJob] = useState(null);
  const [steps, setSteps] = useState([]);
  const [now, setNow] = useState(Date.now());
  const log = useRef(null);

  // A delegated run announces itself before it starts (`claude-job: running`),
  // so that's what opens the panel. A direct Claude chat has no job event — it
  // only streams steps — so the first step makes a small synthetic job instead.
  useEffect(() => {
    const s = window.socket;
    if (!s) return undefined;
    const onJob = (j) => {
      // the "busy" variant of this event has no timestamp; give every job one
      setJob({ ...j, at: j.at || Date.now() });
      if (j.state === 'running') {
        setSteps([]);
        setOpen(true);
      } else if (j.state === 'busy') {
        setOpen(true);
      }
    };
    const onStep = (x) => {
      const at = x.timestamp || Date.now();
      setSteps((prev) => [...prev, { ...x, at }].slice(-300));
      setJob((cur) => (cur && LIVE.has(cur.state) ? cur : {
        id: 'direct', task: 'Direct Claude chat', state: 'running', at, text: null, direct: true
      }));
    };
    s.on('claude-job', onJob);
    s.on('claude-step', onStep);
    return () => { s.off('claude-job', onJob); s.off('claude-step', onStep); };
  }, []);

  // Direct chats have no result event; the chat's own busy flag is the bracket.
  useEffect(() => {
    if (claudeBusy) return;
    setJob((cur) => (cur && cur.direct && LIVE.has(cur.state)
      ? { ...cur, state: 'done', end: Date.now() } : cur));
  }, [claudeBusy]);

  const live = !!job && LIVE.has(job.state);
  useEffect(() => {
    if (!live) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live, job?.id]);

  useEffect(() => {
    if (open && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [steps.length, job?.state, open]);

  const stop = () => fetch('/api/claude/stop', { method: 'POST' }).catch(() => {});

  const toggle = (
    <button type="button" className={`aa-toggle${live ? ' is-live' : ''}`}
      aria-expanded={open} aria-controls="claude-activity" title="Claude activity"
      onClick={() => setOpen((v) => !v)}>
      <span className="aa-toggle-dot" aria-hidden="true" />
      <span>activity</span>
    </button>
  );
  const slot = document.getElementById('sage-activity-slot');

  const elapsed = job ? mmss((job.end || (live ? now : job.at)) - job.at) : null;

  return (
    <>
      {slot ? createPortal(toggle, slot) : toggle}

      {open ? (
        <section id="claude-activity" className="aa" role="region" aria-label="Claude activity">
          <header className="aa-head">
            <span className="aa-title">Claude activity</span>
            <span className={`aa-state is-${job?.state || 'idle'}`}>
              <i className="aa-dot" aria-hidden="true" />
              {LABEL[job?.state] || 'idle'}
            </span>
            {elapsed ? <time className="aa-clock">{elapsed}</time> : null}
            <span className="aa-grow" />
            {live ? <button type="button" className="aa-btn aa-stop" onClick={stop}>Stop</button> : null}
            <button type="button" className="aa-btn aa-close" aria-label="Close activity" onClick={() => setOpen(false)}>✕</button>
          </header>

          {job?.task ? <p className="aa-task" title={job.task}>{clip(job.task, 200)}</p> : null}

          <ol className="aa-log" ref={log} aria-live="polite">
            {!steps.length && !job?.text ? (
              <li className="aa-empty">
                {live ? 'Waiting for Claude’s first step…' : 'No Claude activity yet. Hand Sage a task and she’ll pass it to Claude.'}
              </li>
            ) : null}

            {steps.map((s, i) => (
              <li key={s.id || i} className={`aa-row${i === steps.length - 1 && live ? ' is-current' : ''}`}
                data-kind={s.name ? 'tool' : 'say'}>
                <span className="aa-mark" aria-hidden="true" />
                <div className="aa-body">
                  {s.say ? <p className="aa-say">{s.say}</p> : null}
                  {s.name ? (
                    <div className="aa-call">
                      <code>{s.name}</code>
                      {s.arg ? <span className="aa-arg">{s.arg}</span> : null}
                    </div>
                  ) : null}
                  <time className="aa-at">+{mmss(s.at - (job?.at || s.at))}</time>
                </div>
              </li>
            ))}

            {job?.text && !live ? (
              <li className="aa-result">
                <span className="aa-result-k">{job.state === 'failed' ? 'Error' : 'Result'}</span>
                <p>{job.text}</p>
                {job.cost != null ? <span className="aa-cost">${Number(job.cost).toFixed(4)}</span> : null}
              </li>
            ) : null}
          </ol>
        </section>
      ) : null}
    </>
  );
}
