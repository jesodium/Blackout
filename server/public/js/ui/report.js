import { t } from "../i18n.js";
import { Icon, SENSORS, html } from "./core.js";
import { assess } from "./verdict.js";

// ---- session report ----
function buildReport({ chat, packet, logs, ai, connected, ping, packets, uptime }) {
  const v = assess(packet);
  return {
    kind: "blackout.session-report",
    version: 1,
    generated: new Date().toISOString(),
    session: {
      id: chat?.id || null,
      title: chat?.title || null,
      mission: chat?.mission || null,
      started: chat?.created ? new Date(chat.created).toISOString() : null,
    },
    link: { connected, ping, packets, uptime },
    verdict: { kind: v.kind, label: v.label, cause: v.cause },
    environment: SENSORS.map(s => {
      const value = packet?.[s.key];
      const ok = value != null && !isNaN(value);
      const [lblKey, kind] = ok ? s.st(value) : [null, null];
      return { key: s.key, label: t("sensor." + s.key), value: ok ? Number(value) : null, unit: s.unit, status: lblKey ? t(lblKey) : null, kind };
    }),
    telemetry: packet || null,
    findings: (chat?.findings || []).map(f => ({ time: f.time, kind: f.kind, text: f.text, hasImage: !!f.img })),
    conversation: (chat?.messages || []).map(m => ({ role: m.role, content: m.content })),
    analysis: (ai?.history || []).map(h => ({ time: h.time, text: h.text })),
    events: logs.map(l => ({ time: l.time, type: l.type, text: l.text })),
  };
}

function downloadReport(rep) {
  const stamp = rep.generated.slice(0, 19).replace(/[:T]/g, "-");
  const slug = (rep.session.title || "session").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "session";

  if (window.blackout) {
    window.blackout.saveFile({
      defaultName: `blackout-${slug}-${stamp}.json`,
      data: JSON.stringify(rep, null, 2),
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    return;
  }
  const url = URL.createObjectURL(new Blob([JSON.stringify(rep, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `blackout-${slug}-${stamp}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ReportRow({ k, v, kind, img }) {
  return html`<div class=${"report-row" + (kind ? " is-" + kind : "")}>
    <span class="report-k">${k}</span><span class="report-v">${v}${img ? html` <${Icon} n="camera" />` : null}</span></div>`;
}

function ReportModal({ report, closing, onClose }) {
  const s = report.session;
  const empty = html`<p class="report-empty">${t("report.none")}</p>`;
  return html`
    <div class=${"blk-modal" + (closing ? " is-closing" : "")} onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="blk-modal-frame report-frame" role="dialog" aria-label=${t("report.title")}>
        <div class="blk-modal-head">
          <span class="label">${t("report.title")}</span>
          <div class="report-actions">
            <button type="button" class="blk-modal-x" onClick=${() => downloadReport(report)}>${t("report.export")}</button>
            <button type="button" class="blk-modal-x" onClick=${onClose}>${t("report.close")}</button>
          </div>
        </div>
        <div class="report-body">
          <h2 class="report-title">${s.title || t("chat.untitled")}</h2>
          <p class="report-sub">${new Date(report.generated).toLocaleString()}</p>

          <h3 class="report-h">${t("report.mission")}</h3>
          ${s.mission ? html`<p class="report-p">${s.mission}</p>` : empty}

          <h3 class="report-h">${t("report.status")}</h3>
          <${ReportRow} k=${t("verdict.entryStatus")} v=${report.verdict.label + " · " + report.verdict.cause} kind=${report.verdict.kind} />
          <${ReportRow} k=${t("report.link")} v=${(report.link.connected ? t("report.online") : t("report.offline"))
            + ` · ${report.link.packets} pkt · ${report.link.ping} · ${report.link.uptime}`} />

          <h3 class="report-h">${t("report.environment")}</h3>
          ${report.environment.map(e => html`<${ReportRow} key=${e.key} k=${e.label}
            v=${e.value == null ? "—" : `${e.value} ${e.unit}${e.status ? " · " + e.status : ""}`} kind=${e.kind} />`)}

          <h3 class="report-h">${t("report.findings")} · ${report.findings.length}</h3>
          ${report.findings.length ? report.findings.map((f, i) => html`
            <${ReportRow} key=${i} k=${f.time} v=${f.text} img=${f.hasImage} kind=${f.kind === "danger" ? "abort" : f.kind === "warn" ? "warn" : null} />`) : empty}

          <h3 class="report-h">${t("report.analysis")} · ${report.analysis.length}</h3>
          ${report.analysis.length ? report.analysis.map((h, i) => html`
            <div key=${i} class="report-note"><span class="report-k">${h.time}</span><p class="report-p">${h.text}</p></div>`) : empty}

          <h3 class="report-h">${t("report.conversation")} · ${report.conversation.length}</h3>
          ${report.conversation.length ? report.conversation.map((m, i) => html`
            <div key=${i} class=${"report-msg is-" + m.role}><span class="report-k">${m.role}</span><p class="report-p">${m.content}</p></div>`) : empty}

          <h3 class="report-h">${t("report.events")} · ${report.events.length}</h3>
          ${report.events.length ? report.events.slice(-40).map((l, i) => html`
            <${ReportRow} key=${i} k=${l.time} v=${l.text} kind=${l.type === "danger" ? "abort" : l.type === "warn" ? "warn" : null} />`) : empty}
        </div>
      </div>
    </div>`;
}

export { ReportModal, buildReport };
