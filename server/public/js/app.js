import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { compile as blkCompile, guard as blkGuard, parse as blkParse, serialize as blkSerialize } from "./blk.mjs";
import { armLedger, armPlay, panicStop, playBlk, tapePlay, tapeWatch } from "./control.js";
import { getLang, setLang, t } from "./i18n.js";
import { initPadNav } from "./padnav.mjs";
import { playOnboard, setTtsProvider, speak, speakQueued, stopSpeech } from "./speech.js";
import { ASK_KINDS, Agent, FeedLine } from "./ui/agent.js";
import { useMic } from "./ui/briefing.js";
import { FRAME_LEND_MS, camFrames } from "./ui/camera.js";
import { driveMs, matchCmd, norm } from "./ui/commands.js";
import { FINDINGS, Icon, NO_FEED, PKT_STALE_MS, VIEWER, anaCam, bandOf, html } from "./ui/core.js";
import { Drawer, Options } from "./ui/drawer.js";
import { Drive } from "./ui/drive.js";
import { FPV_ZOOMS, FpvOverlay, FpvSage } from "./ui/fpv.js";
import { JudgeView, SensorStrip } from "./ui/judge.js";
import { appendLog } from "./ui/logs.js";
import { BlePickerModal, DevicesModal, Toasts, mcpWhat } from "./ui/modals.js";
import { CamBox, ThreeDeeBox } from "./ui/panels.js";
import { Replay, ReplayList } from "./ui/replay.js";
import { ReportModal, buildReport } from "./ui/report.js";
import { Split } from "./ui/split.js";
import { Topbar } from "./ui/topbar.js";
import { UpdateBar, UpdateModal } from "./ui/update.js";

