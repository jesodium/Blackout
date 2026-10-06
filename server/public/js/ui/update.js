import { useEffect, useRef } from "react";
import { t } from "../i18n.js";
import { SageFace } from "../sageface.js";
import { html } from "./core.js";

// ---- firmware update ----
const roverModel = (b) => b.giga ? "Blackout V3" : b.unor4 ? "Blackout V2" : "Blackout";
const anyBoard = (b) => !!(b.giga || b.unor4 || b.esp32cam);

function UpdateBar({ boards, onUpdate }) {
  const stale = boards.status !== "current";
  return html`
    <div class=${"update-bar" + (stale ? " is-stale" : "")} role="status">
      <span class="lamp-dot ${stale ? "is-abort" : "is-go"}" aria-hidden="true"></span>
      <span class="update-bar-msg">
        ${t("update.connected", { model: roverModel(boards) })} · ${t("update.st." + boards.status)}
      </span>
      <button type="button" class="serial-btn" onClick=${onUpdate}>${t("update.button")}</button>
    </div>`;
}

const FLASH_TICKS_PER_BOARD = 2;
function flashProgress(log, boards, phase) {
  const heads = [...log.matchAll(/^▸ (.+?) @ /gm)].map(m => m[1]);
  const ticks = (log.match(/✔/g) || []).length;
  const planned = ["giga", "unor4", "esp32cam"].filter(k => boards[k]).length;
  const total = Math.max(planned, heads.length, 1) * FLASH_TICKS_PER_BOARD;
  const board = heads[heads.length - 1] || null;
  const step = !board ? "prep" : ticks % 2 === 0 ? "compile" : "upload";

  return { pct: phase === "done" ? 100 : Math.min(99, Math.round((ticks / total) * 100)), board, step };
}

const FLASH_MOOD = { work: "work", ok: "clear", error: "alert" };
function FlashProgress({ log, boards, phase, code }) {
  const { pct, board, step } = flashProgress(log, boards, phase);
  const state = phase !== "done" ? "work" : code === 0 ? "ok" : "error";
  const label = step === "prep" ? t("update.prep")
    : t(step === "compile" ? "update.compiling" : "update.uploading", { board });
  return html`
    <div class=${"flash-prog is-" + state}>
      <${SageFace} mood=${FLASH_MOOD[state]} />
      <div class="flash-bar" role="progressbar" aria-valuenow=${pct} aria-valuemin="0" aria-valuemax="100"
        aria-label=${t("update.title")}>
        <div class="flash-bar-fill" style=${{ width: pct + "%" }}></div>
      </div>
      <div class="flash-prog-line">
        <span>${phase === "done" ? (code === 0 ? t("update.done") : t("update.error")) : label}</span>
        <span class="flash-pct">${pct}%</span>
      </div>
    </div>`;
}

function UpdateModal({ open, phase, boards, log, code, onFlash, onClose }) {
  const logRef = useRef(null);
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [log]);
  const locked = phase === "flashing";
  const board = (label, ok, note) => html`
    <div class=${"flash-board " + (ok ? "is-ok" : "is-missing")}>
      ${label}<small>${ok ? (note || t("update.detected")) : t("update.notDetected")}</small>
    </div>`;
  return html`
    <div class=${"blk-modal" + (open === "closing" ? " is-closing" : "")}
      onClick=${(e) => { if (e.target === e.currentTarget && !locked) onClose(); }}>
      <div class="blk-modal-frame update-frame" role="dialog" aria-label=${t("update.title")}>
        <span class="update-title">${t("update.title")}</span>
        ${phase === "detect" && html`
          <p>${anyBoard(boards) ? t("update.st." + boards.status) : t("update.plugin")}</p>
          <div class="flash-boards">
            ${board(t("update.esp32cam"), boards.esp32cam,
              boards.esp32cam > 1 ? t("update.detectedN", { n: boards.esp32cam }) : null)}
            ${board(t("update.mainboard"), boards.giga || boards.unor4,
              boards.giga ? "Giga R1 · V3" : boards.unor4 ? "Uno R4 · V2" : null)}
          </div>`}
        ${(phase === "flashing" || phase === "done") && html`
          <${FlashProgress} log=${log} boards=${boards} phase=${phase} code=${code} />
          <div class="flash-log" role="log" ref=${logRef}>${log || "…"}</div>`}
        ${phase === "flashing" && html`<p>${t("update.flashing")}</p>`}
        ${phase === "done" && html`
          <p class=${"flash-status " + (code === 0 ? "is-ok" : "is-error")}>
            ${code === 0 ? t("update.done") : t("update.error")}
          </p>`}
        ${!locked && html`
          <div class="update-actions">
            ${phase === "detect" && html`
              <button type="button" class="serial-btn" disabled=${!anyBoard(boards)}
                onClick=${onFlash}>${t("update.flashNow")}</button>`}
            <button type="button" class="serial-btn" onClick=${onClose}>${t("update.close")}</button>
          </div>`}
      </div>
    </div>`;
}

export { UpdateBar, UpdateModal };
