import { t } from "../i18n.js";
import { html } from "./core.js";
import { Memory } from "./judge.js";
import { Logs, SerialMonitor } from "./logs.js";
import { MotorDebug } from "./panels.js";
import { Tapes } from "./tapes.js";
import { PipToggle, SAVERS, ZoomSlider } from "./topbar.js";

function Drawer({ open, tab, onTab, onClose, logs, serialLines, onClearSerial, chat, onCmd, onAnalyze, onNote, onSay, enabled }) {
  if (!open) return null;
  const tabs = [["logs", t("zone.logs")], ["findings", t("zone.analysis")], ["serial", t("zone.serial")], ["motor", t("colo.motor")], ["tapes", "Tapes"]];
  return html`
    <div class=${"drawer" + (open === "closing" ? " is-closing" : "")} role="region" aria-label=${t("drawer.console")}>
      <div class="drawer-bar">
        <div class="drawer-tabs" role="tablist">
          ${tabs.map(([k, lbl]) => html`<button key=${k} type="button" role="tab" aria-selected=${tab === k}
            class=${"drawer-tab" + (tab === k ? " is-active" : "")} onClick=${() => onTab(k)}>${lbl}</button>`)}
        </div>
        <button type="button" class="drawer-x" onClick=${onClose} aria-label="Close">✕</button>
      </div>
      <div class="drawer-body">
        ${tab === "logs" ? html`<${Logs} logs=${logs} />`
        : tab === "findings" ? html`<${Memory} chat=${chat} />`
        : tab === "serial" ? html`<${SerialMonitor} lines=${serialLines} onClear=${onClearSerial} />`
        : tab === "tapes" ? html`<${Tapes} onCmd=${onCmd} onAnalyze=${onAnalyze} onNote=${onNote} onSay=${onSay} enabled=${enabled} />`
        : html`<${MotorDebug} onCmd=${onCmd} enabled=${enabled} />`}
      </div>
    </div>`;
}

// the console is read-only now; every toggle it used to carry lives here, behind
// the topbar gear.
function Options({ open, onClose, enabled, saver, onSaver, moves, onMoves, lamp, onLamp, demo, onDemo, buzz, onBuzz }) {
  return html`
    <div class=${"blk-modal" + (open === "closing" ? " is-closing" : "")}
      onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="blk-modal-frame devices-frame settings-frame" role="dialog" aria-label=${t("options.title")}>
        <div class="blk-modal-head">
          <span class="label">${t("options.title")}</span>
          <button type="button" class="blk-modal-x" onClick=${onClose} aria-label=${t("update.close")}>✕</button>
        </div>
        <div class="options-body">
          <button type="button" class=${"serial-btn drawer-moves" + (moves ? " is-on" : "")}
            aria-pressed=${!!moves} onClick=${onMoves} title=${t("drawer.movesTitle")}>
            ${t("drawer.moves")}: ${t(moves ? "drawer.on" : "drawer.off")}
          </button>
          <button type="button" class=${"serial-btn drawer-lamp" + (lamp ? " is-on" : "")}
            aria-pressed=${!!lamp} onClick=${onLamp} title=${t("drawer.lampTitle")}>
            ${t("drawer.lamp")}: ${t(lamp ? "drawer.on" : "drawer.off")}
          </button>
          <button type="button" class=${"serial-btn drawer-demo" + (demo ? " is-on" : "")}
            aria-pressed=${!!demo} onClick=${onDemo} title=${t("drawer.demoTitle")}>
            ${t("drawer.demo")}: ${t(demo ? "drawer.on" : "drawer.off")}
          </button>
          <${PipToggle} />
          <${ZoomSlider} />
          <button type="button" class=${"serial-btn drawer-buzz" + (buzz ? " is-on" : "")}
            aria-pressed=${!!buzz} onClick=${onBuzz} title=${t("drawer.buzzTitle")}>
            ${t("drawer.buzz")}: ${t(buzz ? "drawer.on" : "drawer.off")}
          </button>
          <select class="serial-btn drawer-saver" disabled=${!enabled} value=${saver}
            onChange=${(e) => onSaver(Number(e.target.value))} title=${t("drawer.saverTitle")}
            aria-label=${t("drawer.saver")}>
            ${SAVERS.map((k, i) => html`<option key=${k} value=${i}>${i ? "▚ " : ""}${t("drawer." + k)}</option>`)}
          </select>
        </div>
      </div>
    </div>`;
}

export { Drawer, Options };
