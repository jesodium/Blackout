import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n.js";
import { Icon, html } from "./core.js";

// ---- onboarding ----
const ONBOARD_CURRENT = { key: "v3", label: "Blackout V3", descKey: "onboard.v3Desc", photo: "onboard/rover-cave.jpg" };
const ONBOARD_LEGACY = [{ key: "v2", label: "Blackout V2", descKey: "onboard.v2Desc" }];
const ONBOARD_MODELS = [ONBOARD_CURRENT, ...ONBOARD_LEGACY];

function OnboardHero({ onStart }) {
  return html`
    <div class="onboard-view onboard-hero">
      <h1 class="onboard-title">${t("onboard.title")}</h1>
      <p class="onboard-desc">${t("onboard.desc")}</p>
      <div class="onboard-feats">
        <span class="onboard-feat">${t("onboard.featDrive")}</span>
        <span class="onboard-feat">${t("onboard.featSensors")}</span>
        <span class="onboard-feat">${t("onboard.featSage")}</span>
      </div>
      <div class="onboard-photos">
        <img src="onboard/rover-cave.jpg" alt="" />
        <img src="onboard/rover.jpg" alt="" />
        <img src="onboard/shot-console.jpg" alt="" />
      </div>
      <button type="button" class="serial-btn warn-go onboard-cta" autoFocus onClick=${onStart}>${t("onboard.startBtn")}</button>
    </div>`;
}

