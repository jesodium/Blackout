// Sage's half of the dashboard: a chat, sessions, and react-bits' PromptBar.
// Built into public/js/sage.bundle.{js,css} by `npm run build:web`.
//
// The panel opens on HOME: start a session or a temporary chat, or reopen a session.
// A TEMPORARY chat saves nothing and is gone when you leave it.
// A SESSION is a saved folder (server/data/missions/, /api/missions -- the server
// still calls them missions): a title and a description the crew writes, the
// notes Sage keeps across it ("remember"), what she found, and its chats. Every
// turn in one of its chats hands Sage AND Claude the whole folder (folderLine),
// so a new chat already knows what the session is for and what the others said.
// Only a chat (temporary, or one inside a session) shows the prompt bar.
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Camera01Icon, Camera02Icon, ClaudeIcon } from '@hugeicons/core-free-icons';
import PromptBar from './PromptBar';

// @ rows just put the camera's name in the message; Sage picks her own eye from it
const SOURCES = [
  { key: 'front', name: 'Front camera', description: 'cam 0, the headlamp eye', icon: Camera01Icon },
  { key: 'arm', name: 'Arm camera', description: 'cam 1, the gripper view', icon: Camera02Icon }
];
const COMMANDS = [
  { key: 'scan', name: '/scan', description: 'Look ahead and report' },
  { key: 'clear', name: '/clear', description: 'Clear this chat' }
];
// who answers. Sage is the Qwen backend (/api/chat, ~1s); the rest talk to Claude
// directly (/api/claude), the same model/effort lists runClaude() accepts
const CLAUDE_WARN = "This will go to Anthropic's servers and prompts may take longer.";
const MODELS = [
  { key: 'sage', name: 'Sage', badge: 'Recommended', tag: '[FASTEST]', icon: <span className="ascii-face">^_^</span> },
  { key: 'haiku', name: 'Haiku', tag: 'Fast', icon: ClaudeIcon, warn: CLAUDE_WARN },
  { key: 'sonnet', name: 'Sonnet', tag: 'Balanced', icon: ClaudeIcon, warn: CLAUDE_WARN },
  { key: 'opus', name: 'Opus', tag: 'Deep', icon: ClaudeIcon, warn: CLAUDE_WARN },
  { key: 'fable', name: 'Fable', tag: 'Flagship', icon: ClaudeIcon, warn: CLAUDE_WARN }
];
// Sage's are Qwen's reasoning levels (Standard = thinking off, her usual ~1s); Claude's are runClaude()'s
const SAGE_EFFORTS = ['Standard', 'Low', 'Medium', 'High'];
const CLAUDE_EFFORTS = ['Low', 'Medium', 'High', 'Xhigh', 'Max'];

const TEMP = 'temp';   // the chat key of the temporary chat

const keep = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} };
const kept = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const newChat = (title, messages = []) => ({ id: `c${Date.now()}`, title, messages, findings: [], created: Date.now() });

// title + description: blank to create a session, prefilled to edit one
function SessionForm({ session, onSubmit, onCancel }) {
  const [title, setTitle] = useState(session?.title || '');
  const [desc, setDesc] = useState(session?.brief || '');
  return (
    <form className="session-form" onSubmit={(e) => { e.preventDefault(); if (title.trim()) onSubmit(title.trim(), desc.trim()); }}>
      <label>
        <span className="k">Title</span>
        <input value={title} placeholder="East tunnel survey" autoFocus onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        <span className="k">Description</span>
        <textarea rows={4} value={desc} placeholder="What this session is for. Sage and Claude read this in every chat in it."
          onChange={(e) => setDesc(e.target.value)} />
      </label>
      <div className="form-actions">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn primary" disabled={!title.trim()}>{session ? 'Save' : 'Create session'}</button>
      </div>
    </form>
  );
}

