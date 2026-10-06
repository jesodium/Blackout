import { useCallback, useEffect, useRef, useState } from "react";
import { ONBOARDING, getLang, speechLang, t } from "../i18n.js";
import { SageFace } from "../sageface.js";
import { stopSpeech } from "../speech.js";
import { Icon, html } from "./core.js";

// ---- mic ----
const canMic = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
const MIC_MAX_MS = 15000;

const SIL_MS = 2000, SIL_RMS = 0.02;
// full-scale for the meter — speech peaks around 0.2 rms, so a bar that only fills
// at 1.0 never moves. Bench knob: raise it if the meter pins on a loud room.
const LVL_FULL = 0.25;

function useMic(onText) {
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState(false);
  const recRef = useRef(null);
  // the level meter is a css var written straight onto the button, never state:
  // the fpv mic's hook lives at the app root, and a 10Hz setState there re-renders
  // the whole dashboard to move a 2px bar.
  const btnRef = useRef(null);
  const toggle = useCallback(async () => {
    if (recRef.current) { recRef.current.stop(); return; }
    stopSpeech();
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { console.warn("[mic]", e.name, e.message); return; }
    const rec = new MediaRecorder(stream);
    const parts = [];
    let stopWatch = () => {};
    rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    rec.onstop = async () => {
      stopWatch();
      stream.getTracks().forEach((tr) => tr.stop());
      recRef.current = null; setListening(false); setHeard(false);
      const blob = new Blob(parts, { type: rec.mimeType });
      if (blob.size < 2000) return;
      try {
        const r = await fetch(`/api/stt?lang=${speechLang()}`, {
          method: "POST", headers: { "Content-Type": blob.type }, body: blob,
        });
        const j = await r.json().catch(() => ({}));
        if (j.text) onText(j.text); else console.warn("[mic]", j.error || "no speech");
      } catch (e) { console.warn("[mic]", e.message); }
    };

    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const an = ac.createAnalyser(); an.fftSize = 512;
    ac.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    // the silence cut is only armed once speech has actually been heard: counting
    // from mic-open cut the operator off during their own reaction time (~2s), which
    // is why a press-talk-press cycle worked and press-talk did not. MIC_MAX_MS is
    // what bounds a press with nobody speaking.
    let loudAt = 0;
    const tick = setInterval(() => {
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) { const d = (v - 128) / 128; sum += d * d; }
      const rms = Math.sqrt(sum / buf.length);
      btnRef.current?.style.setProperty("--lvl", Math.min(1, rms / LVL_FULL).toFixed(2));
      if (rms > SIL_RMS) { if (!loudAt) setHeard(true); loudAt = Date.now(); }
      if (loudAt && Date.now() - loudAt > SIL_MS && rec.state === "recording") rec.stop();
    }, 100);
    stopWatch = () => {
      clearInterval(tick); ac.close().catch(() => {});
      btnRef.current?.style.removeProperty("--lvl");
    };

    recRef.current = rec; setListening(true); setHeard(false); rec.start();
    setTimeout(() => { if (rec.state === "recording") rec.stop(); }, MIC_MAX_MS);
  }, [onText]);
  return { listening, heard, toggle, btnRef, supported: canMic };
}

// ---- briefing ----
const BRIEF_STEPS = [
  { key: "objective",   clip: "q0", label: "brief.objLabel",   q: "brief.objQ",   ph: "brief.objPh" },
  { key: "environment", clip: "q1", label: "brief.envLabel",   q: "brief.envQ",   ph: "brief.envPh" },
  { key: "watch",       clip: "q2", label: "brief.watchLabel", q: "brief.watchQ", ph: "brief.watchPh" },
];

