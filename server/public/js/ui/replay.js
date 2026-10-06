import { useCallback, useEffect, useState } from "react";
import { html } from "./core.js";
import { FpvOverlay, FpvSage } from "./fpv.js";

// ---- replay ----
const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String((s / 60) | 0).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

function at(list, t) {
  let hit = list[0];
  for (const x of list) { if (x.t > t) break; hit = x; }
  return hit;
}

function before(list, t) {
  let hit = null;
  for (const x of list) { if (x.t > t) break; hit = x; }
  return hit;
}

const EVENT_META = {
  finding:  { label: "FINDING DETECTED", glyph: "◆", cls: "k-find" },
  analysis: { label: "ANALYSIS",         glyph: "◎", cls: "k-analysis" },
  sage:     { label: "SAGE",             glyph: "◈", cls: "k-sage" },
  blk:      { label: "BLK DECISION",     glyph: "▣", cls: "k-blk" },
  camlost:  { label: "CAMERA DEAD",      glyph: "◉", cls: "k-dead" },
  camback:  { label: "CAMERA BACK",      glyph: "◉", cls: "k-back" },
};
const SAID = ["sage", "analysis", "finding"];
const BANNER_MS = 4000;

function Replay({ run, onClose }) {
  const [t, setT] = useState(0);
  const [play, setPlay] = useState(true);
  const events = (run.events || []).filter(e => EVENT_META[e.kind]);
  const ended = t >= run.dur;
  useEffect(() => {
    if (!play) return;
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const dt = now - last; last = now;
      setT(v => {
        if (v + dt >= run.dur) { setPlay(false); return run.dur; }
        return v + dt;
      });
    }, 60);
    return () => clearInterval(id);
  }, [play, run]);
  const seek = useCallback((ms) => { setPlay(false); setT(Math.max(0, Math.min(run.dur, ms))); }, [run.dur]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") return onClose();
      if (e.target?.classList?.contains("rep-scrub")) return;
      if (e.key === " ") { e.preventDefault(); setPlay(p => !p); }
      if (e.key === "ArrowRight") setT(v => Math.min(run.dur, v + 5000));
      if (e.key === "ArrowLeft") setT(v => Math.max(0, v - 5000));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, run.dur]);

  const frame = at(run.frames, t);
  const packet = at(run.packets, t);
  const now = before(events, t);
  const banner = now && t - now.t < BANNER_MS ? now : null;
  const said = before(events.filter(e => SAID.includes(e.kind)), t);
  const dead = before(events.filter(e => e.kind === "camlost" || e.kind === "camback"), t)?.kind === "camlost";

  const ai = { text: said?.text || "—", status: null, analyzing: false };

  return html`
    <div class="rep">
      ${frame
        ? html`<img class=${"rep-img" + (dead ? " is-stale" : "")} src=${`/recordings/${run.id}/${frame.f}`} alt="" />`
        : html`<p class="rep-blind">no video — cam was down for this run</p>`}
      <${FpvOverlay} packet=${packet} />
      <${FpvSage} ai=${ai} packet=${packet} speaking=${false} connected=${true} />

      <p class="rep-badge">REPLAY · ${run.name}</p>
      ${dead && html`<p class="rep-dead">◉ CAMERA DEAD — no video from here</p>`}
      ${banner && html`
        <p class=${"rep-event " + EVENT_META[banner.kind].cls} key=${banner.t}>
          <b>${EVENT_META[banner.kind].glyph} ${EVENT_META[banner.kind].label}</b>
          <span>${banner.text}</span>
        </p>`}

      <div class="rep-bar">
        <button type="button" class="hud-btn" onClick=${() => { if (ended) setT(0); setPlay(p => ended || !p); }}
          aria-label=${ended ? "restart" : play ? "pause" : "play"}>${ended ? "↻" : play ? "❚❚" : "▶"}</button>
        <div class="rep-track">
          <input class="rep-scrub" type="range" min="0" max=${run.dur} step="100" value=${Math.round(t)}
            aria-label="scrub" onInput=${(e) => seek(+e.target.value)} />
          <div class="rep-ticks">
            ${events.map(e => html`
              <button type="button" key=${e.t + e.kind} class=${"rep-tick " + EVENT_META[e.kind].cls}
                style=${{ left: (e.t / run.dur) * 100 + "%" }} onClick=${() => seek(e.t)}
                title=${`${clock(e.t)} · ${EVENT_META[e.kind].label} — ${e.text}`}
                aria-label=${`${EVENT_META[e.kind].label} at ${clock(e.t)}`}></button>`)}
          </div>
        </div>
        <span class="rep-t">${clock(t)} / ${clock(run.dur)}</span>
        <button type="button" class="hud-btn" onClick=${onClose}>✕ ESC</button>
      </div>
    </div>`;
}

function ReplayList({ runs, onPick, onDelete, onClose }) {
  return html`
    <div class="blk-modal" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="blk-modal-frame rep-list-frame">
        <div class="blk-modal-head">
          <span class="label">MISSION REPLAYS</span>
          <button type="button" class="blk-modal-x" onClick=${onClose}>✕</button>
        </div>
        <div class="rep-list">
          ${!runs.length && html`<p class="report-empty">no recordings yet — hit ● REC on the camera</p>`}
          ${runs.map(r => html`
            <div class="rep-row" key=${r.id}>
              <button type="button" class="rep-open" onClick=${() => onPick(r.id)}>
                <b>${r.name}</b>
                <small>${new Date(r.at).toLocaleString()} · ${clock(r.dur)} · ${r.frames} frames · ${r.packets} pkt${r.events ? ` · ${r.events} events` : ""}</small>
              </button>
              <button type="button" class="serial-btn" onClick=${() => onDelete(r.id)}>DELETE</button>
            </div>`)}
        </div>
      </div>
    </div>`;
}

export { Replay, ReplayList };