// the ⋯ beside New chat. Closes on a pick, an outside click or Esc, and plays its
// exit before unmounting like the prompt bar's menus.
const MENU_EXIT_MS = 140;
function More({ items }) {
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const root = useRef(null);
  const close = () => {
    setLeaving(true);
    setTimeout(() => { setOpen(false); setLeaving(false); }, MENU_EXIT_MS);
  };
  useEffect(() => {
    if (!open || leaving) return undefined;
    const down = (e) => { if (!root.current?.contains(e.target)) close(); };
    const key = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key); };
  }, [open, leaving]);
  return (
    <div className="more" ref={root}>
      <button type="button" className="btn icon" aria-label="More" aria-haspopup="menu" aria-expanded={open}
        data-on={open ? '' : undefined} onClick={() => (open ? close() : setOpen(true))}>⋯</button>
      {open ? (
        <div className="more-menu" role="menu" data-closing={leaving ? '' : undefined}>
          {items.filter(Boolean).map((it) => (
            <button key={it.label} type="button" role="menuitem" className={it.danger ? 'danger' : ''}
              onClick={() => { close(); it.run(); }}>{it.label}</button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Sage's spoken replies: off, Edge neural voices (always there) or Deepgram (when the server has a key)
const VOICES = [['off', 'Voice off'], ['edge', 'Edge voice'], ['deepgram', 'Deepgram voice']];
function VoiceSel({ voice, deepgram, onChange }) {
  return (
    <select className="voice-sel" value={voice} aria-label="Sage's voice" title="Read Sage's replies aloud"
      onChange={(e) => onChange(e.target.value)}>
      {VOICES.filter(([k]) => k !== 'deepgram' || deepgram || voice === k).map(([k, n]) => <option key={k} value={k}>{n}</option>)}
    </select>
  );
}

function Sage() {
  const [missions, setMissions] = useState([]);
  const [voice, setVoice] = useState(() => kept('sageVoice') || 'off');
  const [deepgram, setDeepgram] = useState(false);
  const audio = useRef(null);
  // view: 'home' | 'temp' (temporary chat) | 'new' (session form) | 'session' (its folder) | 'chat' (a session's chat)
  // only 'temp' and 'chat' are chats, and only they get the prompt bar
  const [view, setView] = useState('home');
  const [mid, setMid] = useState('');
  const [cid, setCid] = useState('');
  const [temp, setTemp] = useState([]);
  const [busy, setBusy] = useState(null);   // { by, key } of the turn in flight
  // the prompt bar unmounts outside a chat, so the picks live here and seed it back
  const [who, setWho] = useState(() => kept('sageModel') || 'sage');
  const [effort, setEffort] = useState(() => kept('sageEffort'));
  const [editing, setEditing] = useState(false);   // the open session's title/description form
  const ctl = useRef(null);
  const tempSession = useRef(null);   // claude --resume for the temporary chat
  const list = useRef(null);

  // ---- load + write back ----
  // Every change writes its whole session back, one request at a time so two quick
  // edits can't land out of order.
  const saved = useRef({});
  const chain = useRef(Promise.resolve());
  const queue = (fn) => { chain.current = chain.current.then(fn).catch((e) => console.error('sessions:', e.message)); };
  useEffect(() => {
    fetch('/api/missions').then((r) => (r.ok ? r.json() : [])).then((ms) => {
      for (const m of ms) saved.current[m.id] = m;
      saved.current.loaded = true;
      setMissions(ms);
    }).catch((e) => console.error('sessions:', e.message));
    try { ['sageChat', 'activeMission', 'activeChat'].forEach((k) => localStorage.removeItem(k)); } catch {}   // old keys
  }, []);
  useEffect(() => {
    if (!saved.current.loaded) return;
    for (const m of missions) {
      if (saved.current[m.id] === m) continue;
      saved.current[m.id] = m;
      queue(() => fetch(`/api/missions/${m.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(m)
      }));
    }
  }, [missions]);
  useEffect(() => { keep('sageModel', who); keep('sageEffort', effort); }, [who, effort]);

  const mission = missions.find((m) => m.id === mid) || null;
  const chat = mission?.chats.find((c) => c.id === cid) || null;
  // a session or chat deleted out from under the view falls back home
  const at = (view === 'session' && !mission) || (view === 'chat' && !chat) ? 'home' : view;
  const inChat = at === 'temp' || at === 'chat';
  const messages = at === 'temp' ? temp : chat?.messages || [];
  const chatKey = at === 'temp' ? TEMP : cid;

  // updates go by id, so a reply lands in its own chat even if the operator moved on
  const patchMission = (id, fn) => setMissions((ms) => ms.map((m) => (m.id === id ? { ...m, ...fn(m) } : m)));
  const patchChat = (m, c, fn) => patchMission(m, (x) => ({ chats: x.chats.map((y) => (y.id === c ? { ...y, ...fn(y) } : y)) }));
  const push = (t, msg) => (t.key === TEMP ? setTemp((xs) => [...xs, msg]) : patchChat(t.m, t.key, (y) => ({ messages: [...y.messages, msg] })));

  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [messages.length, busy, chatKey, at]);

  // ---- voice ----
  useEffect(() => {
    fetch('/api/tts/providers').then((r) => r.json()).then((p) => setDeepgram(!!p.deepgram)).catch(() => {});
  }, []);
  const hush = () => { audio.current?.pause(); audio.current = null; };
  const pickVoice = (v) => { hush(); setVoice(v); keep('sageVoice', v === 'off' ? '' : v); };
  const speak = (text) => {
    hush();
    if (voice === 'off' || !text) return;
    const es = kept('lang') === 'es';
    const q = new URLSearchParams({ text, provider: voice, ...(es ? { voice: 'es-ES-AlvaroNeural' } : {}) });
    audio.current = new Audio(`/api/tts?${q}`);
    audio.current.play().catch(() => {});   // autoplay can refuse before the first click; the reply is still on screen
  };

  // ---- talking ----
  const ask = async (path, body, by, t) => {
    hush();
    setBusy({ by, key: t.key });
    ctl.current = new AbortController();
    try {
      const r = await fetch(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: ctl.current.signal
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.status);
      const reply = d.reply || {};
      push(t, { role: 'assistant', by, content: reply.text || d.text || '(no reply)' });
      speak(reply.text || d.text);
      if (d.session) {
        if (t.key === TEMP) tempSession.current = d.session;
        else patchChat(t.m, t.key, () => ({ claudeSession: d.session }));
      }
      // notes and findings only have somewhere to live inside a session
      if (t.key !== TEMP && reply.remember) {
        patchMission(t.m, (x) => ({ memory: [...(x.memory || []).filter((n) => n !== reply.remember), reply.remember].slice(-40) }));
      }
      if (t.key !== TEMP && reply.finding) {
        patchChat(t.m, t.key, (y) => ({ findings: [...(y.findings || []), { id: Date.now(), text: reply.finding, kind: 'find', time: new Date().toLocaleTimeString() }].slice(-40) }));
      }
    } catch (e) {
      push(t, { role: 'assistant', by, err: true, content: e.name === 'AbortError' ? 'stopped' : String(e.message || e) });
    }
    setBusy(null);
  };

  const send = (text, { model, effort: level }) => {
    const t = at === 'temp' ? { key: TEMP } : { m: mission.id, key: chat.id };
    const history = at === 'temp' ? temp : chat.messages;
    if (text === '/clear') {
      if (t.key === TEMP) { setTemp([]); tempSession.current = null; }
      else patchChat(t.m, t.key, () => ({ messages: [], claudeSession: null }));
      return;
    }
    if (text === '/scan') return ask('/api/scan', {}, 'sage', t);
    const next = [...history.filter((x) => !x.err), { role: 'user', content: text }];
    push(t, next[next.length - 1]);
    if (t.key !== TEMP && !chat.messages.length) patchChat(t.m, t.key, () => ({ title: clip(text, 30) }));
    const folder = t.key === TEMP ? {} : { mission: t.m, chat: t.key };
    if (model.key !== 'sage') {
      const session = t.key === TEMP ? tempSession.current : chat.claudeSession || null;
      return ask('/api/claude', { text, session, lang: kept('lang') || 'en', model: model.key, effort: level.toLowerCase(), ...folder }, 'claude', t);
    }
    // moves:false -- nothing in this dashboard runs her drive/arm/tape cards yet, so
    // the server tells her she's parked instead of her promising moves that never happen
    return ask('/api/chat', {
      messages: next.filter((x) => x.by !== 'claude').map(({ role, content }) => ({ role, content })),
      lang: kept('lang') || 'en', moves: false, effort: level === 'Standard' ? null : level.toLowerCase(), ...folder
    }, 'sage', t);
  };

  // ---- navigation + session actions ----
  const go = (v, m = mid, c = '') => { setMid(m); setCid(c); setView(v); setEditing(false); };
  const openTemp = () => {   // a temporary chat starts clean every time it's opened from home
    setTemp([]);
    tempSession.current = null;
    go('temp', '');
  };
  const create = (title, brief) => {
    const m = { id: `m${Date.now()}`, title, brief, memory: [], created: Date.now(), chats: [] };
    setMissions((ms) => [...ms, m]);
    go('session', m.id);
  };
  const startChat = () => {
    const n = newChat('New chat');
    patchMission(mission.id, (x) => ({ chats: [...x.chats, n] }));
    go('chat', mission.id, n.id);
  };
  const back = () => {
    if (at === 'temp' && temp.length && !confirm("Leave the temporary chat? It isn't saved.")) return;
    if (at === 'chat') go('session');
    else go('home', '');
  };
  const delMission = (m) => {
    if (!confirm(`Delete session "${m.title}" and its ${plural(m.chats.length, 'chat')}?`)) return;
    setMissions((ms) => ms.filter((x) => x.id !== m.id));
    delete saved.current[m.id];
    queue(() => fetch(`/api/missions/${m.id}`, { method: 'DELETE' }));
    if (mid === m.id) go('home', '');
  };
  const delChat = (c) => {
    if (!confirm(`Delete chat "${c.title}"?`)) return;
    patchMission(mission.id, (x) => ({ chats: x.chats.filter((y) => y.id !== c.id) }));
  };
  const clearNotes = () => {
    if (confirm(`Clear all ${plural(mission.memory.length, 'note')} Sage kept in "${mission.title}"?`)) patchMission(mission.id, () => ({ memory: [] }));
  };
  const forget = (note) => patchMission(mission.id, (x) => ({ memory: (x.memory || []).filter((n) => n !== note) }));

  const efforts = who === 'sage' ? SAGE_EFFORTS : CLAUDE_EFFORTS;   // [0] is each list's default
  const finds = mission ? mission.chats.flatMap((c) => c.findings || []).slice(-15) : [];
  const nav = {
    temp: ['Temporary chat', 'not saved'],
    new: ['New session', ''],
    session: [mission?.title, plural(mission?.chats.length || 0, 'chat')],
    chat: [chat?.title, mission?.title]
  }[at];

  return (
    <>
      {nav ? (
        <nav className="crumbs" aria-label="Sage">
          <button type="button" className="crumb-back" aria-label={at === 'chat' ? `Back to ${mission.title}` : 'Back'} onClick={back}>←</button>
          <span className="crumb-text">
            <span className="crumb-title">{nav[0]}</span>
            {nav[1] ? <span className="crumb-sub">{nav[1]}</span> : null}
          </span>
          {inChat ? <VoiceSel voice={voice} deepgram={deepgram} onChange={pickVoice} /> : null}
        </nav>
      ) : null}

      {at === 'home' ? (
        <div className="folder home" key="home">
          <div className="start">
            <span className="ascii-face big">^_^</span>
            <button type="button" className="btn primary" onClick={() => go('new', '')}>New session</button>
            <button type="button" className="btn" onClick={openTemp}>Temporary chat</button>
            <span className="k">A temporary chat isn't saved. A session keeps its chats, notes and findings, and every chat in it can see the rest.</span>
          </div>
          {missions.length ? (
            <>
              <h3 className="k">Sessions</h3>
              <ul className="rows">
                {missions.map((m) => (
                  <li key={m.id}>
                    <button type="button" className="row" onClick={() => go('session', m.id)}>
                      <span className="row-t">{m.title}</span>
                      <span className="k">{plural(m.chats.length, 'chat')}</span>
                    </button>
                    <button type="button" className="row-del" aria-label={`Delete ${m.title}`} onClick={() => delMission(m)}>×</button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : at === 'new' ? (
        <div className="folder" key="new">
          <SessionForm onSubmit={create} onCancel={() => go('home', '')} />
        </div>
      ) : at === 'session' ? (
        <div className="folder" key={`s${mission.id}`}>
          {editing ? (
            <SessionForm session={mission} onCancel={() => setEditing(false)}
              onSubmit={(title, brief) => { patchMission(mission.id, () => ({ title, brief })); setEditing(false); }} />
          ) : (
            <div className="folder-actions">
              <button type="button" className="btn primary" onClick={startChat}>+ New chat</button>
              <More items={[
                { label: 'Edit title & description', run: () => setEditing(true) },
                (mission.memory || []).length ? { label: "Clear Sage's notes", run: clearNotes } : null,
                { label: 'Delete session', danger: true, run: () => delMission(mission) }
              ]} />
            </div>
          )}
          {mission.chats.length ? (
            <>
              <h3 className="k">Chats</h3>
              <ul className="rows">
                {mission.chats.map((c) => (
                  <li key={c.id}>
                    <button type="button" className="row" onClick={() => go('chat', mission.id, c.id)}>
                      <span className="row-t">{c.title}</span>
                      <span className="k">{plural(c.messages.length, 'msg')}</span>
                    </button>
                    <button type="button" className="row-del" aria-label={`Delete ${c.title}`} onClick={() => delChat(c)}>×</button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {(mission.memory || []).length ? (
            <>
              <h3 className="k">Sage's notes</h3>
              <ul className="notes">
                {mission.memory.map((n) => (
                  <li key={n}>
                    <span>{n}</span>
                    <button type="button" className="row-del" aria-label="Forget" title="Forget" onClick={() => forget(n)}>×</button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {finds.length ? (
            <>
              <h3 className="k">Found</h3>
              <ul className="notes">{finds.map((f) => <li key={f.id}><span>{f.text}</span></li>)}</ul>
            </>
          ) : null}
        </div>
      ) : (
        <ol id="chat" ref={list} aria-live="polite" key={chatKey}>
          {messages.length === 0 && busy?.key !== chatKey ? (
            <li className="start">
              <span className="ascii-face big">^_^</span>
              <span className="k">
                {at === 'temp' ? "Temporary chat. Nothing here is saved." : `New chat in ${mission.title}. Sage and Claude can see the whole session.`}
              </span>
            </li>
          ) : null}
          {messages.map((x, i) => (
            <li key={i} className={x.role === 'user' ? 'user' : x.err ? 'sage err' : 'sage'} data-by={x.by || 'sage'}>{x.content}</li>
          ))}
          {busy?.key === chatKey ? (
            <li className="sage thinking" data-by={busy.by}>{busy.by === 'claude' ? 'working — Claude can take a while…' : '…'}</li>
          ) : null}
        </ol>
      )}

      {inChat ? (
        <div className="pb">
          <PromptBar
            placeholder={who === 'sage' ? 'Ask Sage' : 'Ask Claude'}
            background="var(--bar)"
            color="var(--bar-ink)"
            menuBackground="var(--bar-menu)"
            sources={SOURCES}
            commands={COMMANDS}
            models={MODELS}
            defaultModel={who}
            onModelChange={(x) => {
              // Sage and Claude have different effort lists: crossing over starts at the new list's default
              if ((x.key === 'sage') !== (who === 'sage')) setEffort('');
              setWho(x.key);
            }}
            efforts={efforts}
            defaultEffort={efforts.includes(effort) ? effort : efforts[0]}
            onEffortChange={setEffort}
            sparkFrom={efforts.indexOf(who === 'sage' ? 'Low' : 'Medium')}
            effortHelp={who === 'sage'
              ? 'Standard answers in about a second. Low to High let Sage think first: better on hard questions, a few seconds slower each step.'
              : 'How long Claude thinks before answering. Higher is smarter on hard jobs but slower and uses more of the plan.'}
            busy={!!busy}
            onSend={send}
            onStop={() => {
              ctl.current?.abort();
              hush();
              if (busy?.by === 'claude') fetch('/api/claude/stop', { method: 'POST' }).catch(() => {});
            }}
            width={4000}
          />
        </div>
      ) : null}
    </>
  );
}

createRoot(document.getElementById('sage-root')).render(<Sage />);
