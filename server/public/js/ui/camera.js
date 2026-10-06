import React, { useCallback, useEffect, useRef, useState } from "react";
import { CAM_ROT_DEFAULT, ROTS, norm as camNorm, detectUpright, drawBoxes, loadDetector } from "../detect.mjs";
import { t } from "../i18n.js";
import { mjpegSplit } from "../mjpeg.mjs";
import { CAM_DEFAULTS, TUNNEL, camHost, camKey, camUrl, html, nextCamHost } from "./core.js";

// ---- camera ----
const CAM_PICKS = [
  ["wb_mode", [[0, "auto"], [1, "sunny"], [2, "cloudy"], [3, "office"], [4, "home"]]],
  ["framesize", [[8, "SVGA 800×600"], [6, "VGA 640×480"], [5, "CIF 400×296"], [4, "QVGA 320×240"]]],
];

const STALL_MS = 5000;
// The newest bytes off each feed, so the server can borrow one for Sage instead of
// opening a second stream the cam can't serve (setFrameSource in vision.js). Lives
// outside CamView for the same reason armLedger does -- the component unmounts on
// every tab switch. Stamped, so a stalled feed answers nothing rather than handing
// her a frozen frame to report on.
const camFrames = [];
const FRAME_LEND_MS = 2000;

const DET_MS = 100;
const DET_MIN_SCORE = 0.5;

