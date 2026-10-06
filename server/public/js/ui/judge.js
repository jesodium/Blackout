import React from "react";
import { t } from "../i18n.js";
import { FeedLine } from "./agent.js";
import { CamView } from "./camera.js";
import { SENSORS, TRENDS, fmt, html, reads } from "./core.js";
import { Head, Reading, Trends } from "./panels.js";
import { assess } from "./verdict.js";

// ---- judge view ----
function SensorStrip({ packet }) {
  return html`
    <${React.Fragment}>
      <section class="strip reveal" aria-label=${t("zone.environment")}>
        ${SENSORS.map(s => html`<${Reading} key=${s.key} s=${s} value=${packet?.[s.key]} />`)}
      </section>
      <div class="reading trend-cell reveal" aria-label=${t("zone.trends")}>
        <div class="reading-head">
          <span class="reading-name">${t("zone.trends")}</span>
          <span class="legend">
            ${TRENDS.map(s => html`<span key=${s.key} class="legend-item"><i style=${{ background: s.color }}></i>${t(s.tkey)}</span>`)}
          </span>
        </div>
        <div class="trend-body"><${Trends} packet=${packet} /></div>
      </div>
    <//>`;
}

function JudgeView({ packet, connected, ai, feed }) {
  const v = assess(packet);
  return html`
    <main class="judge" id="sensors">
      <div class="judge-head">
        <span class=${"judge-verdict is-" + v.kind}>${v.label}</span>
        <span class="judge-cause">${v.cause}</span>
        <span class=${"pill " + (connected ? "is-go" : "is-abort")}>
          ${connected ? t("mast.linkLive") : t("mast.noSignal")}</span>
      </div>
      <div class="judge-body">
        <div class="judge-cam"><${CamView} /></div>
        <div class="judge-grid">
          ${SENSORS.map(s => {
            const val = packet?.[s.key], on = reads(s, val);
            return html`
              <div key=${s.key} class=${"judge-cell" + (on ? "" : " is-dead")}>
                <span class="judge-key">${t("sensor." + s.key)}</span>
                <span class="judge-val">${on ? fmt(val, s.d) : t("st.noRead")}
                  ${on && html`<i>${s.unit}</i>`}</span>
              </div>`;
          })}
        </div>
        ${feed?.length ? html`<div class="judge-chat">
          <span class="judge-key">${t("zone.agent")}</span>
          <div class="judge-chat-log" role="log" aria-live="polite">
            ${feed.slice().reverse().map(e => html`<${FeedLine} key=${e.id} e=${e} onAnswer=${() => {}} />`)}
          </div>
        </div>` : null}
      </div>
      ${ai.text && ai.text !== t("ai.awaiting") && html`<p class="judge-say">${ai.text}</p>`}
    </main>`;
}

function Memory({ chat }) {
  const findings = (chat?.findings || []).slice().reverse();
  const tag = !chat ? "—" : findings.length ? t("tag.found", { n: findings.length }) : t("tag.nominal");
  return html`
    <section class="zone memory" aria-labelledby="mem-h">
      <${Head} title=${t("zone.analysis")} tag=${tag} />
      <div class="memory-body">
        ${!chat
          ? html`<p class="memory-empty">${t("mem.noSession")}</p>`
          : findings.length === 0
          ? html`<p class="memory-empty">${t("mem.noFindings")}</p>`
          : findings.map(f => html`<div key=${f.id} class=${"memory-item is-" + f.kind}>
              <span class="memory-dot" aria-hidden="true"></span>
              <span class="memory-text">${f.text}</span>
              <span class="memory-time">${f.time}</span>
              ${f.img && html`<img class="memory-shot" src=${f.img} alt=${f.text} loading="lazy" />`}
            </div>`)}
      </div>
    </section>`;
}

export { JudgeView, Memory, SensorStrip };