function OnboardModel({ onBack, onPickModel }) {
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [count, setCount] = useState(3);
  useEffect(() => {
    if (confirm !== "open") return;
    setCount(3);
    const id = setInterval(() => setCount((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(id);
  }, [confirm]);
  const closeConfirm = useCallback(() => {
    setConfirm((c) => (c === "open" ? "closing" : c));
    setTimeout(() => setConfirm(false), 220);
  }, []);
  const confirmLegacy = useCallback((key) => { closeConfirm(); onPickModel(key); }, [closeConfirm, onPickModel]);

  return html`
    <${React.Fragment}>
      <div class="onboard-view">
        <button type="button" class="onboard-back" onClick=${onBack}>${t("onboard.back")}</button>
        <h2 class="onboard-h2">${t("onboard.chooseModel")}</h2>
        <button type="button" class="onboard-model-card onboard-model-featured"
          style=${{ backgroundImage: `linear-gradient(180deg, rgba(6,6,7,0.1), rgba(6,6,7,0.88)), url(${ONBOARD_CURRENT.photo})` }}
          onClick=${() => onPickModel(ONBOARD_CURRENT.key)}>
          <span class="onboard-model-label">${ONBOARD_CURRENT.label}</span>
          <span class="onboard-model-desc">${t(ONBOARD_CURRENT.descKey)}</span>
        </button>

        <button type="button" class="onboard-legacy-toggle" aria-expanded=${legacyOpen} onClick=${() => setLegacyOpen((o) => !o)}>
          ${t("onboard.legacyToggle")}
          <span class=${"onboard-legacy-caret" + (legacyOpen ? " is-open" : "")} aria-hidden="true">⌄</span>
        </button>
        <div class=${"onboard-legacy" + (legacyOpen ? " is-open" : "")}>
          <div class="onboard-legacy-inner">
            ${ONBOARD_LEGACY.map((m) => html`
              <button key=${m.key} type="button" class="onboard-model-card onboard-model-legacy" onClick=${() => setConfirm("open")}>
                <span class="onboard-legacy-badge">${t("onboard.legacyBadge")}</span>
                <span class="onboard-model-label">${m.label}</span>
                <span class="onboard-model-desc">${t(m.descKey)}</span>
              </button>`)}
          </div>
        </div>
      </div>
      ${confirm && createPortal(html`
        <div class=${"blk-modal" + (confirm === "closing" ? " is-closing" : "")}
          onClick=${(e) => { if (e.target === e.currentTarget) closeConfirm(); }}>
          <div class="blk-modal-frame warn-frame" role="alertdialog" aria-label=${t("onboard.legacyWarnTitle")}>
            <span class="warn-title"><${Icon} n="warn" /> ${t("onboard.legacyWarnTitle")}</span>
            <p>${t("onboard.legacyWarnBody")}</p>
            <div class="warn-actions">
              <button type="button" class="serial-btn" onClick=${closeConfirm}>${t("onboard.legacyCancel")}</button>
              <button type="button" class="serial-btn warn-go" disabled=${count > 0} onClick=${() => confirmLegacy(ONBOARD_LEGACY[0].key)}>
                ${t("onboard.legacyContinue")}<span class=${"warn-count" + (count > 0 ? "" : " is-done")}> (${count || 1})</span>
              </button>
            </div>
          </div>
        </div>`, document.body)}
    </${React.Fragment}>`;
}

function OnboardPair({ model, bridge, onBack, onConnect, onSkipConnect }) {
  const modelLabel = ONBOARD_MODELS.find((m) => m.key === model)?.label || "Blackout";
  return html`
    <div class="onboard-view">
      <button type="button" class="onboard-back" disabled=${bridge.busy} onClick=${onBack}>${t("onboard.back")}</button>
      <h2 class="onboard-h2">${t("onboard.pairTitle", { model: modelLabel })}</h2>
      <svg class="onboard-sweep" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.5" />
        <circle cx="12" cy="12" r="5.5" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.5" />
        <path class="g-sweep" d="M12 12 L12 2 A10 10 0 0 1 20.6 7 Z" fill="currentColor" fill-opacity="0.55" />
      </svg>
      <p class="onboard-desc">${t("onboard.pairBody")}</p>
      <button type="button" class="serial-btn warn-go onboard-cta" disabled=${bridge.busy || bridge.running} onClick=${onConnect}>
        ${bridge.running ? t("onboard.connected") : bridge.busy ? t("onboard.connecting") : t("onboard.connect")}
      </button>
      <button type="button" class="onboard-later" onClick=${onSkipConnect}>${t("onboard.later")}</button>
    </div>`;
}

const ONBOARD_VIEWS = { hero: OnboardHero, model: OnboardModel, pair: OnboardPair };

function Onboard({ step, closing, model, bridge, onStart, onPickModel, onBack, onConnect, onSkipConnect, onDone }) {
  const View = ONBOARD_VIEWS[step];
  if (!View) return null;
  return html`
    <div class=${"onboard" + (closing ? " is-closing" : "")} role="dialog" aria-modal="true" aria-label=${t("onboard.title")}>
      <button type="button" class="onboard-skip" onClick=${onDone}>${t("onboard.skip")}</button>
      <${View} model=${model} bridge=${bridge} onStart=${onStart} onPickModel=${onPickModel}
        onBack=${onBack} onConnect=${onConnect} onSkipConnect=${onSkipConnect} />
    </div>`;
}

// ---- tour ----
// while the tour is up it owns the gamepad; Drive and App read this flag
const tourGate = { open: false };
const TOUR = [
  [".brand", "brand"],
  [".bridge-ctl, .top-mirror", "link"],
  [".bridge-ctl", "pair", () => !!window.blackout],
  [".stage-3d", "stage"],
  [".stage-cam", "cam"],
  [".strip", "strip"],
  [".agent", "agent"],
  [".drive", "drive"],
  [".console-btn:last-of-type", "console"],
  [".topbar .console-btn", "mirrorShare"],
];

function Tour({ closing, onDone }) {
  const steps = useRef(TOUR.filter(([sel, , when]) => (!when || when()) && document.querySelector(sel))).current;
  const [i, setI] = useState(0);
  const [box, setBox] = useState(null);
  const step = steps[i];
  const last = i >= steps.length - 1;

  useLayoutEffect(() => {
    if (!step) { onDone(); return; }

    const measure = () => {
      const el = document.querySelector(step[0]);
      if (!el) return setBox(null);
      const r = el.getBoundingClientRect();
      setBox(b => (b && b.x === r.left - 6 && b.y === r.top - 6 && b.w === r.width + 12 && b.h === r.height + 12)
        ? b : { x: r.left - 6, y: r.top - 6, w: r.width + 12, h: r.height + 12 });
    };
    measure();
    const id = setInterval(measure, 250);
    window.addEventListener("resize", measure);
    return () => { clearInterval(id); window.removeEventListener("resize", measure); };
  }, [i, step, onDone]);

  useEffect(() => {
    const root = document.getElementById("root");
    root.inert = true;
    tourGate.open = true;
    const onKey = (e) => {
      e.stopPropagation();
      if (e.type === "keydown" && e.key === "Escape") onDone();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      root.inert = false;
      tourGate.open = false;
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    };
  }, [onDone]);

  if (!step || !box) return null;
  const below = box.y + box.h + 190 < window.innerHeight;
  const card = {
    left: Math.max(8, Math.min(box.x, window.innerWidth - 340)) + "px",
    top: (below ? box.y + box.h + 12 : Math.max(8, box.y - 12)) + "px",
    transform: below ? "none" : "translateY(-100%)",
  };
  return html`
    <div class=${"tour" + (closing ? " is-closing" : "")} role="dialog" aria-modal="true" aria-label=${t("tour." + step[1] + ".t")}>
      <div class="tour-hole" style=${{ left: box.x + "px", top: box.y + "px", width: box.w + "px", height: box.h + "px" }}></div>
      <div class="tour-card" style=${card}>
        <span class="tour-count">${i + 1} / ${steps.length}</span>
        <h3 class="tour-title">${t("tour." + step[1] + ".t")}</h3>
        <p class="tour-text">${t("tour." + step[1] + ".b")}</p>
        <div class="tour-actions">
          <button type="button" class="serial-btn" onClick=${onDone}>${t("tour.skip")}</button>
          <button type="button" class="serial-btn warn-go" autoFocus
            onClick=${() => last ? onDone() : setI(n => n + 1)}>${last ? t("tour.done") : t("tour.next")}</button>
        </div>
      </div>
    </div>`;
}

export { Onboard, Tour, tourGate };