function CamView({ cam = 0, pip = false, onSwap }) {
  const [state, setState] = useState("loading");
  const [nonce, setNonce] = useState(0);
  const [host, setHost] = useState(camHost(cam));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [detect, setDetect] = useState(() => localStorage.getItem("camDetect") === "1");
  const [detState, setDetState] = useState("off");
  // Mount angle, kept per rig. It drives three things at once: the css transform on
  // the feed, the frame detect.mjs hands the model, and the still Sage is shown --
  // flip the cam and rotate only the picture and her vision quietly goes sideways.
  const [rot, setRot] = useState(() => camNorm(Number(localStorage.getItem(camKey("camRot", cam)) ?? CAM_ROT_DEFAULT)));

  const [sliders, setSliders] = useState({ brightness: -1, contrast: -1, saturation: 0, ae_level: 0, led: 15 });
  const [picks, setPicks] = useState({ wb_mode: 0, framesize: 8 });
  const imgRef = useRef(null);
  const boxRef = useRef(null);

  useEffect(() => {
    const on = (e) => setSliders(p => (p.led === e.detail ? p : { ...p, led: e.detail }));
    window.addEventListener("cam-led", on);
    return () => window.removeEventListener("cam-led", on);
  }, []);

  // Discovery only, and only with nothing saved yet: ask our own /capture whether
  // a cam is on the cable before the wifi list gets walked. That walk is 5s a
  // host, so a serial-only rig would sit red for half a minute on a cam that is
  // plugged in. A rig with no cable gets an instant 503 and nothing changes.
  useEffect(() => {
    if (TUNNEL || cam || localStorage.getItem(camKey("camHost", cam))) return;
    fetch("/capture", { cache: "no-store" })
      .then((r) => { if (r.ok) setHost(location.host); })
      .catch(() => {});
  }, []);

  const fail = useCallback(() => setState("offline"), []);
  const lastFrame = useRef(0);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const ctl = new AbortController();

    lastFrame.current = Date.now();
    let alive = true, shown = null, first = true;
    const paint = (bytes) => {
      const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
      img.src = url;
      if (shown) URL.revokeObjectURL(shown);
      shown = url;
      lastFrame.current = Date.now();
      camFrames[cam] = { bytes, at: lastFrame.current };
      if (first) {
        first = false;
        setState("live");
        localStorage.setItem(camKey("camHost", cam), host);
        forceAwbRef.current();
      }
    };
    (async () => {
      try {
        const res = await fetch(TUNNEL ? `/relay/${cam}/stream` : camUrl(host), { signal: ctl.signal, cache: "no-store" });
        if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
        const reader = res.body.getReader();
        let buf = new Uint8Array(0);
        while (alive) {
          const { done, value } = await reader.read();
          if (done) break;
          const next = new Uint8Array(buf.length + value.length);
          next.set(buf); next.set(value, buf.length);
          buf = next;
          const cut = mjpegSplit(buf);
          for (const f of cut.frames) paint(f);
          buf = cut.rest;
        }
        if (alive) throw new Error("stream ended");
      } catch (err) {
        if (alive && err.name !== "AbortError") setState("offline");
      }
    })();
    return () => { alive = false; ctl.abort(); if (shown) URL.revokeObjectURL(shown); };
  }, [nonce, host]);

  // one detector, on whichever feed is big: the pip is for lining the gripper up
  // by eye, and a second model doubles 25ms/frame on webgl but 280ms on the cpu
  // fallback, which is past the feed's own ~10fps.
  const canDetect = detect && !pip;
  useEffect(() => {
    if (!canDetect || state !== "live") { setDetState("off"); return; }
    let alive = true, model = null, busy = false;
    setDetState("loading");
    loadDetector().then((m) => { if (alive) { model = m; setDetState("on"); } })
      .catch(() => { if (alive) setDetState("failed"); });
    const id = setInterval(async () => {
      const img = imgRef.current, cv = boxRef.current;
      if (!model || busy || !img || !cv || !img.naturalWidth) return;
      busy = true;
      try {
        const boxes = await detectUpright(model, img, 20, DET_MIN_SCORE, rot);
        if (!alive) return;
        if (cv.width !== img.naturalWidth) { cv.width = img.naturalWidth; cv.height = img.naturalHeight; }
        drawBoxes(cv.getContext("2d"), boxes, cv.width, cv.height, rot);
      } catch {  }
      finally { busy = false; }
    }, DET_MS);
    return () => { alive = false; clearInterval(id); };
  }, [canDetect, state, rot]);

  useEffect(() => {
    if (state !== "live") return;
    const id = setInterval(() => {
      if (Date.now() - lastFrame.current > STALL_MS) setNonce(n => n + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [state]);

  useEffect(() => {
    if (state !== "loading") return;
    const id = setTimeout(fail, 12000);
    return () => clearTimeout(id);
  }, [state, nonce, host, fail]);

  useEffect(() => {
    if (state !== "offline") return;
    const id = setTimeout(() => {
      setHost(h => nextCamHost(cam, h));
      setState("loading"); setNonce(n => n + 1);
    }, 5000);
    return () => clearTimeout(id);
  }, [state, cam]);

  const base = camUrl(host);

  const applyHost = (v) => {
    const h = v.trim() || CAM_DEFAULTS[cam];
    localStorage.setItem(camKey("camHost", cam), h);
    setHost(h); setState("loading"); setNonce(n => n + 1);
  };

  const ctrl = (varName, val) => {
    setSliders(p => ({ ...p, [varName]: val }));
    fetch(`http://${host}/control?var=${varName}&val=${val}`).catch(() => {});

    if (varName === "led") fetch("/api/led", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: val }) }).catch(() => {});
  };

  const forceAwb = () => {
    for (const [k, v] of [["whitebal", 1], ["awb_gain", 1], ["wb_mode", picks.wb_mode]])
      fetch(`http://${host}/control?var=${k}&val=${v}`).catch(() => {});
  };

  const forceAwbRef = useRef(forceAwb);
  forceAwbRef.current = forceAwb;

  const turn = () => {
    const v = ROTS[(ROTS.indexOf(rot) + 1) % ROTS.length];
    setRot(v);
    localStorage.setItem(camKey("camRot", cam), v);
  };

  // Sage grabs her own stills server-side, so the angle has to go with it -- for
  // both cams now that she can ask for the gripper view. Posting it without the
  // cam index is exactly how her vision goes sideways. It rides on MOUNT and not
  // just on the button: the angle is per rig in localStorage, the server's is a
  // process-lifetime default (CAM_ROTATE), so after any reload or server restart
  // the two disagreed until somebody happened to press ROTATE -- the feed looked
  // right and every still she read, and every one shown in the transcript, was
  // 90deg off.
  useEffect(() => {
    fetch("/api/cam-rot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: rot, cam }) }).catch(() => {});
  }, [rot, cam]);

  const pick = (varName, val) => {
    setPicks(p => ({ ...p, [varName]: val }));
    fetch(`http://${host}/control?var=${varName}&val=${val}`)
      .then(() => { if (varName === "framesize") forceAwb(); })
      .catch(() => {});
  };

  return html`
    <div class=${"stage-view stage-view--cam" + (pip ? " is-pip" : "")}>
      ${state !== "offline"
        ? html`<${React.Fragment}>
            <img ref=${imgRef} alt="" class="cam-feed" style=${{ "--cam-rot": rot + "deg" }} />
            ${canDetect ? html`<canvas ref=${boxRef} class="cam-feed cam-boxes" aria-hidden="true" style=${{ "--cam-rot": rot + "deg" }} />` : null}
          <//>`
        : html`<div class="viewport-fallback">${t("cam.offline")}<br/>
            <small>${base}</small><br/>
            <input type="text" class="cam-host" defaultValue=${host} aria-label=${t("zone.camera")}
              placeholder=${CAM_DEFAULTS[cam]}
              onKeyDown=${(e) => { if (e.key === "Enter") applyHost(e.target.value); }}
              onBlur=${(e) => applyHost(e.target.value)} /><br/>
            <button type="button" class="btn" onClick=${() => { setState("loading"); setNonce(n => n + 1); }}>${t("cam.retry")}</button>
          </div>`}
      <span class="stage-chip">${t("cam.tag." + state)}</span>
      ${pip ? html`<button type="button" class="cam-swap" onClick=${onSwap}
        title=${t("cam.swap")} aria-label=${t("cam.swap")}></button>` : null}
      ${state === "live" && !pip ? html`
        <div class="cam-tools">
          <button type="button" class=${"hud-btn" + (detect ? " is-active" : "")} aria-pressed=${detect}
            onClick=${() => { const v = !detect; setDetect(v); localStorage.setItem("camDetect", v ? "1" : "0"); }}>
            ${t("cam.detect")}${detect && detState !== "on" ? " · " + t("cam.detect." + detState) : ""}</button>
          <button type="button" class="hud-btn" onClick=${turn}
            title=${t("cam.rotate")}>${t("cam.rotate")} · ${rot}°</button>
          <button type="button" class="hud-btn" aria-expanded=${settingsOpen}
            onClick=${() => setSettingsOpen(o => !o)}>${t("cam.settings")}</button>
          ${settingsOpen ? html`
            <div class="cam-pop">
              ${CAM_PICKS.map(([k, opts]) => html`
                <label key=${k} class="cam-pick">
                  <span>${k}</span>
                  <select value=${picks[k]} onChange=${(e) => pick(k, parseInt(e.target.value))}>
                    ${opts.map(([v, label]) => html`<option key=${v} value=${v}>${label}</option>`)}
                  </select>
                </label>`)}
              ${[["brightness", -2, 2], ["contrast", -2, 2], ["saturation", -2, 2], ["ae_level", -2, 2], ["led", 0, 255]].map(([k, min, max]) => html`
                <label key=${k} class="cam-slider">
                  <span class="cam-slider-row"><span>${k}</span><b>${sliders[k]}</b></span>
                  <input type="range" min=${min} max=${max} step="1" value=${sliders[k]}
                    onInput=${(e) => ctrl(k, parseInt(e.target.value))} />
                </label>`)}
            </div>` : null}
        </div>` : null}
    </div>`;
}

// Both feeds run at once -- the arm cam is for lining the gripper up, which you do
// while driving. The two CamViews stay mounted in a fixed order and only swap a
// class: keying them on which one is big would tear down and reopen both streams
// on every tap, and a reopened stream is ~12s of "loading".
function CamStage() {
  const [main, setMain] = useState(() => Number(localStorage.getItem("camMain")) || 0);
  const swap = (cam) => { setMain(cam); localStorage.setItem("camMain", String(cam)); };
  return html`
    <${React.Fragment}>
      ${[0, 1].map(cam => html`
        <${CamView} key=${cam} cam=${cam} pip=${cam !== main} onSwap=${() => swap(cam)} />`)}
    <//>`;
}

export { CamStage, CamView, FRAME_LEND_MS, camFrames };
