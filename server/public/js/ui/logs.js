import { useEffect, useRef, useState } from "react";
import { t } from "../i18n.js";
import { html } from "./core.js";
import { Head } from "./panels.js";

// ---- logs ----
function Logs({ logs }) {
  const [f, setF] = useState("all");
  const tabs = [["all", t("log.tabAll")], ["system", t("log.tabSystem")], ["alerts", t("log.tabAlerts")], ["ai", t("log.tabAi")]];
  const view = logs.filter(l => f === "all" ? true : f === "alerts" ? (l.type === "warn" || l.type === "danger") : l.type === f);
  return html`
    <section class="zone logs" aria-labelledby="log-h">
      <${Head} title=${t("zone.logs")} tag=${t("log.ev", { n: logs.length })} />
      <div class="zone-body">
        <div class="log-tabs" role="tablist">
          ${tabs.map(([k, lbl]) => html`<button key=${k} type="button" role="tab" aria-selected=${f === k}
            class=${"log-tab" + (f === k ? " is-active" : "")} onClick=${() => setF(k)}>${lbl}</button>`)}
        </div>
        <div class="log-stream" role="log" aria-live="polite">
          ${view.map(l => html`<div key=${l.id} class=${"log-line k-" + l.type}>
            <span class="t">${l.time}</span><span class="m">${l.text}</span></div>`)}
        </div>
      </div>
    </section>`;
}

function SerialMonitor({ lines, onClear }) {
  const [paused, setPaused] = useState(false);
  const streamRef = useRef(null);

  useEffect(() => {
    if (paused) return;
    const el = streamRef.current; if (el) el.scrollTop = el.scrollHeight;
  }, [lines, paused]);
  return html`
    <section class="zone serial" aria-labelledby="ser-h">
      <${Head} title=${t("zone.serial")}>
        <div class="serial-tools">
          <span class="tag">${lines.length}</span>
          <button type="button" class="serial-btn" onClick=${() => setPaused(p => !p)}
            aria-pressed=${paused}>${paused ? t("serial.resume") : t("serial.pause")}</button>
          <button type="button" class="serial-btn" onClick=${onClear}>${t("serial.clear")}</button>
        </div>
      <//>
      <div class="serial-stream" role="log" aria-live="off" ref=${streamRef}>
        ${lines.length === 0
          ? html`<div class="serial-empty">${t("serial.empty")}</div>`
          : lines.map(l => html`<div key=${l.id} class=${"serial-line" + (l.s ? " is-data" : "")}>
              <span class="t">${l.time}</span><span class="m">${l.text}</span></div>`)}
      </div>
    </section>`;
}

function appendLog(log, chunk) {
  return chunk.split(/(\r\n|\n|\r)/).reduce((acc, tok) => {
    if (tok === "\r") return acc.slice(0, acc.lastIndexOf("\n") + 1);
    if (tok === "\r\n") return acc + "\n";
    return acc + tok;
  }, log);
}

export { Logs, SerialMonitor, appendLog };
