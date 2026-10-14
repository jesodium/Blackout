import { useEffect, useRef, useState } from "react";
import { GUARD_CM } from "../blk.mjs";
import { t } from "../i18n.js";
import { SageFace } from "../sageface.js";
import { ASK_SUGGESTIONS, Ask, Briefing } from "./briefing.js";
import { Icon, html } from "./core.js";
import { Head } from "./panels.js";
import { Stopwatch, assess, deriveIntent } from "./verdict.js";

// the BRAIN: CLAUDE pickers; src/sage/claude.js whitelists the same two lists
const CLAUDE_MODELS = ["haiku", "sonnet", "opus", "fable"];
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// ---- agent feed ----
const TOOLS = {
  camera:   { icon: "camera", label: "tool.camera",  of: "tool.lookAt" },
  armcam:   { icon: "camera", label: "tool.armcam",  of: "tool.lookAt" },
  sensors:  { icon: "timer",  label: "tool.sensors",  of: "tool.readingsOf" },
  snapshot: { icon: "step",   label: "tool.snapshot" },
  finding:  { icon: "warn",   label: "tool.finding" },
  lamp:     { icon: "gear",   label: "tool.lamp" },
  ask:      { icon: "mic",    label: "tool.ask" },
  analysis: { icon: "camera", label: "tool.analysis" },
};

// One card for every yes/no Sage puts in front of the operator: a drive move, an
// arm move, or a tool call waiting on CONSOLE -> ASK FIRST. Nothing happens until
// the operator presses it, and NO sends nothing at all.
function AskCard({ e, onAnswer }) {
  const st = e.state || "pending";
  return html`<div class=${"fl fl-move is-" + st}>
    <span class="fl-mark">◆</span>
    <div class="fl-body">
      <p class="fl-t">${e.title}</p>
      ${e.code ? html`<pre class="fl-code">${e.code}</pre>` : null}
      ${e.detail ? html`<p class="fl-detail">└ ${e.detail}</p>` : null}
      ${e.warn ? html`<p class="fl-detail fl-guard"><${Icon} n="warn" /> ${e.warn}</p>` : null}
      ${st === "pending" ? html`<div class="fl-btns">
        <button type="button" class="term-chip is-go" onClick=${() => onAnswer(e, true)}>▶ ${t(e.yes || "move.yes")} <i class="fl-pad">✕</i></button>
        <button type="button" class="term-chip" onClick=${() => onAnswer(e, false)}>${t(e.no || "move.no")} <i class="fl-pad">○</i></button>
      </div>` : html`<p class=${"fl-detail fl-st is-" + st}>└ ${t("move.st." + st)}${e.note ? ` · ${e.note}` : ""}</p>`}
    </div></div>`;
}

const ASK_KINDS = {
  move: (e) => ({
    title: t("move.asks"), code: e.text,
    detail: typeof e.board === "number" ? t("move.onBoard", { n: e.board }) : t("move.inBrowser", { why: e.board || "?" }),
    warn: e.guarded ? t("move.guarded", { n: e.guarded, cm: GUARD_CM }) : null,
  }),
  arm: (e) => ({ title: t("arm.asks"), code: e.text, detail: t("arm.steps", { n: e.tape.length }) }),
  tape: (e) => ({ title: t("tape.asks"), code: e.text, detail: t("tape.steps", { n: e.tape.length, s: Math.round(e.dur / 1000) }) }),
  confirm: (e) => ({
    title: t("confirm.asks", { what: t((TOOLS[e.name] || {}).label || "tool.unknown") }),
    detail: e.arg || null, yes: "confirm.yes", no: "confirm.no",
  }),
};

function FeedLine({ e, onAnswer }) {
  const fields = ASK_KINDS[e.kind];
  if (fields) return html`<${AskCard} e=${{ ...e, ...fields(e) }} onAnswer=${onAnswer} />`;
  if (e.kind === "tool") {
    const spec = TOOLS[e.name] || { icon: "gear", label: "tool.unknown" };

    const what = e.arg ? t(spec.of || "tool.of", { what: e.arg }) : t(spec.label);
    return html`<div class="fl fl-tool">
      <span class="fl-mark">◆</span>
      <div class="fl-body">
        <p class="fl-t">${t("tool.used")} <b><${Icon} n=${spec.icon} /> ${what}</b></p>
        ${e.detail ? html`<p class="fl-detail">└ ${e.detail}</p>` : null}
        ${e.img ? html`<img class="fl-shot" src=${e.img} alt=${what} loading="lazy" />` : null}
      </div></div>`;
  }
  if (e.kind === "user") return html`<div class="fl fl-user">
    <span class="fl-mark">›</span>
    <div class="fl-body"><p class="fl-t">${e.text}</p></div></div>`;
  if (e.kind === "note") return html`<div class="fl fl-note">
    <span class="fl-mark">·</span>
    <div class="fl-body"><p class="fl-t">${e.text}</p></div></div>`;
  return html`<div class=${"fl fl-sage" + (e.status ? " sage-" + e.status : "")}>
    <span class="fl-mark">●</span>
    <div class="fl-body">
      <p class="fl-t">${e.text}</p>
      ${e.timing ? html`<p class="fl-detail">${e.timing}</p>` : null}
    </div></div>`;
}

