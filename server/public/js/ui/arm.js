import { useEffect, useRef, useState } from "react";
import { ARM_JOINTS, ARM_LABELS_KEY, ARM_MIN_JOG_MS, ARM_PAD_DZ, ARM_REPEAT_MS, ARM_SPD_KEY, ARM_SPEEDS, CLAW_FRAME_MS, CLAW_JOINT, CLAW_NUDGE_KEY, CLAW_NUDGE_MAX, armJogOf, armLabelsLoad, armPlay, armRehome, armSend, armStopTape, clawClear, clawGo, clawLatch, clawNudge } from "../control.js";
import { t } from "../i18n.js";
import { html } from "./core.js";

// Shift-click an arrow to name it. "gripper ▶" says nothing about which way is
// open — the crew's own word for it does, and it is per rig, so it lives in
// localStorage rather than in a table someone has to edit and reflash.
// A take that only ever drives ONE joint ONE way is a jog somebody wrote down
// and named — so it gets the arrows' behaviour (hold to run, release to stop)
// instead of replaying a fixed burst. Anything mixed is a real sequence and
// stays a tape. Derived from the file, so naming a take is all it takes.
function Arm({ onCmd, enabled }) {
  const heldRef = useRef(null);
  const downRef = useRef(0);
  const [moves, setMoves] = useState({});
  // which joint the gamepad drives. Six joints and one stick, so the pad picks
  // one at a time; the on-screen arrows still work on any row and set this too.
  const [sel, setSel] = useState(0);
  const [labels, setLabels] = useState(armLabelsLoad);
  const [claw, setClaw] = useState(clawLatch.on);   // the ledger is the truth, this only paints it
  const [nudge, setNudge] = useState(() => +localStorage.getItem(CLAW_NUDGE_KEY) || CLAW_FRAME_MS * 2);
  const [spd, setSpd] = useState(() => +localStorage.getItem(ARM_SPD_KEY) || 100);
  const spdRef = useRef(100);
  spdRef.current = spd;
  const jog = (dir) => Math.round((dir * spdRef.current) / 100);
  const [ren, setRen] = useState(null);   // {i, dir} being named
  const renRef = useRef(null);
  const selRef = useRef(0);
  selRef.current = sel;

  useEffect(() => {
    fetch("/api/arm-moves").then((r) => r.json()).then(setMoves).catch(() => {});
  }, []);

  useEffect(() => {
    if (!enabled) { armStopTape(); return; }
    const id = setInterval(() => {
      setClaw(() => clawLatch.on);   // released by the panic key while we were unmounted?
      const h = heldRef.current;
      if (!h) return;
      armSend(`arm,${h[0]},${h[1]}`, onCmd);
    }, ARM_REPEAT_MS);
    return () => { clearInterval(id); heldRef.current = null; };
  }, [onCmd, enabled]);

  // Gamepad: LB/RB step the selected joint, right stick Y jogs it. The stick is
  // a direction, not a throttle — pulse width is speed AND torque on these 360s,
  // so a half-deflected jog is just a weak one; ±100 like the buttons. It feeds
  // the same heldRef the interval above repeats and limit-checks, so the pad
  // gets the deadman for free.
  useEffect(() => {
    if (!enabled) return;
    const w = { lb: false, rb: false, want: "" };
    const id = setInterval(() => {
      const pad = [...navigator.getGamepads()].find(Boolean);
      if (!pad) return;
      const lb = !!pad.buttons[4]?.pressed, rb = !!pad.buttons[5]?.pressed;
      if (lb && !w.lb) setSel((s) => (s + ARM_JOINTS.length - 1) % ARM_JOINTS.length);
      if (rb && !w.rb) setSel((s) => (s + 1) % ARM_JOINTS.length);
      w.lb = lb; w.rb = rb;

      const v = pad.axes[3] ?? 0;   // right stick Y — the left one is still driving
      const dir = Math.abs(v) < ARM_PAD_DZ ? 0 : jog(v < 0 ? 100 : -100);
      const i = selRef.current;
      const want = dir ? `${i},${dir}` : "";
      if (want === w.want) return;   // held: the 300ms repeat keeps it alive
      if (w.want) { heldRef.current = null; armSend(`arm,${w.want.split(",")[0]},0`, onCmd); }
      w.want = want;
      if (want) {
        if (i === CLAW_JOINT) clawClear();   // a jog takes the joint; two repeats on one channel is a fight
        heldRef.current = [i, dir]; armSend(`arm,${want}`, onCmd);
      }
    }, 60);
    return () => { clearInterval(id); if (w.want) armSend(`arm,${w.want.split(",")[0]},0`, onCmd); };
  }, [enabled, onCmd]);

  // <dialog>, not prompt(): Electron never implemented window.prompt, so the
  // shift-click did nothing at all inside the app.
  useEffect(() => { if (ren) renRef.current?.showModal(); }, [ren]);
  const saveRen = (raw) => {
    const key = `${ren.i}:${ren.dir}`;
    const v = String(raw || "").trim().slice(0, 12).toLowerCase();
    const next = { ...labels };
    if (v) next[key] = v; else delete next[key];
    setLabels(next);
    localStorage.setItem(ARM_LABELS_KEY, JSON.stringify(next));
    setRen(null);
  };

  const press = (i, dir, nameable) => (e) => {
    e.preventDefault();
    setSel(i);
    if (nameable && e.shiftKey) { setRen({ i, dir }); return; }
    if (!enabled) return;
    downRef.current = Date.now();
    heldRef.current = [i, jog(dir)];
    armSend(`arm,${i},${jog(dir)}`, onCmd);   // first one now, the interval only repeats it
  };
  // release stops the joint outright rather than waiting out the deadman — but
  // never before ARM_MIN_JOG_MS, or a tap is a burst too short to see. A press
  // that lands in the meantime owns the joint, so the late stop drops itself.
  const release = (i) => () => {
    if (heldRef.current?.[0] !== i) return;
    heldRef.current = null;
    const left = ARM_MIN_JOG_MS - (Date.now() - downRef.current);
    if (left > 0) setTimeout(() => { if (!heldRef.current) armSend(`arm,${i},0`, onCmd); }, left);
    else armSend(`arm,${i},0`, onCmd);
  };

  return html`
    <div class=${"arm-pad" + (enabled ? "" : " is-off")}>
      <div class="arm-spd">
        ${ARM_SPEEDS.map(([lbl, v]) => html`
          <button type="button" key=${v} class=${"chip" + (spd === v ? " is-on" : "")}
            aria-pressed=${spd === v}
            title="scales the arrows — slow is also weak on these 360s"
            onClick=${() => { setSpd(v); localStorage.setItem(ARM_SPD_KEY, v); }}>${lbl}</button>`)}
      </div>
      <div class="arm-rows">
      ${ARM_JOINTS.map((name, i) => html`
        <div class=${"arm-row" + (i === sel ? " is-sel" : "")} key=${name}>
          <button type="button" class="arm-name" onClick=${() => setSel(i)}
            aria-pressed=${i === sel} title="pick this joint for the gamepad">${name}</button>
          ${[["\u25c0", -100], ["\u25b6", 100]].map(([glyph, dir]) => {
            // the claw is a latch, not a jog — see clawGo(). One tap, no holding.
            const isClaw = i === CLAW_JOINT;
            const lit = isClaw && claw === (dir < 0 ? "open" : "close");
            // a second OPEN burst has nothing to stop it, so the button goes dead
            // until CLOSE. aria-disabled + a class, never disabled: a disabled
            // button emits no pointer events, and shift-click still names it.
            const dead = lit && dir < 0;
            const held = isClaw ? {
              onClick: (e) => {
                setSel(i);
                if (e.shiftKey) return void setRen({ i, dir });
                if (enabled) { clawGo(dir, onCmd); setClaw(clawLatch.on); }
              },
            } : {
              onPointerDown: press(i, dir, true), onPointerUp: release(i),
              onPointerLeave: release(i), onPointerCancel: release(i),
            };
            return html`
            <button type="button" key=${dir}
              class=${"pad-btn arm-btn" + (enabled && !dead ? "" : " is-off") + (lit ? " is-live" : "")}
              aria-disabled=${!enabled || dead} aria-pressed=${isClaw ? lit : undefined}
              aria-label=${`${name} ${labels[`${i}:${dir}`] || (isClaw ? (dir < 0 ? "open" : "close") : (dir < 0 ? "reverse" : "forward"))}`}
              title=${isClaw
                ? (dir < 0 ? (dead ? "already open — press CLOSE to take the joint back"
                                   : "one burst, parks itself — how far it opens is CLAW_OPEN_MS")
                           : "latches closed and holds — press again to let go")
                : "hold to jog — shift-click to name this direction"}
              ...${held}
              onContextMenu=${(e) => e.preventDefault()}>
              <span class="pad-glyph" aria-hidden="true">${glyph}</span>
              ${(labels[`${i}:${dir}`] || (isClaw && (dir < 0 ? "open" : "close"))) &&
                html`<small class="arm-lbl">${labels[`${i}:${dir}`] || (dir < 0 ? "open" : "close")}</small>`}
            </button>`;
          })}
        </div>`)}
      <div class="arm-row claw-nudge">
        <label>
          <span class="arm-name">nudge</span>
          <input type="range" min=${CLAW_FRAME_MS} max=${CLAW_NUDGE_MAX} step=${CLAW_FRAME_MS / 2}
            value=${nudge} disabled=${!enabled}
            title="how long one nudge drives — full power, so short IS small"
            onInput=${(e) => { const v = +e.target.value; setNudge(v); localStorage.setItem(CLAW_NUDGE_KEY, v); }} />
          <small class="claw-ms">${nudge}ms</small>
        </label>
        ${[["\u25c0", -100], ["\u25b6", 100]].map(([glyph, dir]) => html`
          <button type="button" key=${dir}
            class=${"pad-btn arm-btn" + (enabled ? "" : " is-off")}
            aria-disabled=${!enabled}
            aria-label=${`nudge gripper ${dir < 0 ? "open" : "closed"} ${nudge}ms`}
            title=${`one ${nudge}ms twitch ${dir < 0 ? "open" : "closed"} — for letting go without slamming the jaws`}
            onClick=${() => enabled && (clawNudge(dir, nudge, onCmd), setClaw(""))}>
            <span class="pad-glyph" aria-hidden="true">${glyph}</span>
            <small class="arm-lbl">${dir < 0 ? "open" : "close"}</small>
          </button>`)}
      </div>
      </div>
      <small class="drive-hint">${t("drive.armPad")}</small>
      ${ren && html`
        <dialog class="arm-ren" ref=${renRef} onClose=${() => setRen(null)}>
          <form onSubmit=${(e) => { e.preventDefault(); saveRen(e.target.elements.n.value); }}>
            <p class="arm-ren-t">set custom name — ${ARM_JOINTS[ren.i]} ${ren.dir < 0 ? "\u25c0" : "\u25b6"}</p>
            <input name="n" class="arm-ren-in" autoFocus maxLength="12" placeholder="open / close / up…"
              defaultValue=${labels[`${ren.i}:${ren.dir}`] || ""} />
            <div class="arm-ren-btns">
              <button type="button" class="chip" onClick=${() => saveRen("")}>CLEAR</button>
              <button type="button" class="chip" onClick=${() => setRen(null)}>CANCEL</button>
              <button type="submit" class="chip">SAVE</button>
            </div>
          </form>
        </dialog>`}
      <div class="arm-moves">
        ${Object.keys(moves).map((name) => {
          const j = armJogOf(moves[name]);
          return j ? html`
            <button type="button" key=${name}
              class=${"pad-btn arm-move" + (enabled ? "" : " is-off")}
              aria-disabled=${!enabled}
              title=${`hold to jog ${ARM_JOINTS[j[0]]}`}
              onPointerDown=${press(j[0], j[1])} onPointerUp=${release(j[0])}
              onPointerLeave=${release(j[0])} onPointerCancel=${release(j[0])}
              onContextMenu=${(e) => e.preventDefault()}>${name}</button>`
          : html`
            <button type="button" key=${name} class="pad-btn arm-move" disabled=${!enabled}
              title="recorded sequence — tap to replay"
              onClick=${() => enabled && armPlay(moves[name] || [], onCmd)}>${name}</button>`;
        })}
        <button type="button" class="pad-btn arm-move" disabled=${!enabled}
          title="clears the board's own travel count — needed after a board reset"
          onClick=${() => enabled && armRehome(onCmd)}>RE-HOME</button>
      </div>
    </div>`;
}

export { Arm };
