import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BOOSTS, BOOST_KEY } from "../control.js";
import { t } from "../i18n.js";
import { cursorOn } from "../padnav.mjs";
import { Arm } from "./arm.js";
import { BlkCtl } from "./blkctl.js";
import { html } from "./core.js";

// ---- drive ----

const MODES = [["remote", "REMOTE"], ["blk", "BLK"]];
const KEYMAP = {
  w: "fwd", arrowup: "fwd", s: "back", arrowdown: "back",
  a: "left", arrowleft: "left", d: "right", arrowright: "right",
};

const VERB_MIX = { fwd: [1, 1], back: [-1, -1], left: [1, -1], right: [-1, 1] };

function Drive({ onCmd, onAnalyze, enabled, leaving, busyRef, packetRef }) {
  const [mode, setMode] = useState("remote");
  const [sub, setSub] = useState("motors");   // remote splits in two screens: drive pad / arm
  const [padName, setPadName] = useState(null);
  const bodyRef = useRef(null);
  const innerRef = useRef(null);
  const [verb, setVerb] = useState(null);
  const armed = mode === "remote" && enabled;
  const armedRef = useRef(armed);
  armedRef.current = armed;
  const heldRef = useRef(null);
  // the wheels park while the arm pad is up: same stick, and a jog that also
  // rolls the rover off the bench is how a joint gets wound into the frame
  const subRef = useRef(sub);
  subRef.current = sub;
  const keysRef = useRef(new Set());
  const moving = useRef(false);
  const sqWas = useRef(false);
  // R2 boost cap, per rig — the ceiling the pad's trigger drives at
  const [boost, setBoost] = useState(() => +localStorage.getItem(BOOST_KEY) || BOOSTS[1][1]);
  const boostRef = useRef(boost);
  boostRef.current = boost;
  const analyzeRef = useRef(onAnalyze);
  analyzeRef.current = onAnalyze;

  useEffect(() => {
    const seen = () => setPadName([...navigator.getGamepads()].find(Boolean)?.id || null);
    window.addEventListener("gamepadconnected", seen);
    window.addEventListener("gamepaddisconnected", seen);
    seen();
    return () => { window.removeEventListener("gamepadconnected", seen); window.removeEventListener("gamepaddisconnected", seen); };
  }, []);

  useEffect(() => {
    const typing = (e) => { const t = e.target; return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable); };
    const down = (e) => {
      if (!armedRef.current || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === " ") { e.preventDefault(); keysRef.current.clear(); heldRef.current = null; onCmd("stop"); return; }
      if (!KEYMAP[k]) return;
      e.preventDefault();
      keysRef.current.add(k);
      heldRef.current = KEYMAP[k];
    };
    const up = (e) => {
      const k = e.key.toLowerCase();
      if (!KEYMAP[k]) return;
      keysRef.current.delete(k);
      const left = [...keysRef.current].pop();
      heldRef.current = left ? KEYMAP[left] : null;
    };
    const blur = () => { keysRef.current.clear(); heldRef.current = null; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", blur); };
  }, [onCmd]);

  const MANUAL_PWM = 110;
  const SPIN_SCALE = 0.45;

  const DEADZONE = 0.15;
  const MIN_PWM = 55;
  useEffect(() => {
    const dz = (v) => (Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE));
    const duty = (v, cap) => (Math.abs(v) < 0.02 ? 0
      : Math.round(Math.sign(v) * (MIN_PWM + (cap - MIN_PWM) * Math.min(1, Math.abs(v)))));
    const verbOf = (l, r) => (!l && !r ? null
      : Math.abs(l - r) > Math.abs(l + r) ? (l > r ? "left" : "right") : l + r > 0 ? "fwd" : "back");
    const id = setInterval(() => {
      if (!armedRef.current || subRef.current === "arm" || cursorOn()) { if (moving.current) { moving.current = false; setVerb(null); onCmd("stop"); } return; }
      const pad = [...navigator.getGamepads()].find(Boolean);

      const turbo = !!pad && (pad.buttons[7]?.pressed || (pad.buttons[7]?.value ?? 0) > 0.35);
      const cap = turbo ? boostRef.current : MANUAL_PWM;
      let l = 0, r = 0;
      if (pad) {
        const sq = !!pad.buttons[2]?.pressed;
        if (sq && !sqWas.current) analyzeRef.current?.();
        sqWas.current = sq;
        const y = -dz(pad.axes[1] ?? 0), x = dz(pad.axes[0] ?? 0);
        l = y - x; r = y + x;
        const rx = dz(pad.axes[2] ?? 0);
        l -= rx * SPIN_SCALE; r += rx * SPIN_SCALE;
      }
      if (!l && !r && heldRef.current) [l, r] = VERB_MIX[heldRef.current];

      const peak = Math.max(Math.abs(l), Math.abs(r));
      if (peak > 1) { l /= peak; r /= peak; }
      l = duty(l, cap); r = duty(r, cap);
      if (!l && !r) {
        if (moving.current) { moving.current = false; setVerb(null); onCmd("stop"); }
        return;
      }
      moving.current = true; setVerb(verbOf(l, r));
      onCmd(`drv,tank,${l},${r},300`);
    }, 150);
    return () => clearInterval(id);
  }, [onCmd]);

  const pick = (m) => {
    if (m === mode) return;
    if (mode === "remote") { heldRef.current = null; moving.current = false; setVerb(null); onCmd("stop"); }
    setMode(m);
  };

  useLayoutEffect(() => {
    const el = bodyRef.current, inner = innerRef.current;
    if (!el || !inner || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let prev = inner.offsetHeight, anim = null;
    const ro = new ResizeObserver(() => {
      const h = inner.offsetHeight;
      if (h === prev) return;

      const from = anim?.playState === "running" ? el.offsetHeight : prev;
      prev = h;
      anim?.cancel();
      el.style.overflow = "hidden";
      anim = el.animate([{ height: from + "px" }, { height: h + "px" }],
        { duration: 340, easing: "cubic-bezier(0.32, 0.72, 0, 1)" });
      anim.finished.then(() => { el.style.overflow = ""; }, () => {});
    });
    ro.observe(inner);
    return () => { ro.disconnect(); anim?.cancel(); };
  }, []);

  const hold = (v) => (e) => { e.preventDefault(); if (armedRef.current) heldRef.current = v; };
  const release = () => { heldRef.current = null; };
  const padBtn = (v, glyph, key) => html`
    <button type="button" class=${"pad-btn" + (verb === v ? " is-live" : "")} disabled=${!armed}
      aria-label=${v} onPointerDown=${hold(v)} onPointerUp=${release} onPointerLeave=${release}
      onPointerCancel=${release} onContextMenu=${(e) => e.preventDefault()}>
      <span class="pad-glyph" aria-hidden="true">${glyph}</span>
      <kbd aria-hidden="true">${key}</kbd>
    </button>`;

  const hint = mode !== "remote" ? null
    : !enabled ? t("toast.cmdNoLink")
    : verb ? "▶ " + verb.toUpperCase()
    : padName ? t("drive.pad")
    : t("drive.hold");

  return html`
    <section class=${"zone drive " + (leaving ? "is-leaving" : "reveal")} aria-labelledby="drive-h">
      <div class="zone-head">
        <h2 class="zone-title" id="drive-h">${t("zone.drive")}</h2>
        <span class=${"pill " + (padName ? "is-go" : "")}>${padName ? "PAD OK" : "NO PAD"}</span>
      </div>
      <div class="drive-body" ref=${bodyRef}>
       <div class="drive-inner" ref=${innerRef}>
        <div class="conn-seg mode-seg" data-mode=${mode} role="tablist">
          <span class="conn-seg-thumb"></span>
          ${MODES.map(([m, label]) => html`
            <button type="button" key=${m} role="tab" aria-selected=${mode === m}
              class=${mode === m ? "is-active" : ""} onClick=${() => pick(m)}>${label}</button>`)}
        </div>
        ${mode === "remote" ? html`
          ${sub === "motors" ? html`
            <div class=${"pad" + (armed ? "" : " is-off")}>
              <span></span>${padBtn("fwd", "▲", "W")}<span></span>
              ${padBtn("left", "◀", "A")}${padBtn("back", "▼", "S")}${padBtn("right", "▶", "D")}
            </div>
            <small class="drive-hint">${hint}</small>
            <div class="arm-spd boost-row">
              <span class="label">R2</span>
              ${BOOSTS.map(([lbl, v]) => html`
                <button type="button" key=${v} class=${"chip" + (boost === v ? " is-on" : "")}
                  aria-pressed=${boost === v} title="pwm cap while the R2 trigger is held"
                  onClick=${() => { setBoost(v); localStorage.setItem(BOOST_KEY, v); }}>${lbl}</button>`)}
            </div>`
          : html`<${Arm} onCmd=${onCmd} enabled=${armed} />`}
          <div class="conn-seg sub-seg" data-sub=${sub} role="tablist">
            <span class="conn-seg-thumb"></span>
            ${[["motors", "MOTORS"], ["arm", "ARM"]].map(([m, label]) => html`
              <button type="button" key=${m} role="tab" aria-selected=${sub === m}
                class=${sub === m ? "is-active" : ""}
                onClick=${() => { if (m !== sub) { if (sub === "arm") onCmd("arm,"); setSub(m); } }}>${label}</button>`)}
          </div>`
        : html`
          <${BlkCtl} onCmd=${onCmd} onAnalyze=${onAnalyze} enabled=${enabled} busyRef=${busyRef} packetRef=${packetRef} />`}
        ${mode !== "remote" && html`
        <div class="routines">
          <span class="label">${t("drive.routines")}</span>
          <div class="routine-row">
            ${[["presentation", "PRES", "mast.routinePresTitle"], ["run", "RUN", "mast.routineRunTitle"],
               ["mission", "MISSION", "mast.routineMissionTitle"], ["test", "TEST", "mast.routineTestTitle"],
               ["test2", "TEST2", "mast.routineTest2Title"]].map(([r, label, titleKey]) => html`
              <button type="button" key=${r} class="chip" title=${t(titleKey)}
                disabled=${!enabled} onClick=${() => onCmd("go," + r)}>${label}</button>`)}
          </div>
        </div>`}
       </div>
      </div>
    </section>`;
}

export { Drive };
