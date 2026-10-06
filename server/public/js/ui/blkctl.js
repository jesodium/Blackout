import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { compile as blkCompile, estimate as blkEstimate, lint as blkLint, parse as blkParse, fmtMs } from "../blk.mjs";
import { blkCancel, playBlk } from "../control.js";
import { Icon, html } from "./core.js";

function BlkCtl({ onCmd, onAnalyze, enabled, busyRef, packetRef }) {
  const [files, setFiles] = useState([]);
  const [sel, setSel] = useState(() => localStorage.getItem("blkSel") || "");
  const [run, setRun] = useState(null);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);
  const [preview, setPreview] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const runRef = useRef(false);
  runRef.current = !!run;

  const closeEditor = useCallback(() => {
    setEditorOpen(o => o === "open" ? "closing" : o);
    setTimeout(() => setEditorOpen(false), 240);
  }, []);

  useEffect(() => {
    const fn = (e) => {
      if (e.data === "blk:close") return closeEditor();
      if (e.data?.type === "blk:run" && e.data.name) {
        pick(e.data.name);
        closeEditor();
        setTimeout(() => startRef.current(e.data.name), 320);
      }
    };
    window.addEventListener("message", fn);
    return () => window.removeEventListener("message", fn);
  }, [closeEditor]);

  const loadFiles = useCallback(() => {
    fetch("/api/blk").then(r => r.json()).then(d => setFiles(d.files || [])).catch(() => {});
  }, []);

  useEffect(() => {
    loadFiles();
    const bc = new BroadcastChannel("blk");
    bc.onmessage = loadFiles;
    window.addEventListener("focus", loadFiles);
    return () => { bc.close(); window.removeEventListener("focus", loadFiles); };
  }, [loadFiles]);

  useEffect(() => {
    if (!sel) { setPreview(null); return; }
    let live = true;
    fetch("/api/blk/" + encodeURIComponent(sel))
      .then(r => r.ok ? r.text() : Promise.reject())
      .then(text => {
        if (!live) return;
        const { program, errors } = blkParse(text);

        let board;
        try { board = blkCompile(program).code.length; } catch (e) { board = e.message; }
        setPreview({ text, warns: errors.length ? errors : blkLint(program), ms: fmtMs(blkEstimate(program)), board });
      })
      .catch(() => live && setPreview(null));
    return () => { live = false; };
  }, [sel]);

  useEffect(() => () => { blkCancel(); if (runRef.current) onCmd("stop"); }, [onCmd]);

  const start = async (name = sel) => {
    if (!name || run) return;
    setErr(null);
    setNote(null);
    let text;
    try {
      const r = await fetch("/api/blk/" + encodeURIComponent(name));
      if (!r.ok) throw new Error("not found");
      text = await r.text();
    } catch { setErr("couldn't load workflow"); return; }
    const { program, errors } = blkParse(text);
    if (errors.length) { setErr(errors[0]); return; }
    if (!program.length) { setErr("workflow is empty"); return; }
    setRun({ n: 0, label: "start" });
    const { cancelled } = await playBlk(program, {
      onCmd, onAnalyze, busyRef, packetRef, onNote: setNote,
      onProgress: (p) => setRun(p),
    });
    if (!cancelled) setRun(null);
  };

  const startRef = useRef(start);
  startRef.current = start;

  const stop = () => { blkCancel(); setRun(null); onCmd("stop"); };
  const pick = (v) => { setSel(v); localStorage.setItem("blkSel", v); };

  return html`
    <div class="blk-ctl">
      <div class="blk-ctl-row">
        <select class="port-select blk-ctl-sel" value=${sel} onChange=${e => pick(e.target.value)} disabled=${!!run}>
          <option value="">${files.length ? "— pick workflow —" : "no workflows yet"}</option>
          ${files.map(f => html`<option key=${f} value=${f}>${f}</option>`)}
        </select>
        <button type="button" class="btn btn--ghost" title="reload list" onClick=${loadFiles}>⟳</button>
        <button type="button" class="btn btn--ghost" onClick=${() => setEditorOpen("open")}>EDITOR</button>
      </div>
      ${run
        ? html`<button type="button" class="btn blk-stop" onClick=${stop}>■ STOP — ${run.board ? "on board · " : ""}step ${run.n} · ${run.label.toUpperCase()}</button>`
        : html`<button type="button" class="btn btn--primary" disabled=${!enabled || !sel} onClick=${() => start()}>▶ RUN WORKFLOW</button>`}
      ${preview && !run && html`
        <details class="blk-prev">
          <summary>${preview.text.split("\n").filter(l => l.trim()).length} lines · ~${preview.ms} per pass${preview.warns.length ? ` · ${preview.warns.length} warning${preview.warns.length === 1 ? "" : "s"}` : ""}</summary>
          <div class="blk-where">${typeof preview.board === "number"
            ? `runs on the board — ${preview.board} instructions uploaded first`
            : `runs in the browser — ${preview.board}`}</div>
          <pre>${preview.text}</pre>
          ${preview.warns.map(w => html`<div class="blk-warn" key=${w}><${Icon} n="warn" /> ${w}</div>`)}
        </details>`}
      ${run && Object.keys(run.vars || {}).length > 0 && html`
        <small style=${{ opacity: 0.75, fontFamily: "var(--mono)" }}>
          ${Object.entries(run.vars).map(([k, v]) => `${k}=${Math.round(v * 100) / 100}`).join("  ·  ")}
        </small>`}
      <small style=${{ opacity: 0.7 }}>
        ${err ? html`<span style=${{ color: "var(--accent)" }}>${err}</span>`
          : note ? html`<span style=${{ color: "var(--ink-2)" }}>${note}</span>`
          : !enabled ? "BT bridge off — connect to run."
          : run ? "Running — STOP or switching mode halts the rover. Forever loops run until stopped."
          : "Author programs in the EDITOR (blocks or text), save, run here."}
      </small>
      ${editorOpen && createPortal(html`
        <div class=${"blk-modal" + (editorOpen === "closing" ? " is-closing" : "")}
          onClick=${(e) => { if (e.target === e.currentTarget) closeEditor(); }}>
          <div class="blk-modal-frame">
            <div class="blk-modal-head">
              <span class="label">BLK · Workflow Editor</span>
              <button type="button" class="blk-modal-x" onClick=${closeEditor} aria-label="Close editor">✕</button>
            </div>
            <iframe src="blk.html" title="BLK workflow editor"></iframe>
          </div>
        </div>`, document.body)}
    </div>`;
}

export { BlkCtl };