function Briefing({ onBrief, onBack, onSpeak, busy }) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState({});
  const review = step >= BRIEF_STEPS.length;
  const cur = BRIEF_STEPS[step];
  const setCur = (val) => setAnswers(a => ({ ...a, [cur.key]: val }));
  const mic = useMic((txt) => setAnswers(a => {
    const k = BRIEF_STEPS[step]?.key; if (!k) return a;
    return { ...a, [k]: (a[k] ? a[k] + " " : "") + txt };
  }));
  const curVal = (answers[cur?.key] || "");
  const next = () => { if (curVal.trim()) setStep(s => s + 1); };
  const start = () => onBrief(BRIEF_STEPS.map(s => `${t(s.label)}: ${answers[s.key] || "—"}`).join("\n"));

  useEffect(() => {
    if (review) {
      onSpeak?.([{ clip: "rundown", text: ONBOARDING[getLang()].rundown }]);
      return;
    }
    const s = BRIEF_STEPS[step];
    const q = { clip: s.clip, text: t(s.q) };
    onSpeak?.(step === 0 ? [{ clip: "intro", text: ONBOARDING[getLang()].intro }, q] : [q]);
  }, [step]);

  const dots = html`<div class="brief-dots" aria-hidden="true">
    ${BRIEF_STEPS.map((s, i) => html`<span key=${s.key}
      class=${"brief-dot" + (i === step ? " is-active" : "") + (i < step || review ? " is-done" : "")}></span>`)}
    <span class=${"brief-dot" + (review ? " is-active" : "")}></span>
  </div>`;

  if (review) {
    return html`
      <div class="briefing">
        <button type="button" class="brief-back" onClick=${() => setStep(BRIEF_STEPS.length - 1)}>${t("brief.back")}</button>
        ${dots}
        <div class="brief-orb is-happy"><${SageFace} mood="clear" /></div>
        <div class="brief-step" key="review">
          <p class="brief-greeting">${t("brief.rundown")}</p>
          <div class="brief-summary">
            ${BRIEF_STEPS.map((s, i) => html`<div key=${s.key} class="brief-sum-row" style=${{ animationDelay: (i * 70) + "ms" }}>
              <span class="brief-sum-k">${t(s.label)}</span>
              <span class="brief-sum-v">${answers[s.key] || "—"}</span>
            </div>`)}
          </div>
          <button type="button" class="btn btn--primary btn--go" onClick=${start} disabled=${busy}>
            ${busy ? t("brief.heading") : t("brief.start")}
          </button>
        </div>
      </div>`;
  }

  return html`
    <div class="briefing">
      <button type="button" class="brief-back" onClick=${step === 0 ? onBack : () => setStep(s => s - 1)}>
        ${step === 0 ? t("brief.sessions") : t("brief.back")}
      </button>
      ${dots}
      <div class="brief-orb"><${SageFace} mood="scanning" /></div>
      ${step === 0 ? html`<p class="brief-greeting">${ONBOARDING[getLang()].intro}</p>` : null}
      <div class="brief-step" key=${step}>
        <div class="brief-step-k">${t("brief.stepOf", { n: step + 1, total: BRIEF_STEPS.length, label: t(cur.label) })}</div>
        <p class="brief-q">${t(cur.q)}</p>
        <div class="brief-field">
          <textarea class="mission-input" rows="3" placeholder=${t(cur.ph)}
            value=${curVal} onInput=${e => setCur(e.target.value)} disabled=${busy} autoFocus
            onKeyDown=${e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) next(); }}></textarea>
          ${mic.supported ? html`<button type="button" ref=${mic.btnRef} class=${"ask-mic brief-mic" + (mic.listening ? " is-live" : "") + (mic.heard ? " is-heard" : "")}
            onClick=${mic.toggle} disabled=${busy} aria-pressed=${mic.listening}>
            <${Icon} n="mic" /> ${!mic.listening ? t("brief.speak") : mic.heard ? t("brief.heard") : t("brief.listening")}</button>` : null}
        </div>
        <button type="button" class="btn btn--primary" onClick=${next} disabled=${busy || !curVal.trim()}>
          ${step === BRIEF_STEPS.length - 1 ? t("brief.review") : t("brief.next")}
        </button>
      </div>
    </div>`;
}

const ASK_SUGGESTIONS = ["ask.s0", "ask.s1", "ask.s2", "ask.s3", "ask.s4"];
function Ask({ onAsk, busy }) {
  const mic = useMic(onAsk);
  if (!mic.supported) return null;
  return html`<button type="button" ref=${mic.btnRef} class=${"btn foot-icon ask-mic" + (mic.listening ? " is-live" : "") + (mic.heard ? " is-heard" : "")} onClick=${mic.toggle}
    disabled=${busy} aria-pressed=${mic.listening} title=${t("ask.mic")} aria-label=${t("ask.mic")}>
    ${mic.listening ? "●" : html`<${Icon} n="mic" />`}</button>`;
}

export { ASK_SUGGESTIONS, Ask, Briefing, useMic };
