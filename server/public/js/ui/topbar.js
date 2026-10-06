import { useState } from "react";
import { LANGS, t } from "../i18n.js";
import { Icon, VIEWER, html } from "./core.js";
import { mcpWhat } from "./modals.js";

// ---- topbar + drawer ----
function Topbar({ connected, stale, bridge, onBridge, ping, packets, uptime, lanUrl, lanIp, lang, onLang, onConsole, consoleOpen, clients, onDevices, granted, cloud, onSettings, mcp }) {
  return html`
    <header class="topbar">
      <div class="brand">
        ${""}
        <img src="brand.svg" alt="" width="24" height="24" />
      </div>
      <p class="lamp visually-hidden" role="status" aria-live="polite">
        ${connected ? t("mast.linkLive") : t("mast.noSignal")}
      </p>
      ${VIEWER ? html`<span class=${"pill top-mirror" + (granted ? " is-go" : "")}>
        ◉ ${t(granted ? "mast.control" : "mast.mirror")}</span>` : html`
      <div class="top-conn">
        <div class="bridge-ctl">
          ${""}
          <button type="button" class=${"bridge-btn " + (bridge.running ? (stale ? "is-stale" : "is-on") : "")}
            disabled=${bridge.busy} onClick=${() => onBridge("toggle")}>
            <span class=${"lamp-dot " + (bridge.running && !stale ? "is-go" : "is-abort")}></span>
            ${bridge.busy ? t("mast.bridgeBusy") : !bridge.running ? t("mast.connect")
              : stale ? t("mast.stale") : bridge.usb ? t("mast.linkedUsb") : t("mast.linked")}
          </button>
          <button type="button" class="bridge-repair" title=${t("mast.bridgeRepairTitle")}
            disabled=${bridge.busy} onClick=${() => onBridge("reconnect")}>⟳</button>
          ${!bridge.running && html`<button type="button" class="bridge-repair" title=${t("mast.usbTitle")}
            disabled=${bridge.busy} onClick=${() => onBridge("usb")}>USB</button>`}
        </div>
      </div>`}
      ${""}
      ${cloud && html`<span class="top-cloud">
        <span class=${"pill " + (cloud.sage ? "is-go" : "is-abort")} title=${t("cloud.title")}>${t("cloud.sage")}</span>
        <span class=${"pill " + (cloud.tts ? "is-go" : "is-abort")} title=${t("cloud.title")}>${t("cloud.tts")}</span>
        ${mcp && html`<button type="button" key=${mcp.at} class="pill is-go mcp-pill" onClick=${window.blackout ? onSettings : undefined}
          title=${t("settings.mcpLast", { what: mcpWhat(mcp), ago: Math.round((Date.now() - mcp.at) / 1000) })}>MCP</button>`}
      </span>`}
      <div class="top-stats">
        <dl class="stat"><dt>${t("mast.ping")}</dt><dd>${ping}</dd></dl>
        <dl class="stat"><dt>${t("mast.packets")}</dt><dd>${packets}</dd></dl>
        <dl class="stat"><dt>${t("mast.uptime")}</dt><dd>${uptime}</dd></dl>
        ${lanUrl && html`
          <dl class="stat stat-lan"><dt>${t("mast.tablet")}</dt>
            <dd><button type="button" class="lan-btn" title=${lanIp ? `${t("mast.tabletTitle")} — ${lanIp}` : t("mast.tabletTitle")}
              onClick=${() => navigator.clipboard?.writeText(lanUrl)}>${lanUrl.replace("http://", "")}</button></dd>
          </dl>`}
      </div>
      <select class="port-select top-lang" value=${lang} onChange=${e => onLang(e.target.value)} aria-label=${t("mast.lang")}>
        ${LANGS.map(l => html`<option key=${l.code} value=${l.code}>${l.label}</option>`)}
      </select>
      ${!VIEWER && window.blackout && html`
        <button type="button" class="console-btn" onClick=${onSettings} title=${t("settings.title")} aria-label=${t("settings.title")}><${Icon} n="gear" /></button>`}
      ${!VIEWER && html`
        <button type="button" class="console-btn" onClick=${onDevices} title=${t("devices.title")}>
          ◈ ${t("devices.button")} ${clients.length}
        </button>`}
      ${!VIEWER && html`
        <button type="button" class=${"console-btn" + (consoleOpen ? " is-active" : "")}
          onClick=${onConsole} aria-pressed=${consoleOpen} title=${t("serial.toggleTitle")}>
          ▤ ${t("drawer.console")}
        </button>`}
    </header>`;
}

const SAVERS = ["saverOff", "matrix", "saverBounce", "saverStars", "saverTetris"];

// the second cam feed, hidden with a body class rather than unmounted: the two
// CamViews are deliberately kept alive (see CamStage) and a reopened stream is
// ~12s of "loading", so hiding must not tear one down.
const pipSet = (on) => document.body.classList.toggle("no-pip", !on);
pipSet(localStorage.getItem("camPip") !== "0");
const ZOOM_MIN = 100, ZOOM_MAX = 250;
const zoomSet = (pct) => document.documentElement.style.setProperty("--cam-zoom", String(pct / 100));
zoomSet(Number(localStorage.getItem("camZoom")) || 100);
function ZoomSlider() {
  const [pct, setPct] = useState(() => Number(localStorage.getItem("camZoom")) || 100);
  const set = (v) => {
    const n = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(v)));
    setPct(n); localStorage.setItem("camZoom", String(n)); zoomSet(n);
  };
  return html`
    <label class="serial-btn drawer-zoom" title=${t("drawer.zoomTitle")}>
      ${t("drawer.zoom")}: ${pct}%
      <input type="range" min=${ZOOM_MIN} max=${ZOOM_MAX} step="5" value=${pct}
        aria-label=${t("drawer.zoom")}
        onInput=${(e) => set(Number(e.target.value))}
        onDblClick=${() => set(100)} />
    </label>`;
}

function PipToggle() {
  const [on, setOn] = useState(() => localStorage.getItem("camPip") !== "0");
  const flip = () => setOn(v => { localStorage.setItem("camPip", v ? "0" : "1"); pipSet(!v); return !v; });
  return html`
    <button type="button" class=${"serial-btn drawer-pip" + (on ? " is-on" : "")}
      aria-pressed=${on} onClick=${flip} title=${t("drawer.pipTitle")}>
      ${t("drawer.pip")}: ${t(on ? "drawer.on" : "drawer.off")}
    </button>`;
}

export { PipToggle, SAVERS, Topbar, ZoomSlider };