// ---- app ----
function App() {
  const [connected, setConnected] = useState(false);
  const [packet, setPacket] = useState(null);
  const [fresh, setFresh] = useState(false);
  const lastPkt = useRef(0);
  const [ping, setPing] = useState("—");
  const [packets, setPackets] = useState(0);
  const [logs, setLogs] = useState([]);
  const [ai, setAi] = useState({ text: t("ai.awaiting"), badge: "badge.standby", analyzing: false, history: [], phase: null, since: 0, llm: null, tts: null, status: null });

  const analyzingRef = useRef(false);
  const analyzeAppRef = useRef(null);   // analyze() is declared below the socket effect that needs it
  analyzingRef.current = ai.analyzing;
  const presentingRef = useRef(false);
  const [tts, setTts] = useState(() => localStorage.getItem("tts") !== "false");
  const [ttsProv, setTtsProv] = useState(() => localStorage.getItem("ttsProvider") || "edge");
  const [hasDeepgram, setHasDeepgram] = useState(false);
  const [lang, setLangState] = useState(getLang());
  const [bridge, setBridge] = useState({ running: false, busy: false });
  const [toasts, setToasts] = useState([]);
  const [uptime, setUptime] = useState("00:00:00");
  const [lanUrl, setLanUrl] = useState(null);
  const [lanIp, setLanIp] = useState(null);
  const [serialLines, setSerialLines] = useState([]);
  const [drawer, setDrawer] = useState(false);
  const [drawerTab, setDrawerTab] = useState("logs");
  const [warn, setWarn] = useState(false);
  const [warnCount, setWarnCount] = useState(3);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [flashPhase, setFlashPhase] = useState("choose");
  const [flashBoards, setFlashBoards] = useState({ giga: false, esp32cam: false, unor4: false, status: "none" });
  const [flashLog, setFlashLog] = useState("");
  const [flashCode, setFlashCode] = useState(null);
  const [speaking, setSpeaking] = useState(false);
  const [fpv, setFpv] = useState(false);
  const [fpvZoom, setFpvZoom] = useState(0);
  const [rec, setRec] = useState(null);
  const [runs, setRuns] = useState(null);
  const [replay, setReplay] = useState(null);
  const [recErr, setRecErr] = useState(null);
  const [report, setReport] = useState(null);
  const [reportClosing, setReportClosing] = useState(false);
  const [clients, setClients] = useState([]);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [detect, setDetect] = useState(() => localStorage.getItem("camDetect") === "1");
  const [detState, setDetState] = useState("off");

  const [granted, setGranted] = useState(!VIEWER);

  const [judge, setJudge] = useState(false);
  const [cloud, setCloud] = useState(null);
  const [mcp, setMcp] = useState(null);   // last MCP call (server/mcp.mjs) -- lights the topbar pill
  useEffect(() => { fetch("/api/mcp").then(r => r.json()).then(setMcp).catch(() => {}); }, []);
  const grantedRef = useRef(!VIEWER);
  grantedRef.current = granted;
  const canDrive = granted && !!bridge.running;

  const [driveMounted, setDriveMounted] = useState(!VIEWER);
  useEffect(() => {
    if (granted) { setDriveMounted(true); return; }
    const id = setTimeout(() => setDriveMounted(false), 260);
    return () => clearTimeout(id);
  }, [granted]);

  const [chats, setChats] = useState(() => { try { return JSON.parse(localStorage.getItem("chats") || "[]"); } catch { return []; } });
  const [activeId, setActiveId] = useState(() => localStorage.getItem("activeChat") || "");
  const activeChat = chats.find(c => c.id === activeId) || null;
  const activeRef = useRef(null);
  useEffect(() => { activeRef.current = activeChat; }, [activeChat]);

  const pushFeed = useCallback((e) => {
    const chat = activeRef.current;
    if (!chat) return;
    const item = { id: Date.now() + Math.random(), time: new Date().toLocaleTimeString(), ...e };
    setChats(cs => cs.map(c => c.id === chat.id ? { ...c, feed: [...(c.feed || []), item].slice(-80) } : c));
    socketRef.current?.emit("feed", item);
    return item.id;
  }, []);

  // A tape's spoken line is Sage talking, so it goes in the transcript as an
  // ordinary ● row — the log is for the machinery (@log), not for her voice.
  const sayFeed = useCallback((line) => { pushFeed({ text: line }); }, [pushFeed]);

  const patchFeed = useCallback((id, patch) => {
    const chat = activeRef.current;
    if (!chat) return;
    setChats(cs => cs.map(c => c.id === chat.id
      ? { ...c, feed: (c.feed || []).map(f => f.id === id ? { ...f, ...patch } : f) } : c));
    socketRef.current?.emit("feed", { id, patch });
  }, []);

  const [confirm, setConfirm] = useState(() => localStorage.getItem("sageConfirm") !== "false");
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;
  const toggleConfirm = useCallback(() => setConfirm(c => { localStorage.setItem("sageConfirm", String(!c)); return !c; }), []);

  const [moves, setMoves] = useState(() => localStorage.getItem("sageMoves") !== "false");
  const movesRef = useRef(moves);
  movesRef.current = moves;
  const toggleMoves = useCallback(() => setMoves(m => { localStorage.setItem("sageMoves", String(!m)); return !m; }), []);

  // OPTIONS -> BRAIN: "sage" is Cerebras through /api/chat, "claude" is headless
  // Claude Code with the whole PC plus the rover's MCP tools (src/sage/claude.js).
  const [brain, setBrain] = useState(() => localStorage.getItem("brain") === "claude" ? "claude" : "sage");
  const brainRef = useRef(brain);
  brainRef.current = brain;
  const [claudeModel, setClaudeModel] = useState(() => localStorage.getItem("claudeModel") || "haiku");
  const [claudeEffort, setClaudeEffort] = useState(() => localStorage.getItem("claudeEffort") || "low");
  const claudeOpts = useRef({});
  claudeOpts.current = { model: claudeModel, effort: claudeEffort };
  const pickModel = useCallback((m) => { localStorage.setItem("claudeModel", m); setClaudeModel(m); }, []);
  const pickEffort = useCallback((e) => { localStorage.setItem("claudeEffort", e); setClaudeEffort(e); }, []);
  const toggleBrain = useCallback((to) => {
    const n = to === "claude" || to === "sage" ? to : brainRef.current === "claude" ? "sage" : "claude";
    if (n === brainRef.current) return;
    localStorage.setItem("brain", n);
    setBrain(n);
    pushFeed({ kind: "note", text: t(n === "claude" ? "brain.toClaude" : "brain.toSage") });
  }, [pushFeed]);

  // SAGE LAMP off (the default) means she never writes the headlamp on her own —
  // asking her for it in words still works, the server reads that off the turn.
  const [lamp, setLamp] = useState(() => localStorage.getItem("sageLamp") !== "false");
  const lampRef = useRef(lamp);
  lampRef.current = lamp;
  const toggleLamp = useCallback(() => setLamp(l => { localStorage.setItem("sageLamp", String(!l)); return !l; }), []);
  // CONSOLE -> DEMO: interview mode -- names what it's shown, answers hardware
  // questions, no cave drama. Rides on /api/chat and request-analysis.
  const [demo, setDemo] = useState(() => localStorage.getItem("sageDemo") === "true");
  const demoRef = useRef(demo);
  demoRef.current = demo;
  const toggleDemo = useCallback(() => setDemo(d => { localStorage.setItem("sageDemo", String(!d)); return !d; }), []);
  useEffect(() => { localStorage.setItem("chats", JSON.stringify(chats)); }, [chats]);
  useEffect(() => { localStorage.setItem("activeChat", activeId); }, [activeId]);
  useEffect(() => { localStorage.setItem("ttsProvider", ttsProv); setTtsProvider(ttsProv); }, [ttsProv]);
  useEffect(() => {
    fetch("/api/tts/providers").then(r => r.json()).then(d => {
      setHasDeepgram(d.deepgram);
      if (!d.deepgram) setTtsProv("edge");
    }).catch(() => {});
  }, []);

  // what the judge tablet shows: the host's transcript, relayed. Own state because
  // chats live in the host's localStorage and never reach another browser.
  const [mirrorFeed, setMirrorFeed] = useState([]);

  const socketRef = useRef(null);
  const ttsRef = useRef(localStorage.getItem("tts") !== "false");
  const lastObstacle = useRef(0);
  const lastDist = useRef(0);
  const lastBands = useRef({});
  useEffect(() => { lastBands.current = {}; }, [activeId]);

  const packetRef = useRef(null);

  useEffect(() => {
    const id = setInterval(() => setFresh(Date.now() - lastPkt.current < PKT_STALE_MS), 1000);
    return () => clearInterval(id);
  }, []);
  const view = fresh ? packet : null;
  const live = connected && fresh;
  useEffect(() => { packetRef.current = view; }, [view]);

  const addLog = useCallback((text, type = "system") => {
    setLogs(p => [...p, { text, type, time: new Date().toLocaleTimeString(), id: Date.now() + Math.random() }].slice(-80));
  }, []);
  const toast = useCallback((msg, kind = "system") => {
    const id = Date.now() + Math.random();
    setToasts(p => [...p, { msg, kind, id }]);
    setTimeout(() => setToasts(p => p.map(t => t.id === id ? { ...t, leaving: true } : t)), 3600);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 3820);
  }, []);

  const speakTimed = useCallback((text) => {
    const t = Date.now();
    setAi(p => ({ ...p, phase: "speaking", since: t, tts: null }));
    // Mid-tape her analysis lands in the queue with the scripted lines — speak()
    // opens with stopSpeech(), so it used to cut whatever the run was saying.
    // Off a tape a new turn still cuts in, which is the interruption we want.
    (armLedger.tapeOn ? speakQueued : speak)(text, {
      onStart: () => { setSpeaking(true); setAi(p => ({ ...p, phase: null, tts: Date.now() - t })); },
      onEnd: () => { setSpeaking(false); },
    });
  }, []);

  // ---- socket ----
  useEffect(() => {
    const socket = window.io();
    socketRef.current = socket;

    function recordFindings(d) {
      const chat = activeRef.current;
      if (!chat || !chat.mission) return;
      const added = [];
      for (const f of FINDINGS) {
        const b = bandOf(f, d[f.k]);
        const prev = lastBands.current[f.k] ?? 0;
        if (b > prev && f.msg[b]) {
          added.push({ id: Date.now() + Math.random(), text: t(f.msg[b]), kind: b === 2 ? "danger" : "warn", time: new Date().toLocaleTimeString() });
        }
        lastBands.current[f.k] = b;
      }
      if (added.length) setChats(cs => cs.map(c => c.id === chat.id ? { ...c, findings: [...(c.findings || []), ...added].slice(-40) } : c));
    }

    socket.on("connect", () => {
      setConnected(true); addLog(t("log.linkEstablished"), "system");
      socket.emit("set-language", getLang());
      socket.emit("set-mission", activeRef.current?.mission || "");
    });
    socket.on("disconnect", () => { setConnected(false); setFresh(false); setPing("—"); addLog(t("log.linkLost"), "danger"); });
    socket.on("clients", list => {
      setClients(prev => {
        if (!VIEWER) for (const c of list || []) {
          if (c.host) continue;
          const was = prev.find(p => p.id === c.id)?.granted ?? false;
          if (was !== c.granted)
            addLog(t(c.granted ? "log.grantGiven" : "log.grantTaken", { device: `${c.kind} ${c.ip}` }), c.granted ? "warn" : "system");
        }
        return list || [];
      });
      const me = (list || []).find(c => c.id === socket.id);
      if (me) setJudge(me.mode === "judge");
      if (me) setGranted(g => {
        if (me.granted !== g) addLog(t(me.granted ? "log.controlGranted" : "log.controlRevoked"), me.granted ? "system" : "warn");
        return me.granted;
      });
    });
    socket.on("sensor-data", d => {
      if (!d) return;
      const lat = d.timestamp ? Math.max(0, Date.now() - d.timestamp) : NaN;
      setPing(isNaN(lat) ? "—" : lat + " ms");
      lastPkt.current = Date.now(); setFresh(true);
      setPackets(p => p + 1);
      setPacket(d);
      if (d.dist != null && !isNaN(d.dist) && Math.abs(d.dist - lastDist.current) > 3) {
        lastDist.current = d.dist;
        const now = Date.now();
        if (now - lastObstacle.current > 2400) {
          lastObstacle.current = now;
          addLog(t("log.obstacle", { d: d.dist.toFixed(0) }), d.dist < 20 ? "danger" : d.dist < 55 ? "warn" : "system");
        }
      }
      recordFindings(d);
    });

    socket.on("sage-finding", d => {
      if (!d?.text) return;
      const chat = activeRef.current;
      if (!chat || !chat.mission) return;
      const entry = { id: d.id || Date.now() + Math.random(), text: d.text, kind: "find", img: d.img || null,
        time: new Date(d.timestamp || Date.now()).toLocaleTimeString() };
      setChats(cs => cs.map(c => c.id === chat.id
        ? { ...c, findings: [...(c.findings || []), entry].slice(-40) } : c));

      const snap = d.text.startsWith("SNAPSHOT:");
      pushFeed({ kind: "tool", name: snap ? "snapshot" : "finding", detail: d.text.replace(/^SNAPSHOT:\s*/, ""), img: d.img || null });
    });

    // Sage is holding a tool until the operator answers. A card she never gets an
    // answer to times out server-side as NO, so a closed tab is never a yes.
    socket.on("sage-confirm", d => {
      if (!d?.id) return;
      pushFeed({ kind: "confirm", confirmId: d.id, name: d.name, arg: d.arg || null, state: "pending" });
    });

    // Claude Code's own tools, one row per call while it works
    socket.on("claude-step", d => {
      if (d?.say) pushFeed({ kind: "sage", text: d.say });
      if (d?.name) pushFeed({ kind: "tool", name: d.name, arg: d.arg || null });
    });

    socket.on("sage-step", d => {
      if (!d?.name) return;
      if (d.say) pushFeed({ kind: "sage", text: d.say });
      pushFeed({ kind: "tool", name: d.name, arg: d.arg || null, detail: d.detail || "", img: d.img || null });
      addLog(t("log.tool", { name: d.name, detail: d.detail || "" }), "ai");
    });

    // The lamp has one level and three people reaching for it (this slider, Sage,
    // the dark ramp). The server echoes every change; a window event carries it to
    // whichever CamViews are mounted without threading the socket through them.
    socket.on("led", v => window.dispatchEvent(new CustomEvent("cam-led", { detail: v })));

    socket.on("blk-decision", d => {
      if (!d?.question) return;
      addLog(`${d.kind === "find" ? "find" : "ask"} "${d.question}" → ${d.yes ? "YES" : "no"}${d.text ? " · " + d.text : ""}`, d.yes ? "ai" : "system");
      pushFeed({ kind: "tool", name: "ask", detail: `"${d.question}" → ${d.yes ? "yes" : "no"}` });
    });
    socket.on("flash-log", d => setFlashLog(l => appendLog(l, d?.chunk || "")));
    socket.on("flash-done", d => { setFlashCode(d?.code ?? -1); setFlashPhase("done"); });
    socket.on("serial-line", d => {
      if (!d?.line) return;
      if (d.line.startsWith("E:")) onBoardLineRef.current?.(d.line, false);
      setSerialLines(p => [...p, {
        text: d.line, s: d.line.startsWith("S:"),
        time: new Date(d.timestamp || Date.now()).toLocaleTimeString(),
        id: Date.now() + Math.random(),
      }].slice(-300));
    });

    const sayAgent = (text, ts, logMsg, logKind, status = null) => {
      addLog(logMsg, logKind);
      setAi(p => ({
        text, badge: "badge.online", analyzing: false, status,
        phase: null, since: 0, llm: p.since ? Date.now() - p.since : null, tts: null,
        history: [...p.history, { text, time: new Date(ts || Date.now()).toLocaleTimeString(), id: Date.now() + Math.random() }].slice(-20),
      }));
      pushFeed({ kind: "sage", text, status });
      if (ttsRef.current) speakTimed(text);
    };

    socket.on("ai-analysis", d => {
      if (!d) return;

      if (!activeRef.current?.mission) {
        setAi(p => ({ ...p, analyzing: false, phase: null, badge: "badge.standby" }));
        return;
      }
      if (d.analysis) sayAgent(d.analysis, d.timestamp, t("log.aiReceived"), "ai", d.status);
      else if (d.error) sayAgent(d.error, d.timestamp, t("log.aiReceived"), "warn", null);
    });
    socket.on("agent-blurt", d => { if (d?.text && activeRef.current?.mission) sayAgent(d.text, d.timestamp, t("log.blurt", { text: d.text }), "warn"); });

    // the server borrows Sage's still off the live feed rather than opening a
    // second stream on a cam that only serves one
    socket.on("cam-frame", (cam, ack) => {
      const f = camFrames[cam || 0];
      ack(f && Date.now() - f.at < FRAME_LEND_MS ? f.bytes : null);
    });
    socket.on("mission-ack", d => { if (d?.text) sayAgent(d.text, d.timestamp, t("log.missionAck"), "ai", d.status); });

    socket.on("feed", d => setMirrorFeed(f => !d ? f : d.patch
      ? f.map(x => x.id === d.id ? { ...x, ...d.patch } : x)
      : [...f, d].slice(-40)));
    socket.on("cmd", w => { if (bleRef.current.device?.gatt?.connected) sendCmdRef.current?.(w); });
    // robot_blk from mcp.mjs: the same runner as Sage's move cards, so the two
    // can never diverge. Only the dashboard that can actually drive takes it.
    socket.on("blk-run", async ({ text, usb }, ack) => {
      if (!usb && !bleRef.current.device?.gatt?.connected) return ack({ skip: true });
      const { program } = blkParse(text);
      addLog(t("log.mcp", { what: `robot_blk: ${text.replace(/\s+/g, " ").slice(0, 80)}` }), "ai");
      const { where, cancelled } = await playBlk(program, {
        onCmd: (w) => sendCmdRef.current?.(w), onAnalyze: (...a) => analyzeAppRef.current?.(...a), busyRef: analyzingRef, packetRef,
        onNote: (n) => addLog(n, "ai"),
      });
      ack({ where, cancelled });
    });
    socket.on("mcp", d => { addLog(t("log.mcp", { what: mcpWhat(d) }), "ai"); window.dispatchEvent(new CustomEvent("mcp", { detail: d })); setMcp(d); });
    addLog(t("log.booted"), "system");
    return () => socket.close();
  }, [addLog, speakTimed, pushFeed]);

  useEffect(() => {
    document.documentElement.lang = lang;
    const sk = document.querySelector(".skip-link");
    if (sk) sk.textContent = t("skip");
  }, [lang]);

  useEffect(() => { fetch("/api/lan").then(r => r.json()).then(d => { setLanUrl(d.host || d.url); setLanIp(d.url); }).catch(() => {}); }, []);

  useEffect(() => {
    const t0 = Date.now();
    const id = setInterval(() => {
      const e = Date.now() - t0, p = n => String(n).padStart(2, "0");
      setUptime(`${p(Math.floor(e / 3600000))}:${p(Math.floor(e / 60000) % 60)}:${p(Math.floor(e / 1000) % 60)}`);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // ---- ble ----
  // same uuids the sketch advertises
  const BLE_SERVICE = "19b10000-e8f2-537e-4f6c-d104768a1214";
  const BLE_CHAR = "19b10001-e8f2-537e-4f6c-d104768a1214";
  const BLE_CMD = "19b10002-e8f2-537e-4f6c-d104768a1214";
  const bleRef = useRef({ device: null, char: null, cmd: null });
  const bleWriteRef = useRef(Promise.resolve());

  const bleWrite = useCallback((fn) => {
    const w = bleWriteRef.current.then(fn);
    bleWriteRef.current = w.catch(() => {});
    return w;
  }, []);

  const analyze = useCallback((mode, focus, cam) => {
    if (analyzingRef.current) return;
    analyzingRef.current = true;
    setAi(p => ({ ...p, analyzing: true, badge: "badge.analyzing", phase: "thinking", since: Date.now(), llm: null, tts: null }));
    socketRef.current?.emit("request-analysis", { mode: mode || null, prompt: focus || null, cam: cam ?? anaCam(), demo: demoRef.current });
  }, []);

  // One handler for both transports: over BLE the browser owns the link, over usb
  // the server does and relays the board's E: lines back on `serial-line`.
  // `forward` is off for the usb ones -- they came THROUGH /api/mega/sensor, and
  // posting them again is a loop.
  const onBoardLine = useCallback((line, forward = true) => {
    if (line.startsWith("E:analyze")) {
      addLog(t("log.routineAnalyze"), "ai");
      analyze(presentingRef.current ? "present" : null);
      presentingRef.current = false;
      return;
    }

    // the board's black box, dumped on every connect: why the LAST link died
    if (line.startsWith("E:log")) {
      if (!line.startsWith("E:logend")) {
        const [, ms, ...rest] = line.split(",");
        addLog(`board ${(+ms / 1000).toFixed(1)}s — ${rest.join(",")}`, "system");
      }
      return;
    }

    if (line.startsWith("E:blk")) { window.dispatchEvent(new CustomEvent("blk:evt", { detail: line })); return; }
    if (!forward) return;
    fetch("/api/mega/sensor", { method: "POST", headers: { "Content-Type": "text/plain" }, body: line })
      .then((r) => { if (!r.ok) console.error("BLE forward failed:", r.status); })
      .catch((err) => console.error("BLE forward error:", err.message));
  }, [analyze, addLog]);

  const onBleNotify = useCallback((e) => {
    const line = new TextDecoder().decode(e.target.value);
    console.log("BLE notify:", line);
    onBoardLine(line);
  }, [onBoardLine]);
  const onBoardLineRef = useRef(onBoardLine);
  onBoardLineRef.current = onBoardLine;

  const disconnectBle = useCallback(() => {
    const { device, char } = bleRef.current;
    if (char) char.removeEventListener("characteristicvaluechanged", onBleNotify);
    if (device?.gatt?.connected) device.gatt.disconnect();
    bleRef.current = { device: null, char: null, cmd: null };
  }, [onBleNotify]);

  const sendCmd = useCallback(async (word) => {
    if (!grantedRef.current && word !== "stop") { toast(t("toast.mirrorOnly"), "warn"); return false; }
    if (word.startsWith("go,")) presentingRef.current = word === "go,presentation";
    tapeWatch(word);
    const { device, cmd } = bleRef.current;

    if (!device?.gatt?.connected) {
      if (socketRef.current?.connected) { socketRef.current.emit("cmd", word); return true; }
      toast(t("toast.cmdNoLink"), "danger"); return false;
    }
    if (!cmd) { toast(t("toast.cmdNoChar"), "danger"); return false; }
    try {
      // A with-response write costs an ATT ack, so it is round-trip bound at the
      // connection interval -- ~2x the latency of a fire-and-forget write, and it
      // serializes behind every write already queued. The high-rate manual traffic
      // (drv/arm, resent every 300ms against the board's deadman) doesn't need the
      // ack: a dropped one is replaced 300ms later. `stop` and the blk upload do --
      // stop must not be droppable, and the ack is what paces `blk,i,` lines so
      // they can't outrun the board's parser.
      const acked = word === "stop" || word.startsWith("blk,");
      const buf = new TextEncoder().encode(word);
      await bleWrite(() => (acked || !cmd.writeValueWithoutResponse)
        ? cmd.writeValue(buf)
        : cmd.writeValueWithoutResponse(buf));

      if (!word.startsWith("blk,i,")) addLog(t("log.cmdSent", { cmd: word }), "system");
      return true;
    } catch (e) { addLog(t("log.error", { msg: e.message }), "danger"); return false; }
  }, [addLog, toast, bleWrite]);

  const sendCmdRef = useRef(sendCmd);
  analyzeAppRef.current = analyze;
  sendCmdRef.current = sendCmd;

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== " " || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(el.tagName) ||
        el.getAttribute?.("role") === "button")) return;
      e.preventDefault();
      panicStop(sendCmdRef.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    let live = true;
    const probe = () => fetch("/api/cloud").then(r => r.json())
      .then(d => { if (live) setCloud(d); }).catch(() => { if (live) setCloud({ sage: false, tts: false }); });
    probe();
    const id = setInterval(probe, 30000);
    return () => { live = false; clearInterval(id); };
  }, []);

  const [saver, setSaver] = useState(0);
  const pickSaver = useCallback(async (n) => {
    if (await sendCmd("scr," + n)) setSaver(n);
  }, [sendCmd]);

  useEffect(() => { if (!bridge.running) setSaver(0); }, [bridge.running]);

  const [buzz, setBuzz] = useState(() => localStorage.getItem("buzzer") !== "false");
  const toggleBuzz = useCallback(() => setBuzz(b => {
    localStorage.setItem("buzzer", String(!b));
    sendCmd("buz," + (!b ? 1 : 0));
    return !b;
  }), [sendCmd]);
  useEffect(() => { if (bridge.running) sendCmd("buz," + (buzz ? 1 : 0)); }, [bridge.running]);

  const loadBridge = useCallback(async () => {
    try { const r = await fetch("/api/bridge"); const d = await r.json();
      setBridge(b => ({ ...b, running: d.running, usb: !!d.usb })); } catch {  }
  }, []);
  useEffect(() => { loadBridge(); const id = setInterval(loadBridge, 5000); return () => clearInterval(id); }, [loadBridge]);

  const [blePicker, setBlePicker] = useState(false);
  const [bleDevs, setBleDevs] = useState([]);
  const closeBlePicker = useCallback(() => {
    setBlePicker(o => o === "open" ? "closing" : o);
    setTimeout(() => { setBlePicker(false); setBleDevs([]); }, 240);
  }, []);
  useEffect(() => {
    if (!window.blackout) return;
    const offDevs = window.blackout.onBleDevices((list) => {
      setBleDevs(list);
      setBlePicker(o => o || "open");
    });
    const offClosed = window.blackout.onBleClosed(closeBlePicker);
    return () => { offDevs(); offClosed(); };
  }, [closeBlePicker]);

  // bridge is the browser's own web-bluetooth link; electron hands us its picker instead
  const toggleBridge = useCallback(async (mode = "toggle") => {
    const stopping = mode === "toggle" && bridge.running;
    setBridge(b => ({ ...b, busy: true }));
    addLog(stopping ? t("log.bridge", { action: "stop" }) : mode === "reconnect" ? t("log.bridgeRepair") : t("log.bridge", { action: "start" }), "system");
    try {
      if (stopping) {
        disconnectBle();
        await fetch("/api/bridge/stop", { method: "POST" });
        setBridge({ running: false, usb: false, busy: false }); toast(t("toast.bridgeOff"), "ok");
      } else if (mode === "usb") {
        disconnectBle();   // one link at a time
        const r = await fetch("/api/bridge/start", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ usb: true }),
        });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error || "no board on usb");
        setBridge({ running: true, usb: true, busy: false }); toast(t("toast.usbOn"), "ok");
      } else {
        if (mode === "reconnect") disconnectBle();
        if (!navigator.bluetooth) throw new Error("Web Bluetooth unsupported — use Chrome/Edge");
        if (window.blackout) setBlePicker("open");

        const device = await navigator.bluetooth.requestDevice({
          filters: [{ services: [BLE_SERVICE] }],
          optionalServices: [BLE_SERVICE],
        });
        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(BLE_SERVICE);
        const char = await service.getCharacteristic(BLE_CHAR);
        const cmd = await service.getCharacteristic(BLE_CMD).catch(() => null);
        await char.startNotifications();
        char.addEventListener("characteristicvaluechanged", onBleNotify);
        device.addEventListener("gattserverdisconnected", () => {
          bleRef.current = { device: null, char: null, cmd: null };
          setBridge(b => ({ ...b, running: false }));
          fetch("/api/bridge/stop", { method: "POST" }).catch(() => {});
        });
        bleRef.current = { device, char, cmd };
        // ask for the black box now that notifications are subscribed: the reason
        // for the last disconnect lands in the log before the next run starts
        cmd?.writeValue(new TextEncoder().encode("log,")).catch(() => {});
        const r = await fetch("/api/bridge/start", { method: "POST" });
        const d = await r.json();
        if (d.ok) { setBridge({ running: true, usb: false, busy: false }); toast(t("toast.bridgeOn"), "ok"); }
        else { disconnectBle(); setBridge(b => ({ ...b, busy: false })); addLog(t("log.failed", { error: d.error }), "danger"); toast(d.error, "danger"); }
      }
    } catch (e) { setBridge(b => ({ ...b, busy: false })); addLog(t("log.error", { msg: e.message }), "danger"); if (window.blackout) closeBlePicker(); }
    loadBridge();
  }, [bridge.running, addLog, toast, loadBridge, disconnectBle, onBleNotify, closeBlePicker]);

  const mockData = useCallback(() => {
    setAi(p => ({ ...p, analyzing: true, badge: "badge.analyzing", phase: "thinking", since: Date.now(), llm: null, tts: null }));
    socketRef.current?.emit("mock-data");
  }, []);

  const showSage = useCallback((sage, t0, speak = true) => {
    const textv = (sage && sage.text) || "No response.";
    setAi(p => ({
      text: textv, status: (sage && sage.status) || null,
      badge: "badge.online", analyzing: false, phase: null, since: 0,
      llm: t0 ? Date.now() - t0 : p.llm, tts: null,
      history: [...p.history, { text: textv, time: new Date().toLocaleTimeString(), id: Date.now() + Math.random() }].slice(-20),
    }));
    pushFeed({ kind: "sage", text: textv, status: (sage && sage.status) || null,
      timing: t0 ? `LLM ${((Date.now() - t0) / 1000).toFixed(1)}s` : null });

    if (sage && sage.move && movesRef.current) {
      const { program, errors } = blkParse(sage.move);
      if (!errors.length && program.length) {
        const { program: safe, added } = blkGuard(program);
        let board;
        try { board = blkCompile(safe).code.length; } catch (e) { board = e.message; }
        pushFeed({ kind: "move", text: blkSerialize(safe), board, guarded: added, state: "pending" });
      }
    }
    // The server already resolved her arm proposal or her recorded run into a
    // {ms, cmd} tape — the same shape armrec.py records — so a card is one press
    // away from the pad, or from the TAPES tab's play button.
    // It plays with no press when the take's own file says so
    // (`sage_ask_permission_for_this: false` — a spoken hello is not a thing to
    // ask permission for), and BYPASS plays anything. `ask` comes off the file,
    // never off the card, so a run that drives keeps its YES in both modes.
    const propose = (kind, p, extra = {}) => {
      const ask = p.ask !== false && confirmRef.current;
      const id = pushFeed({ kind, text: p.text, tape: p.tape, state: ask ? "pending" : "running", ...extra });
      if (ask || id == null) return;
      if (kind === "tape")
        tapePlay(p.tape, { onCmd: sendCmd, onAnalyze: analyze, onNote: (n) => addLog(n, "ai"), onSay: sayFeed })
          .then(() => patchFeed(id, { state: "done" }));
      else setTimeout(() => patchFeed(id, { state: "done" }), armPlay(p.tape, sendCmd));
    };
    if (sage && sage.arm && movesRef.current) propose("arm", sage.arm);
    if (sage && sage.tape && movesRef.current)
      propose("tape", sage.tape, { dur: sage.tape.tape[sage.tape.tape.length - 1].ms });
    if (speak && ttsRef.current) speakTimed(textv);
  }, [speakTimed, pushFeed, patchFeed, sendCmd, analyze, addLog, sayFeed]);

  // A recorded run played by name — the trigger path above, and anywhere else a
  // run is started without a card in front of it.
  const runTape = useCallback(async (name) => {
    const r = await fetch(`/api/tapes/${encodeURIComponent(name)}`);
    if (!r.ok) return void addLog(`no recorded run called "${name}"`, "system");
    const steps = (await r.json()).steps || [];
    if (!steps.length) return void addLog(`recorded run "${name}" is empty`, "system");
    const id = pushFeed({ kind: "tape", text: name, tape: steps, state: "running",
      dur: steps[steps.length - 1].ms });
    await tapePlay(steps, { onCmd: sendCmd, onAnalyze: analyze, onNote: (n) => addLog(n, "ai"), onSay: sayFeed });
    if (id != null) patchFeed(id, { state: "done" });
  }, [addLog, pushFeed, patchFeed, sendCmd, analyze, sayFeed]);

  // one ask can take several visible steps — she calls her own tools server-side
  const ask = useCallback(async (text) => {
    text = (text || "").trim();
    const chat = activeRef.current;
    if (!text || !chat) return;
    addLog(t("log.operator", { text }), "system");
    pushFeed({ kind: "user", text });

    const trigger = matchCmd(norm(text));
    if (trigger?.tape) return void runTape(trigger.tape);
    if (trigger) {
      const ms = driveMs(norm(text));
      const sent = await sendCmd(trigger.cmd(ms));
      const ack = { text: t(sent ? trigger.ackKey : "toast.cmdNoLink", { s: (ms / 1000).toFixed(1) }), status: null };
      setChats(cs => cs.map(c => c.id === chat.id ? { ...c, messages: [...(c.messages || []), { role: "user", content: text }, { role: "assistant", content: ack.text }].slice(-12) } : c));
      showSage(ack, null, sent);
      return;
    }
    const t0 = Date.now();
    setAi(p => ({ ...p, analyzing: true, badge: "badge.thinking", phase: "thinking", since: t0, llm: null, tts: null }));
    const next = [...(chat.messages || []), { role: "user", content: text }].slice(-12);
    setChats(cs => cs.map(c => c.id === chat.id ? { ...c, messages: next } : c));
    if (brainRef.current === "claude") {
      setAi(p => ({ ...p, badge: "badge.claude" }));
      try {
        const r = await fetch("/api/claude", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, session: chat.claudeSession, lang: getLang(), ...claudeOpts.current }),
        });
        const data = await r.json();
        const ok = !!data.text;
        setChats(cs => cs.map(c => c.id === chat.id ? { ...c, claudeSession: data.session || c.claudeSession,
          messages: ok ? [...next, { role: "assistant", content: data.text }].slice(-12) : next } : c));
        addLog(data.cost != null ? `claude replied · $${data.cost.toFixed(3)}` : t("log.replied"), "ai");
        showSage({ text: data.text || data.error || "No response.", status: null }, t0, ok);
      } catch (e) {
        setAi(p => ({ ...p, text: t("ai.comms", { msg: e.message }), badge: "badge.online", analyzing: false, phase: null }));
      }
      return;
    }
    try {
      const r = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next, lang: getLang(), moves: movesRef.current, lamp: lampRef.current, demo: demoRef.current, confirm: confirmRef.current }),
      });
      const data = await r.json();
      const sage = data.reply, ok = !!(sage && sage.text);
      if (ok) setChats(cs => cs.map(c => c.id === chat.id ? { ...c, messages: [...next, { role: "assistant", content: sage.text }].slice(-12) } : c));
      addLog(t("log.replied"), "ai");
      showSage(ok ? sage : { text: data.error || "No response.", status: null }, t0, ok);
    } catch (e) {
      setAi(p => ({ ...p, text: t("ai.comms", { msg: e.message }), badge: "badge.online", analyzing: false, phase: null }));
    }
  }, [addLog, showSage, pushFeed, sendCmd, runTape]);

  // a card only ever runs when the operator presses YES. NO sends nothing at all.
  const onAnswer = useCallback(async (item, yes) => {
    if (item.kind === "confirm") {
      socketRef.current?.emit("sage-confirm-res", { id: item.confirmId, ok: yes });
      return patchFeed(item.id, { state: yes ? "done" : "declined" });
    }
    if (!yes) return patchFeed(item.id, { state: "declined" });

    if (item.kind === "tape") {
      patchFeed(item.id, { state: "running" });
      addLog(`playing recorded run "${item.text}"`, "ai");
      tapePlay(item.tape, { onCmd: sendCmd, onAnalyze: analyze, onNote: (n) => addLog(n, "ai"), onSay: sayFeed })
        .then(() => patchFeed(item.id, { state: "done" }));
      return;
    }
    if (item.kind === "arm") {
      patchFeed(item.id, { state: "running" });
      addLog(t("log.armRun"), "ai");
      const ms = armPlay(item.tape, sendCmd);
      setTimeout(() => patchFeed(item.id, { state: "done" }), ms);
      return;
    }
    const { program, errors } = blkParse(item.text);
    if (errors.length || !program.length) return patchFeed(item.id, { state: "failed", note: errors[0] || "empty" });
    patchFeed(item.id, { state: "running" });
    addLog(t("log.moveRun"), "ai");
    const { where, cancelled } = await playBlk(program, {
      onCmd: sendCmd, onAnalyze: analyze, busyRef: analyzingRef, packetRef,
      onNote: (n) => addLog(n, "ai"),
    });
    patchFeed(item.id, { state: cancelled ? "stopped" : "done", note: where });
  }, [patchFeed, addLog, sendCmd, analyze]);

  // The newest unanswered card is the one the gamepad and the FPV popup act on:
  // ✕ accepts, ○ declines, same faces padnav already presses and backs out with.
  const pendingAsk = (activeChat?.feed || NO_FEED).filter(e => ASK_KINDS[e.kind] && (e.state || "pending") === "pending").slice(-1)[0] || null;
  const pendingAskRef = useRef(null);
  pendingAskRef.current = pendingAsk;
  const onAnswerRef = useRef(onAnswer);
  onAnswerRef.current = onAnswer;

  const fpvMic = useMic(ask);
  const fpvMicRef = useRef(fpvMic);
  fpvMicRef.current = fpvMic;
  const fpvRef = useRef(fpv);
  fpvRef.current = fpv;

  const toggleFpv = useCallback((on) => {
    const go = () => flushSync(() => setFpv(p => (typeof on === "boolean" ? on : !p)));
    if (document.startViewTransition) document.startViewTransition(go); else go();
  }, []);
  const toggleFpvRef = useRef(toggleFpv);
  toggleFpvRef.current = toggleFpv;
  const cycleZoomRef = useRef(null);
  cycleZoomRef.current = () => setFpvZoom(i => (i + 1) % FPV_ZOOMS.length);

  const recActRef = useRef(null);
  useEffect(() => {
    let was = [false, false, false, false, false];
    const id = setInterval(() => {
      const pad = [...navigator.getGamepads()].find(Boolean);
      if (!pad) return;

      const now = [!!pad.buttons[3]?.pressed, !!pad.buttons[1]?.pressed, !!pad.buttons[9]?.pressed,
        !!pad.buttons[0]?.pressed, !!pad.buttons[8]?.pressed];
      // a card waiting on the operator owns ✕/○ outright — rec and mic can wait
      if (pendingAskRef.current) {
        if (now[3] && !was[3]) onAnswerRef.current(pendingAskRef.current, true);
        else if (now[1] && !was[1]) onAnswerRef.current(pendingAskRef.current, false);
        was = now;
        return;
      }
      if (now[0] && !was[0]) toggleFpvRef.current();
      if (now[1] && !was[1] && fpvRef.current) fpvMicRef.current.toggle();
      if (now[2] && !was[2] && fpvRef.current) cycleZoomRef.current?.();
      if (now[3] && !was[3] && fpvRef.current && !VIEWER) recActRef.current?.rec();
      if (now[4] && !was[4] && fpvRef.current) recActRef.current?.replays();
      was = now;
    }, 80);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!fpv || replay) return;
    const onKey = (e) => { if (e.key === "Escape") toggleFpv(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fpv, replay, toggleFpv]);

  const toggleTts = useCallback(() => setTts(p => {
    const n = !p; ttsRef.current = n; localStorage.setItem("tts", n);
    if (!n) { stopSpeech(); setSpeaking(false); }
    return n;
  }), []);
  const toggleTtsProvider = useCallback(() => setTtsProv(p => p === "edge" ? "deepgram" : "edge"), []);

  const speakBrief = useCallback((items) => {
    if (!ttsRef.current) return;
    const play = (i) => { if (i < items.length) playOnboard(items[i].clip, items[i].text, { onEnd: () => play(i + 1) }); };
    play(0);
  }, []);
  const changeLang = useCallback((code) => {
    setLang(code); setLangState(code);
    socketRef.current?.emit("set-language", code);
  }, []);
  const newChat = useCallback(() => {
    const id = "c" + Date.now();
    setChats(cs => [...cs, { id, title: t("chat.newTitle"), mission: "", messages: [], created: Date.now() }]);
    setActiveId(id);
    socketRef.current?.emit("set-mission", "");
  }, []);
  const selectChat = useCallback((id) => {
    setActiveId(id);
    socketRef.current?.emit("set-mission", (chats.find(c => c.id === id)?.mission) || "");
  }, [chats]);
  const deleteChat = useCallback((id) => {
    setChats(cs => cs.filter(c => c.id !== id));
    setActiveId(a => {
      if (a !== id) return a;

      socketRef.current?.emit("set-mission", "");
      return "";
    });
  }, []);
  const briefMission = useCallback((text) => {
    text = (text || "").trim();
    const chat = activeRef.current;
    if (!text || !chat) return;
    addLog(t("log.missionSent", { text }), "system");
    setChats(cs => cs.map(c => c.id === chat.id ? { ...c, mission: text, title: text.length > 30 ? text.slice(0, 30) + "…" : text } : c));
    setAi(p => ({ ...p, analyzing: true, badge: "badge.copying", phase: "thinking", since: Date.now() }));
    socketRef.current?.emit("set-mission", text);
  }, [addLog]);
  const clearSerial = useCallback(() => setSerialLines([]), []);

  const closeDrawer = useCallback(() => {
    setDrawer(o => o === "open" ? "closing" : o);
    setTimeout(() => setDrawer(false), 240);
  }, []);

  const openDrawer = useCallback(() => {
    if (localStorage.getItem("debugAck")) setDrawer("open");
    else setWarn("open");
  }, []);
  const closeWarn = useCallback(() => {
    setWarn(w => w === "open" ? "closing" : w);
    setTimeout(() => setWarn(false), 220);
  }, []);
  const closeReport = useCallback(() => {
    setReportClosing(true);
    setTimeout(() => { setReport(null); setReportClosing(false); }, 220);
  }, []);
  const toggleDrawer = useCallback(() => {
    if (drawerRef.current === "open") closeDrawer(); else openDrawer();
  }, [closeDrawer, openDrawer]);

  const toggleDrawerRef = useRef(toggleDrawer);
  toggleDrawerRef.current = toggleDrawer;
  useEffect(() => {
    const id = initPadNav({
      blocked: () => fpvRef.current || !!pendingAskRef.current,
      onMenu: () => toggleDrawerRef.current(),
    });
    return () => clearInterval(id);
  }, []);

  const closeOptions = useCallback(() => {
    setOptionsOpen(o => o === "open" ? "closing" : o);
    setTimeout(() => setOptionsOpen(false), 240);
  }, []);
  useEffect(() => {
    if (!window.blackout) return;
    return window.blackout.onSettingsOpen(() => setOptionsOpen("open"));
  }, []);

  useEffect(() => {
    if (warn !== "open") return;
    setWarnCount(3);
    const id = setInterval(() => setWarnCount(c => Math.max(0, c - 1)), 1000);
    return () => clearInterval(id);
  }, [warn]);

  // firmware update: the server owns arduino-cli, we just poll it
  const openUpdate = useCallback(() => {
    setFlashPhase("detect");
    setFlashLog(""); setFlashCode(null);
    setUpdateOpen("open");
  }, []);
  const closeUpdate = useCallback(() => {
    setUpdateOpen(o => o === "open" ? "closing" : o);
    setTimeout(() => setUpdateOpen(false), 240);
  }, []);
  const closeDevices = useCallback(() => {
    setDevicesOpen(o => o === "open" ? "closing" : o);
    setTimeout(() => setDevicesOpen(false), 240);
  }, []);
  const startFlash = useCallback(() => {
    setFlashLog(""); setFlashCode(null); setFlashPhase("flashing");
    fetch("/api/flash/start", { method: "POST" }).then(r => {
      if (!r.ok) throw new Error(r.status === 409 ? "a flash is already running" : `server said ${r.status}`);
    }).catch(err => {
      setFlashLog(err.message); setFlashCode(-1); setFlashPhase("done");
    });
  }, []);

  useEffect(() => {
    if (VIEWER || flashPhase === "flashing") return;
    const poll = () => fetch("/api/flash/boards").then(r => r.json()).then(setFlashBoards).catch(() => {});
    poll();
    const id = setInterval(poll, updateOpen === "open" ? 1200 : 5000);
    return () => clearInterval(id);
  }, [updateOpen, flashPhase]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "`" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      e.preventDefault();
      if (drawerRef.current === "open" && drawerTabRef.current === "serial") { closeDrawer(); return; }
      setDrawerTab("serial");
      openDrawer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeDrawer, openDrawer]);

  useEffect(() => { fetch("/api/rec").then(r => r.json()).then(d => setRec(d.now)).catch(() => {}); }, []);
  const recRef = useRef(rec); recRef.current = rec;
  const toggleRec = useCallback(() => {
    const on = !!recRef.current;
    fetch(on ? "/api/rec/stop" : "/api/rec/start", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: activeRef.current?.title || "" }),
    }).then(async r => {
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "server said " + r.status);
      setRec(on ? null : d.now);
      setRecErr(null);
      addLog(on ? "recording saved" : "recording started", "system");
    }).catch(err => {
      addLog("recorder: " + err.message, "danger");
      toast(err.message, "danger");
      setRecErr(err.message);
    });
  }, [addLog, toast]);
  const openReplays = useCallback(() => {
    fetch("/api/rec").then(r => r.json()).then(d => { setRec(d.now); setRuns(d.runs); }).catch(() => setRuns([]));
  }, []);
  const pickReplay = useCallback((id) => {
    fetch("/api/rec/" + id).then(r => r.json()).then(run => { setRuns(null); setReplay(run); }).catch(() => {});
  }, []);
  recActRef.current = { rec: toggleRec, replays: openReplays };
  const deleteReplay = useCallback((id) => {
    fetch("/api/rec/" + id, { method: "DELETE" })
      .then(() => setRuns(rs => (rs || []).filter(r => r.id !== id))).catch(() => {});
  }, []);

  const openReport = useCallback(() => {
    setReport(buildReport({ chat: activeRef.current, packet: packetRef.current, logs, ai, connected: live, ping, packets, uptime }));
  }, [logs, ai, live, ping, packets, uptime]);

  const drawerTabRef = useRef(drawerTab);
  drawerTabRef.current = drawerTab;
  const drawerRef = useRef(drawer);
  drawerRef.current = drawer;

  // ---- render ----
  return html`
    <${React.Fragment}>
      <div class=${"shell" + (fpv ? " is-fpv" : "") + (FPV_ZOOMS[fpvZoom].z ? "" : " fpv-fill")}
        style=${{ "--fpv-zoom": FPV_ZOOMS[fpvZoom].z || 1 }}>
        ${fpv && html`
          <${React.Fragment}>
            <${FpvOverlay} packet=${view} />
            <${FpvSage} ai=${ai} packet=${view} speaking=${speaking} connected=${live} />
            <div class="fpv-hud">
              <button type="button" ref=${fpvMic.btnRef} class=${"hud-btn mic-lvl" + (fpvMic.listening ? " is-active" : "")}
                disabled=${!fpvMic.supported} onClick=${fpvMic.toggle} aria-pressed=${fpvMic.listening}>
                ${fpvMic.heard ? "●" : "○"} ${!fpvMic.listening ? t("ask.mic") : fpvMic.heard ? t("ask.heard") : t("ask.listening")}
              </button>
              <button type="button" class="hud-btn" onClick=${() => analyze()} disabled=${ai.analyzing}>
                ◎ ${ai.analyzing ? t("agent.analyzing") : t("agent.runAnalysis")}
              </button>
              <button type="button" class="hud-btn" onClick=${() => cycleZoomRef.current()}>
                <${Icon} n="gear" /> ${FPV_ZOOMS[fpvZoom].label}
              </button>
              ${!VIEWER && html`
                <button type="button" class=${"hud-btn is-rec" + (rec ? " is-on" : "") + (recErr ? " is-err" : "")}
                  onClick=${toggleRec} aria-pressed=${!!rec}>
                  ✕ ${rec ? "STOP REC" : recErr ? "CAN'T RECORD" : "REC"}
                </button>`}
              <button type="button" class="hud-btn" onClick=${openReplays}>⧉ REPLAYS</button>
              <button type="button" class="hud-btn" onClick=${() => toggleFpv(false)}>△ / ESC</button>
            </div>
            ${pendingAsk && html`<div class="fpv-ask" role="alertdialog">
              <${FeedLine} e=${pendingAsk} onAnswer=${onAnswer} />
            </div>`}
            ${recErr && !rec && html`<p class="rec-err" role="alert">✕ ${recErr}</p>`}
          <//>`}
        ${window.blackout?.platform === "darwin" && html`<div class="mac-titlebar"></div>`}
        <${Topbar} connected=${live} stale=${!fresh} bridge=${bridge} onBridge=${toggleBridge}
          ping=${fresh ? ping : "—"} packets=${packets} uptime=${uptime} lanUrl=${lanUrl} lanIp=${lanIp}
          lang=${lang} onLang=${changeLang} onConsole=${toggleDrawer} consoleOpen=${drawer === "open"}
          clients=${clients} onDevices=${() => setDevicesOpen("open")} granted=${granted}
          cloud=${cloud} onSettings=${() => setOptionsOpen("open")} mcp=${mcp} />

        ${!VIEWER && flashBoards.status !== "none" && html`<${UpdateBar} boards=${flashBoards} onUpdate=${openUpdate} />`}

        ${judge ? html`<${JudgeView} packet=${view} connected=${live} ai=${ai} feed=${mirrorFeed} />` : html`
        <main class="cockpit" id="sensors">
          <div class="col-main">
            <div class="stage-row">
              <${ThreeDeeBox} packet=${view} onLog=${addLog} />
              <${Split} id="cam" />
              <${CamBox} packet=${view} onFpv=${() => toggleFpv(true)} />
            </div>
            <${Split} id="strip" axis="y" />
            <${SensorStrip} packet=${view} />
          </div>
          <${Split} id="rail" />
          <aside class="col-rail">
            <${Agent} ai=${ai} tts=${tts} ttsProv=${ttsProv} hasDeepgram=${hasDeepgram} confirm=${confirm} onConfirm=${toggleConfirm}
              brain=${brain} onBrain=${toggleBrain} claudeModel=${claudeModel} onModel=${pickModel} claudeEffort=${claudeEffort} onEffort=${pickEffort} packet=${view} connected=${live} speaking=${speaking}
              chats=${chats} activeChat=${activeChat} feed=${activeChat?.feed || NO_FEED} onNewChat=${newChat} onSelectChat=${selectChat}
              onDeleteChat=${deleteChat} onBrief=${briefMission} onSpeak=${speakBrief}
              onAnalyze=${analyze} onToggleTts=${toggleTts} onToggleTtsProvider=${toggleTtsProvider} onMock=${mockData} onAsk=${ask}
              onReport=${openReport} onAnswer=${onAnswer} />
            ${
              driveMounted && html`
              <${React.Fragment}>
              <${Split} id="drive" axis="y" />
              <${Drive} onCmd=${sendCmd} onAnalyze=${analyze} enabled=${canDrive} leaving=${!granted}
                busyRef=${analyzingRef} packetRef=${packetRef} />
              <//>`}
          </aside>
        </main>`}

        ${!judge && html`<${Drawer} open=${drawer} tab=${drawerTab} onTab=${setDrawerTab} onClose=${closeDrawer}
          logs=${logs} serialLines=${serialLines} onClearSerial=${clearSerial}
          chat=${activeChat} onCmd=${sendCmd} onAnalyze=${analyze} onNote=${(n) => addLog(n, "system")} onSay=${sayFeed}
          enabled=${canDrive} />`}
      </div>

      <${Toasts} items=${toasts} />

      ${updateOpen && createPortal(html`
        <${UpdateModal} open=${updateOpen} phase=${flashPhase} boards=${flashBoards}
          log=${flashLog} code=${flashCode}
          onFlash=${startFlash} onClose=${closeUpdate} />`, document.body)}

      ${devicesOpen && createPortal(html`
        <${DevicesModal} open=${devicesOpen} clients=${clients} selfId=${socketRef.current?.id}
          onMode=${(id, mode) => socketRef.current?.emit("grant", { id, mode })}
          onClose=${closeDevices} />`, document.body)}

      ${optionsOpen && createPortal(html`
        <${Options} open=${optionsOpen} onClose=${closeOptions} enabled=${canDrive}
          saver=${saver} onSaver=${pickSaver} moves=${moves} onMoves=${toggleMoves}
          lamp=${lamp} onLamp=${toggleLamp} demo=${demo} onDemo=${toggleDemo}
          buzz=${buzz} onBuzz=${toggleBuzz} />`, document.body)}

      ${blePicker && createPortal(html`
        <${BlePickerModal} open=${blePicker} devices=${bleDevs}
          onPick=${(id) => window.blackout.selectBleDevice(id)}
          onCancel=${() => window.blackout.selectBleDevice("")} />`, document.body)}

      ${runs && createPortal(html`
        <${ReplayList} runs=${runs} onPick=${pickReplay} onDelete=${deleteReplay}
          onClose=${() => setRuns(null)} />`, document.body)}

      ${replay && createPortal(html`
        <${Replay} run=${replay} onClose=${() => setReplay(null)} />`, document.body)}

      ${report && createPortal(html`
        <${ReportModal} report=${report} closing=${reportClosing} onClose=${closeReport} />`, document.body)}

      ${warn && createPortal(html`
        <div class=${"blk-modal" + (warn === "closing" ? " is-closing" : "")}
          onClick=${(e) => { if (e.target === e.currentTarget) closeWarn(); }}>
          <div class="blk-modal-frame warn-frame">
            <span class="warn-title"><${Icon} n="warn" /> DEBUG MENU</span>
            <p>This is a debug menu. If you don't know what you are doing, turn back!</p>
            <div class="warn-actions">
              <button type="button" class="serial-btn" onClick=${closeWarn}>Turn back</button>
              <button type="button" class="serial-btn warn-go" disabled=${warnCount > 0}
                onClick=${() => { localStorage.setItem("debugAck", "1"); closeWarn(); setDrawer("open"); }}>
                Proceed<span class=${"warn-count" + (warnCount > 0 ? "" : " is-done")}> (${warnCount || 1})</span>
              </button>
            </div>
          </div>
        </div>`, document.body)}
    <//>`;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
