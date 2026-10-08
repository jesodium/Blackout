import qrcode from "qrcode";
import { useEffect, useState } from "react";
import { t } from "../i18n.js";
import { Icon, html } from "./core.js";

// ---- modals ----
function Toasts({ items }) {
  return html`<div class="toasts">${items.map(t => html`<div key=${t.id} class=${"toast k-" + t.kind + (t.leaving ? " is-leaving" : "")}>${t.msg}</div>`)}</div>`;
}

// electron only: a public https url (cloudflared, owned by electron/main.js) for a
// tablet the LAN can't reach. Shown as a qr -- nobody types a trycloudflare url.
function TunnelRow() {
  const [st, setSt] = useState({ on: false, url: null });
  const [busy, setBusy] = useState(false);
  useEffect(() => { window.blackout.getTunnel().then(setSt); return window.blackout.onTunnel(setSt); }, []);
  const flip = async () => { setBusy(true); setSt(await window.blackout.tunnel(!st.on)); setBusy(false); };
  const qr = st.url && (() => { const q = qrcode(0, "M"); q.addData(st.url); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); })();
  return html`
    <div class="tunnel-row">
      <div class="device-row">
        <span class="device-name">${t("devices.tunnel")}</span>
        <button type="button" class=${"serial-btn" + (st.on ? " is-on" : "")} disabled=${busy} onClick=${flip}>
          ${busy ? t("devices.tunnelStarting") : st.on ? t("devices.tunnelStop") : t("devices.tunnelStart")}
        </button>
      </div>
      ${st.error && html`<p class="tunnel-err">${st.error}</p>`}
      ${st.url && html`
        <div class="tunnel-qr" dangerouslySetInnerHTML=${{ __html: qr }} />
        <button type="button" class="lan-btn tunnel-url" title=${t("devices.tunnelCopy")}
          onClick=${() => navigator.clipboard?.writeText(st.url)}>${st.url.replace(/^https?:\/\//, "")}</button>`}
    </div>`;
}

const DEV_MODES = [["mirror", "devices.view"], ["judge", "devices.judge"], ["full", "devices.full"]];

function DevicesModal({ open, clients, selfId, onMode, onClose }) {
  const [ask, setAsk] = useState(null);
  const [count, setCount] = useState(3);
  useEffect(() => {
    if (!ask || ask.closing) return;
    setCount(3);
    const iv = setInterval(() => setCount(n => Math.max(0, n - 1)), 1000);
    return () => clearInterval(iv);
  }, [ask?.c.id, ask?.closing]);
  const closeAsk = () => { setAsk(a => a && { ...a, closing: true }); setTimeout(() => setAsk(null), 220); };
  return html`
    <div class=${"blk-modal" + (open === "closing" ? " is-closing" : "")}
      onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="blk-modal-frame devices-frame">
        <div class="blk-modal-head">
          <span class="label">${t("devices.title")}</span>
          <button type="button" class="blk-modal-x" onClick=${onClose} aria-label=${t("update.close")}>✕</button>
        </div>
        <ul class="device-list">
          ${clients.length === 0 && html`<li class="device-empty">${t("devices.none")}</li>`}
          ${clients.map(c => html`
            <li key=${c.id} class="device-row">
              <span class="device-name">
                ${c.kind} · ${c.ip}
                ${c.id === selfId ? html`<span class="pill">${t("devices.this")}</span>` : null}
              </span>
              ${c.host
                ? html`<span class="pill is-go">${t("devices.host")}</span>`
                : html`<select class=${"serial-btn device-mode" + (c.granted ? " is-on" : "")}
                    value=${c.mode || "mirror"} aria-label=${t("devices.modeLabel")}
                    onChange=${(e) => {
                      const m = e.target.value;

                      if (m === "full") { e.target.value = c.mode || "mirror"; setAsk({ c }); }
                      else onMode(c.id, m);
                    }}>
                    ${DEV_MODES.map(([v, k]) => html`<option key=${v} value=${v}>${t(k)}</option>`)}
                  </select>`}
            </li>`)}
        </ul>
        ${window.blackout?.tunnel && html`<${TunnelRow} />`}
      </div>
      ${ask && html`
        <div class=${"blk-modal" + (ask.closing ? " is-closing" : "")}
          onClick=${(e) => { if (e.target === e.currentTarget) closeAsk(); }}>
          <div class="blk-modal-frame warn-frame" role="alertdialog" aria-label=${t("devices.confirmTitle")}>
            <span class="warn-title"><${Icon} n="warn" /> ${t("devices.confirmTitle")}</span>
            <p>${t("devices.confirmBody", { name: `${ask.c.kind} · ${ask.c.ip}` })}</p>
            <div class="warn-actions">
              <button type="button" class="serial-btn" onClick=${closeAsk}>${t("devices.confirmCancel")}</button>
              <button type="button" class="serial-btn warn-go" disabled=${count > 0}
                onClick=${() => { onMode(ask.c.id, "full"); closeAsk(); }}>
                ${t("devices.confirmGo")}<span class=${"warn-count" + (count > 0 ? "" : " is-done")}> (${count || 1})</span>
              </button>
            </div>
          </div>
        </div>`}
    </div>`;
}

// "robot_command: drv,fwd,120" -- what an MCP client just did, in the tool's own name
const MCP_TOOL = { "/api/now": "robot_status", "/api/look": "robot_camera", "/api/cmd": "robot_command", "/api/mission": "robot_mission", "/api/chat": "sage_chat", "/api/blk-run": "robot_blk" };
const mcpWhat = (d) => `${MCP_TOOL[d.path] || d.path}${d.arg != null && d.arg !== "" ? `: ${String(d.arg).slice(0, 60)}` : ""}`;

// electron only: hooks server/mcp.mjs into Claude Desktop / Claude Code and shows
// the last call one made. The entry runs the app's own binary as node, so a judge's
// laptop with no node installed still works.
function McpRow() {
  const [info, setInfo] = useState(null);
  const [last, setLast] = useState(null);
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    window.blackout.mcp.get().then(setInfo);
    fetch("/api/mcp").then(r => r.json()).then(setLast).catch(() => {});
    // off the app's one socket (a second one would show up in CONNECTED DEVICES)
    const on = (e) => setLast(e.detail);
    window.addEventListener("mcp", on);
    return () => window.removeEventListener("mcp", on);
  }, []);
  const add = async () => { setErr(null); try { setInfo(await window.blackout.mcp.install()); } catch (e) { setErr(e.message); } };
  const copy = () => { navigator.clipboard?.writeText(info.cli); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  if (!info) return null;
  return html`
    <div class="settings-field">
      <span>${t("settings.mcp")}</span>
      <div class="mcp-row">
        <span class="settings-hint">${info.installed ? t("settings.mcpOn") : t("settings.mcpOff")}</span>
        <button type="button" class=${"serial-btn" + (info.installed ? " is-on" : "")} onClick=${add}>
          ${info.installed ? t("settings.mcpReadd") : t("settings.mcpAdd")}</button>
      </div>
      <button type="button" class="mcp-cli" title=${t("settings.mcpCopy")} onClick=${copy}>${copied ? t("settings.mcpCopied") : info.cli}</button>
      <span class="settings-hint">${last ? t("settings.mcpLast", { what: mcpWhat(last), ago: Math.round((Date.now() - last.at) / 1000) }) : t("settings.mcpNone")}</span>
      ${err && html`<p class="tunnel-err">${err}</p>`}
    </div>`;
}

function BlePickerModal({ open, devices, onPick, onCancel }) {
  const names = devices.map((d) => d.deviceName);
  const label = (d) => {
    const name = d.deviceName || t("ble.unnamed");
    const dup = !d.deviceName || names.filter((n) => n === d.deviceName).length > 1;
    return dup ? `${name} · ${d.deviceId.replace(/[^a-zA-Z0-9]/g, "").slice(-4).toUpperCase()}` : name;
  };

  const assumed = (d) => {
    const n = (d.deviceName || "").toLowerCase();
    if (n.includes("blackout")) return "Blackout V3";
    if (n.includes("arduino") || n.includes("giga")) return "Blackout · Giga R1";
    return t("ble.assumedUnknown");
  };
  return html`
    <div class=${"blk-modal" + (open === "closing" ? " is-closing" : "")}
      onClick=${(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div class="blk-modal-frame devices-frame ble-picker" role="dialog" aria-label=${t("ble.title")}>
        <div class="blk-modal-head">
          <span class="label">BLACKOUT</span>
          <button type="button" class="blk-modal-x" onClick=${onCancel} aria-label=${t("ble.cancel")}>✕</button>
        </div>
        <div class="ble-progress" aria-hidden="true"><span></span></div>
        <ul class="device-list">
          ${devices.length === 0 && html`<li class="device-empty">${t("ble.none")}</li>`}
          ${devices.map((d) => html`
            <li key=${d.deviceId} class="device-row ble-row">
              <button type="button" class="ble-pick" onClick=${() => onPick(d.deviceId)}>
                <span class="ble-pick-main">
                  <span class="device-name">${label(d)}</span>
                  <span class="device-model">${t("ble.assumed")}: ${assumed(d)}</span>
                </span>
                <span class="pill is-go">${t("ble.inRange")}</span>
              </button>
            </li>`)}
        </ul>
        <div class="ble-actions">
          <span class="ble-scanning-label">${t("ble.scanning")}</span>
          <button type="button" class="serial-btn" onClick=${onCancel}>${t("ble.cancel")}</button>
        </div>
      </div>
    </div>`;
}

export { BlePickerModal, DevicesModal, Toasts, mcpWhat };
