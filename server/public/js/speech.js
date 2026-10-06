// Sage's voice: server TTS (Deepgram/Edge) with the browser voice as fallback,
// plus the queue tapes speak through. Shared by the agent and the control side.
import { ttsVoice, speechLang, getLang } from "./i18n.js";

let voices = [];
const loadVoices = () => { voices = window.speechSynthesis?.getVoices() || []; };
loadVoices();
if (window.speechSynthesis) speechSynthesis.onvoiceschanged = loadVoices;
function browserSpeak(text, { onStart, onEnd } = {}) {
  if (!text || !window.speechSynthesis || !voices.length) { onEnd?.(); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const sl = speechLang();
  const pre = sl.slice(0, 2);
  u.rate = 1.08; u.lang = sl;   // a tape waits on every line now, so a slow read is dead air

  u.voice = voices.find(v => v.lang.startsWith(pre) && /samantha|alex|google|enhanced|jorge|alvaro|helena/i.test(v.name))
    || voices.find(v => v.lang.startsWith(pre)) || null;
  u.onstart = () => onStart?.();
  u.onend = () => onEnd?.();
  u.onerror = () => onEnd?.();
  speechSynthesis.speak(u);
}


const splitSpeech = (t) => (t.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [t]).map(s => s.trim()).filter(Boolean);

// Deepgram Aura has no speed parameter, so the Edge fallback's TTS_RATE (+12% SSML)
// has no counterpart there and she reads slow — a tape waits on every line now, so
// that is dead air. The knob is the player instead: playbackRate keeps pitch
// (preservesPitch defaults on), and it is only applied to deepgram or the Edge
// lines would be sped up twice. Bench knob — raise until she clips.
const TTS_PLAYBACK = 1.15;
const ttsUrl = (p) => "/api/tts?text=" + encodeURIComponent(p) + "&voice=" + encodeURIComponent(ttsVoice()) + "&provider=" + ttsProviderRef;

// A queued line only started fetching its audio once the line before it had
// finished speaking, so every gap in a tape carried a whole synth round trip as
// silence. Warming makes the request NOW and parks the element here; speak()
// takes it instead of building its own. A tape warms every scripted line the
// moment it starts, so the model turn at the head of a run pays for the rest.
// speakFlush() drops them: a killed run must not leave a run's worth of audio.
const ttsWarm = new Map();
function ttsPrewarm(text) {
  for (const part of splitSpeech(text || "")) {
    const u = ttsUrl(part);
    if (ttsWarm.has(u)) continue;
    const a = new Audio(u); a.preload = "auto"; a.load();
    ttsWarm.set(u, a);
  }
}

let ttsAudio = null;
let ttsToken = 0;
let ttsOnEnd = null;
let ttsProviderRef = "edge";
export const setTtsProvider = (p) => { ttsProviderRef = p; };

function stopSpeech() {
  ttsToken++;
  ttsAudio?.pause();
  window.speechSynthesis?.cancel();
  const cb = ttsOnEnd; ttsOnEnd = null; cb?.();
}
async function speak(text, { onStart, onEnd } = {}) {
  stopSpeech();
  const myToken = ttsToken;
  ttsOnEnd = onEnd;
  if (!text) { ttsOnEnd = null; onEnd?.(); return; }
  const parts = splitSpeech(text);
  const mk = (p) => { const u = ttsUrl(p); const a = ttsWarm.get(u) || new Audio(u); ttsWarm.delete(u); a.preload = "auto"; a.playbackRate = ttsProviderRef === "deepgram" ? TTS_PLAYBACK : 1; return a; };
  let started = false;
  const firstStart = () => { if (!started) { started = true; onStart?.(); } };
  let cur = mk(parts[0]);
  for (let i = 0; i < parts.length; i++) {
    if (myToken !== ttsToken) { cur?.pause(); return; }
    const a = cur;
    const next = i + 1 < parts.length ? mk(parts[i + 1]) : null;
    ttsAudio = a;
    try {
      await new Promise((resolve, reject) => {
        a.onended = resolve; a.onerror = reject;
        a.onplay = firstStart;
        a.play().catch(reject);
      });
    } catch {
      if (myToken !== ttsToken) return;
      browserSpeak(parts.slice(i).join(" "), { onStart: firstStart, onEnd });
      return;
    }
    cur = next;
  }
  if (myToken === ttsToken) { ttsOnEnd = null; onEnd?.(); }
}

// A tape's lines fire off a clock, and a clock has no idea how long a sentence
// takes to say — so speak()'s stopSpeech() made her talk over herself every time
// a line ran long. Queued lines wait their turn. A new operator turn still cuts
// in through speak() directly, and speakFlush() drops whatever has not started
// yet, so the panic key does not leave a sentence queued behind it.
let speakChain = Promise.resolve(), speakGen = 0;
const speakFlush = () => { speakGen++; speakChain = Promise.resolve(); ttsWarm.clear(); speakWake?.(); stopSpeech(); };
function speakQueued(text, opts) {
  const gen = speakGen;
  speakWake?.();                       // an @analyze step is waiting for exactly this
  speakChain = speakChain
    .then(() => gen === speakGen
      ? new Promise((res) => speak(text, { ...opts, onEnd: () => { opts?.onEnd?.(); res(); } }))
      : null)
    .catch(() => {});
  return speakChain;
}

// An "@analyze" step hands off to the model and has nothing to wait on yet — the
// line is spoken whenever it comes back, seconds later. So wait for the next
// sentence to be QUEUED (capped: a failed analysis never speaks at all), then
// for the queue to drain.
let speakWake = null;
function whenSpoken(capMs) {
  return new Promise((res) => {
    const to = setTimeout(res, capMs);
    speakWake = () => { clearTimeout(to); speakWake = null; res(); };
  }).then(() => speakChain);
}

function playOnboard(key, fallbackText, { onStart, onEnd } = {}) {
  ttsAudio?.pause();
  window.speechSynthesis?.cancel();
  const myToken = ++ttsToken;
  const a = new Audio(`/audio/onboard-${getLang()}-${key}.mp3`);
  ttsAudio = a;
  const fall = () => { if (myToken === ttsToken) speak(fallbackText, { onStart, onEnd }); };
  a.onplay = () => { if (myToken === ttsToken) onStart?.(); };
  a.onended = () => { if (myToken === ttsToken) onEnd?.(); };
  a.onerror = fall;
  a.play().catch(fall);
}

export { speak, speakQueued, speakFlush, stopSpeech, ttsPrewarm, whenSpoken, playOnboard };