function Feed({ feed, ai, onAsk, onAnswer }) {
  const ref = useRef(null);
  useEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [feed.length, ai.analyzing, ai.text]);
  return html`
    <div class="term-feed" ref=${ref} role="log" aria-live="polite">
      ${feed.length === 0 ? html`
        <div class="term-hint">
          <p class="term-hint-t">${t("term.hint")}</p>
          ${ASK_SUGGESTIONS.slice(0, 3).map(q => html`<button key=${q} type="button" class="term-chip"
            onClick=${() => onAsk(t(q))}>${t(q)}</button>`)}
        </div>` : feed.map(e => html`<${FeedLine} key=${e.id} e=${e} onAnswer=${onAnswer} />`)}
      ${ai.analyzing ? html`<div class="fl fl-work">
        <span class="fl-mark">◐</span>
        <div class="fl-body"><p class="fl-t">${t(ai.phase === "speaking" ? "timing.synth" : "timing.thinking")}${" "}
          <b><${Stopwatch} since=${ai.since || Date.now()} /></b></p></div>
      </div>` : null}
    </div>`;
}

function Agent({ ai, tts, ttsProv, hasDeepgram, confirm, onConfirm, brain, onBrain, claudeModel, onModel, claudeEffort, onEffort, packet, connected, speaking, chats, activeChat, feed, onNewChat, onSelectChat, onDeleteChat, onBrief, onSpeak, onAnalyze, onToggleTts, onToggleTtsProvider, onMock, onAsk, onReport, onAnswer }) {
  const intent = deriveIntent(ai, packet, connected);
  const v = assess(packet);
  const briefed = activeChat && activeChat.mission;
  const claude = brain === "claude";
  const [draft, setDraft] = useState("");
  const send = (e) => {
    e.preventDefault();
    const txt = draft.trim();
    if (!txt || ai.analyzing) return;
    setDraft("");
    // /claude, /sage, /model <m>, /effort <e>: switch from the prompt line itself
    const [, cmd, arg] = txt.match(/^\/(claude|sage|model|effort)\s*(\S*)$/i) || [];
    if (cmd === "model" && CLAUDE_MODELS.includes(arg)) return onModel(arg);
    if (cmd === "effort" && CLAUDE_EFFORTS.includes(arg)) return onEffort(arg);
    if (cmd === "claude" || cmd === "sage") return onBrain(cmd);
    onAsk(txt);
  };
  return html`
    <section class=${"zone agent reveal is-" + intent.key + (ai.analyzing ? " is-analyzing" : "") + (speaking ? " is-speaking" : "")}
      style=${{ "--agent-c": intent.color }} aria-labelledby="agent-h">
      <${Head} title=${t("zone.agent")} tag=${t(ai.badge)} />
      <div class="agent-body">
        ${!activeChat
          ? html`<${ChatSelect} chats=${chats} onNew=${onNewChat} onSelect=${onSelectChat} onDelete=${onDeleteChat} />`
          : !briefed
          ? html`<${Briefing} onBrief=${onBrief} onBack=${() => onSelectChat("")} onSpeak=${onSpeak} busy=${ai.analyzing} />`
          : html`<div class="term">
        <div class="term-bar">
          <button type="button" class="term-back" onClick=${() => onSelectChat("")} title=${t("brief.sessions")}>←</button>
          <button type="button" class=${"term-brain is-" + brain} onClick=${() => onBrain()}
            aria-pressed=${claude} title=${t("brain.title")}>
            <span key=${brain}>${claude ? "CLAUDE" : "SAGE"}</span>
          </button>
          ${claude ? html`
            <select class="term-pick" value=${claudeModel} onChange=${e => onModel(e.target.value)} title=${t("brain.model")} aria-label=${t("brain.model")}>
              ${CLAUDE_MODELS.map(m => html`<option key=${m} value=${m}>${m}</option>`)}
            </select>
            <select class="term-pick" value=${claudeEffort} onChange=${e => onEffort(e.target.value)} title=${t("brain.effort")} aria-label=${t("brain.effort")}>
              ${CLAUDE_EFFORTS.map(v => html`<option key=${v} value=${v}>${v}</option>`)}
            </select>` : null}
          <span class="term-state">${t(intent.label)}</span>
          <span class=${"term-verdict is-" + v.kind} title=${v.cause}>${v.label}</span>
          ${""}
          ${claude ? null : html`<button type="button" class=${"term-perm is-" + (confirm ? "ask" : "bypass")}
            onClick=${onConfirm} aria-pressed=${!!confirm} title=${t("agent.permTitle")}>
            <${Icon} key=${confirm} n=${confirm ? "shield" : "shield-off"} />
            <span class="term-perm-t" key=${"t" + confirm}>${t(confirm ? "agent.permAsk" : "agent.permBypass")}</span>
          </button>`}
          <select class="agent-voice-sel" title=${t("agent.voiceTitle")} aria-label=${t("agent.voiceTitle")}
            value=${!tts ? "off" : (hasDeepgram && ttsProv === "deepgram" ? "deepgram" : "edge")}
            onChange=${e => {
              const val = e.target.value;
              if (val === "off") { if (tts) onToggleTts(); return; }
              if (!tts) onToggleTts();
              if (hasDeepgram && val !== ttsProv) onToggleTtsProvider();
            }}>
            <option value="off">${t("agent.voiceOff")}</option>
            <option value="edge">${t("agent.voiceEdge")}</option>
            ${hasDeepgram ? html`<option value="deepgram">${t("agent.voiceDg")}</option>` : null}
          </select>
        </div>
        ${""}
        <div class=${"term-hero" + (speaking ? " is-speaking" : "")}><${SageFace} mood=${intent.key} /></div>
        <${Feed} feed=${feed} ai=${ai} onAsk=${onAsk} onAnswer=${onAnswer} />
        <form class="agent-foot term-prompt" onSubmit=${send}>
          <input class="term-input" type="text" value=${draft} placeholder=${t(claude ? "brain.ph" : "term.ph")}
            aria-label=${t(claude ? "brain.ph" : "term.ph")} disabled=${ai.analyzing}
            onInput=${e => setDraft(e.target.value)} />
          <${Ask} onAsk=${onAsk} busy=${ai.analyzing} />
          ${""}
          <details class="foot-menu" onBlur=${e => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.open = false; }}>
            <summary class="btn foot-icon" title=${t("agent.more")} aria-label=${t("agent.more")}>⋯</summary>
            <div class="foot-menu-pop" onClick=${e => { e.currentTarget.closest("details").open = false; }}>
              <span class="menu-label">${t("agent.actions")}</span>
              <button class="menu-item is-lead" type="button" onClick=${() => onAnalyze()} disabled=${ai.analyzing}>
                <${Icon} n="camera" /> ${ai.analyzing ? t("agent.analyzing") : t("agent.runAnalysis")}
              </button>
              <button class="menu-item" type="button" onClick=${onMock} disabled=${ai.analyzing} title=${t("agent.mockTitle")}>
                ${t("agent.mock")}
              </button>
              <button class="menu-item" type="button" onClick=${onReport} title=${t("agent.reportTitle")}>
                ${t("agent.report")}
              </button>
              <hr class="menu-sep" />
              <span class="menu-label">${t("ask.pick")}</span>
              ${ASK_SUGGESTIONS.map(q => html`<button key=${q} class="menu-item" type="button"
                onClick=${() => onAsk(t(q))} disabled=${ai.analyzing}>${t(q)}</button>`)}
            </div>
          </details>
        </form>
      </div>`}
      </div>
    </section>`;
}

function ChatSelect({ chats, onNew, onSelect, onDelete }) {
  return html`
    <div class="chat-select">
      <div class="mission-head"><span class="mission-k">${t("chat.sessions")}</span></div>
      ${chats.length === 0
        ? html`<p class="chat-empty">${t("chat.empty")}</p>`
        : html`<div class="chat-list">
            ${chats.slice().reverse().map((c, i) => html`
              <div key=${c.id} class="chat-item">
                <button type="button" class="chat-item-main" onClick=${() => onSelect(c.id)}>
                  <span class="chat-item-title">${c.title || t("chat.untitled")}</span>
                  <span class="chat-item-sub">${c.mission ? t("chat.briefed") : t("chat.notBriefed")}</span>
                </button>
                <button type="button" class="chat-del" onClick=${() => onDelete(c.id)} title=${t("chat.delete")} aria-label=${t("chat.delete")}>×</button>
              </div>`)}
          </div>`}
      <button type="button" class="btn btn--primary chat-new" onClick=${onNew}>${t("chat.new")}</button>
    </div>`;
}

export { ASK_KINDS, Agent, FeedLine };
