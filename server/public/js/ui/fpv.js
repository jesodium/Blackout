import { getLang, t } from "../i18n.js";
import { fmt, html } from "./core.js";
import { deriveIntent } from "./verdict.js";

// ---- fpv ----
const FPV_ZOOMS = [
  { id: "fill", label: "FILL" },
  { id: "fit", label: "FIT", z: 1 },
  { id: "z125", label: "125%", z: 1.25 },
  { id: "z160", label: "160%", z: 1.6 },
];

function FpvOverlay({ packet }) {
  const roll = packet?.roll ?? 0;
  const pitch = packet?.pitch ?? 0;
  const dist = packet?.dist;

  const near = dist != null && !isNaN(dist) && dist > 0 && dist < 30;

  return html`
    <div class="fpv-glass" aria-hidden="true">
      <div class="fpv-brackets"><i></i><i></i><i></i><i></i></div>

      <div class="fpv-attitude" style=${{ transform: `translateY(${Math.max(-28, Math.min(28, pitch)) * 4}px) rotate(${-roll}deg)` }}>
        <span class="fpv-horizon"></span>
      </div>

      <div class=${"fpv-reticle" + (near ? " is-near" : "")}>
        <svg viewBox="0 0 120 120">
          <path d="M60 42V54 M60 66V78 M42 60H54 M66 60H78" />
          <circle cx="60" cy="60" r="1.6" class="fpv-pip" />
        </svg>
        <span class="fpv-reticle-num">${fmt(dist, 0)}<i>cm</i></span>
      </div>

      <div class="fpv-scan"></div>
      <div class="fpv-vignette"></div>
    </div>`;
}

const FPV_STATS = [
  { k: "sensor.dist",  u: "cm",  v: p => fmt(p?.dist, 0) },
  { k: "sensor.temp",  u: "°C",  v: p => fmt(p?.temp, 0) },
  { k: "sensor.humid", u: "%",   v: p => fmt(p?.humid, 0) },
  { k: "sensor.alt",   u: "m",   v: p => fmt(p?.alt, 0) },
];

function FpvSage({ ai, packet, speaking, connected }) {
  const state = ai.analyzing ? t("intent.thinking")
    : speaking ? t("intent.speaking")
    : t(deriveIntent(ai, packet, connected).label);
  return html`
    <section class=${"fpv-sage" + (speaking ? " is-speaking" : "")} aria-label="Sage">
      <p class="fpv-sage-bar">
        <i class="fpv-sage-dot" aria-hidden="true"></i><b>Sage</b><span>${t("zone.agent")}</span>
        <span class="fpv-sage-state">${state} · ${getLang()}</span>
      </p>
      <p class=${"fpv-sage-said" + (ai.status ? " sage-" + ai.status : "")} key=${ai.text}
        role="status" aria-live="polite">${ai.text}</p>
      <div class="fpv-sage-row">
        ${FPV_STATS.map(s => html`
          <div key=${s.k}><small>${t(s.k)}</small><strong>${s.v(packet)}<i>${s.u}</i></strong></div>`)}
      </div>
    </section>`;
}

export { FPV_ZOOMS, FpvOverlay, FpvSage };
