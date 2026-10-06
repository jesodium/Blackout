import { useEffect, useState } from "react";
import { TAPE_EVENTS, tapePlay, tapeRec, tapeStart, tapeStop } from "../control.js";
import { html } from "./core.js";

function Tapes({ onCmd, onAnalyze, onNote, onSay, enabled }) {
  const [files, setFiles] = useState([]);
  // Seeded from the module flag, not false: the drawer unmounts this whole
  // component when the console is closed (or another tab is picked), and the arm
  // pad is BEHIND the drawer — so recording a run means closing the console
  // mid-take. tapeRec lives outside the component and keeps recording; this is
  // what makes it come back reading ■ STOP + SAVE instead of wiping the take.
  const [rec, setRec] = useState(tapeRec.on);
  const [name, setName] = useState(tapeRec.on ? tapeRec.name : "");
  const [edit, setEdit] = useState(null);      // { name, text } — the raw json
  const [err, setErr] = useState("");
  const load = () => fetch("/api/tapes").then(r => r.json()).then(d => setFiles(d.files || [])).catch(() => {});
  useEffect(() => { load(); }, []);   // load() returns a promise; React calls an effect's return value as cleanup

  const save = async (n, steps) => {
    const r = await fetch(`/api/tapes/${encodeURIComponent(n)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ steps }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return void setErr(d.error || "save failed");
    setErr(""); load();
    return true;
  };

  const stop = async () => {
    const steps = tapeStop();
    setRec(false);
    if (!steps.length) return void setErr("nothing was sent — nothing to save");
    await save(name.trim() || "take", steps);
    setName("");
  };

  const open = async (n) => {
    const r = await fetch(`/api/tapes/${encodeURIComponent(n)}`);
    setEdit({ name: n, text: await r.text() });
    setErr("");
  };

  const saveEdit = async () => {
    let parsed;
    try { parsed = JSON.parse(edit.text); } catch (e) { return void setErr("bad json: " + e.message); }
    if (await save(edit.name, parsed.steps || parsed)) setEdit(null);
  };

  const del = async (n) => {
    if (!confirm(`Delete tape "${n}"?`)) return;
    await fetch(`/api/tapes/${encodeURIComponent(n)}`, { method: "DELETE" });
    if (edit?.name === n) setEdit(null);
    load();
  };

  return html`
    <div class="tapes">
      <div class="tapes-bar">
        <input class="tapes-name" placeholder="tape name" value=${name} disabled=${rec}
          onInput=${(e) => setName(e.target.value)} />
        <button type="button" class=${"btn" + (rec ? " is-rec" : "")} disabled=${!enabled && !rec}
          onClick=${() => (rec ? stop() : (tapeStart(name.trim()), setErr(""), setRec(true)))}>
          ${rec ? "■ STOP + SAVE" : "● RECORD"}
        </button>
        <span class="tapes-hint">${rec ? "recording every command — drive, arm, lights" : `add by hand: @sage <what to talk about — she writes the line> · ${TAPE_EVENTS.slice(1).map(e => "@" + e).join(" ")} · @say.es <texto> for a spoken line in another language`}</span>
      </div>
      ${err && html`<div class="tapes-err">${err}</div>`}
      <ul class="tapes-list">
        ${files.map(n => html`<li key=${n} class="tapes-row">
          <span class="tapes-row-name">${n}</span>
          <button type="button" class="serial-btn" disabled=${!enabled || rec}
            onClick=${async () => {
              const r = await fetch(`/api/tapes/${encodeURIComponent(n)}`);
              const d = await r.json().catch(() => null);
              if (d) tapePlay(d.steps || [], { onCmd, onAnalyze, onNote, onSay });
            }}>▶ PLAY</button>
          <button type="button" class="serial-btn" onClick=${() => open(n)}>EDIT</button>
          <button type="button" class="serial-btn" onClick=${() => del(n)}>✕</button>
        </li>`)}
      </ul>
      ${edit && html`<div class="tapes-edit">
        <textarea class="tapes-json" spellcheck="false" value=${edit.text}
          onInput=${(e) => setEdit({ ...edit, text: e.target.value })}></textarea>
        <div class="tapes-bar">
          <button type="button" class="btn" onClick=${saveEdit}>SAVE ${edit.name}</button>
          <button type="button" class="serial-btn" onClick=${() => setEdit(null)}>CLOSE</button>
        </div>
      </div>`}
    </div>`;
}

export { Tapes };
