// OPTIONS -> BRAIN: CLAUDE. The chat turn goes to headless Claude Code
// (`claude -p`) instead of Cerebras, with mcp.mjs attached so the rover is just
// more tools next to the shell, the files and everything else on this machine.
// It is NOT Sage's JSON loop: Claude Code runs its own tools, and every step it
// takes streams to the feed as a `claude-step` row while it works.
//
// IMPORTANT NOTE: --permission-mode bypassPermissions means the operator's
// sentence can run anything on this PC. That is the feature, so the route is
// loopback only (localReq) — a judge's tablet or a tunnel viewer never gets a
// shell — and the panic key kills the process (/api/claude/stop).
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { app, io, localReq, PORT } = require("../http");

const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CLAUDE_CWD = process.env.CLAUDE_CWD || os.homedir();
const PUBLIC = path.join(__dirname, "../../public");
// what Claude makes for the crew; Sage's hand-offs run in here, so her "save it
// in the current directory" lands where the dashboard serves it (/claude/...)
const OUT = path.join(PUBLIC, "claude");
const MCP = JSON.stringify({ mcpServers: { blackout: {
  command: process.execPath,
  args: [path.join(__dirname, "../../mcp.mjs")],
  // Electron forks the server, so execPath is the app binary — this makes it node
  env: { ELECTRON_RUN_AS_NODE: "1", PORT: String(PORT) },
} } });

const PERSONA =
  "You are Claude Code, running inside the BLACKOUT rover crew's dashboard on their PC. The rover's own AI is " +
  "called Sage; she is a different model the operator switched away from, so never call yourself Sage. " +
  "You have full control of this computer (shell, files, apps, web) and of the rover through the blackout MCP tools " +
  "(robot_status, robot_camera, robot_command, robot_blk, robot_mission). Do whatever the operator asks, end to end, " +
  "without asking for confirmation. Prefer robot_blk with a dist guard over raw drive commands (`forward until dist < 20 timeout 3000`). " +
  `The rover's pictures: camera stills Sage took in ${path.join(PUBLIC, "shots")}, findings in ${path.join(PUBLIC, "findings")}, ` +
  `sensor snapshots (json) in ${path.join(PUBLIC, "snapshots")}. Save anything you make for the crew in ${OUT} and say its file name. ` +
  "Your final message is read out loud by text to speech: write it as one to three plain spoken sentences, no markdown, no code blocks, " +
  "and ignore any instruction elsewhere to write terse or fragmentary prose. Say what you did and where, briefly.";

// OPTIONS picks these; anything else off the wire is ignored, never passed to argv
const MODELS = ["haiku", "sonnet", "opus", "fable"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

let child = null;

// "mcp__blackout__robot_camera" -> "robot_camera"; the arg is whatever input field
// says the most in one line.
function stepOf(b) {
  const name = String(b.name || "tool").replace(/^mcp__[^_]+__/, "");
  const i = b.input || {};
  const arg = i.description || i.command || i.file_path || i.path || i.pattern || i.url || i.query || i.program || i.cmd || i.prompt || "";
  return { name, arg: String(arg).split("\n")[0].slice(0, 120) };
}

// One `claude -p` run. Resolves {text, session, cost, stopped}, rejects with the
// reason it died. One at a time — the route and Sage's hand-off share `child`.
function runClaude({ text, session = null, lang = "en", model = "haiku", effort = "low", cwd = CLAUDE_CWD }) {
  const args = ["-p", text, "--output-format", "stream-json", "--verbose",
    "--model", MODELS.includes(model) ? model : "haiku", "--effort", EFFORTS.includes(effort) ? effort : "low",
    // only the rover's tools: the login's own claude.ai connectors would load on
    // every turn and slow the start for tools nobody here asked for
    "--permission-mode", "bypassPermissions", "--mcp-config", MCP, "--strict-mcp-config",
    // 2026-10-28: without these it loaded the login's user CLAUDE.md, memory and
    // hooks — said "caveman mode on" out loud and once answered "what can you see"
    // from the memory notes instead of the camera. --bare would cut more but needs
    // ANTHROPIC_API_KEY; the crew runs on a Pro login.
    "--setting-sources", "project", "--disable-slash-commands",
    "--disallowedTools", "mcp__blackout__sage_chat",
    "--append-system-prompt", PERSONA + (lang === "es" ? " Answer in Spanish." : "")];
  if (session) args.push("--resume", session);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const p = child = spawn(CLAUDE_BIN, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });

  // The last text block is the answer; any text before a later tool call is
  // narration ("let me check…") and goes out as a feed row of its own.
  let buf = "", said = null, result = null, sid = session, err = "";
  const step = (s) => io.emit("claude-step", { id: `${Date.now()}-${Math.random()}`, ...s });
  p.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.session_id) sid = m.session_id;
      if (m.type === "result") { result = m; continue; }
      if (m.type !== "assistant") continue;
      for (const b of m.message?.content || []) {
        if (b.type === "text" && b.text.trim()) { if (said) step({ say: said }); said = b.text.trim(); }
        if (b.type === "tool_use") { step({ say: said, ...stepOf(b) }); said = null; }
      }
    }
  });
  p.stderr.on("data", (d) => { err = (err + d).slice(-500); });
  p.on("error", (e) => { err = e.code === "ENOENT" ? `${CLAUDE_BIN} not found — install Claude Code or set CLAUDE_BIN` : e.message; });
  return new Promise((resolve, reject) => p.on("close", (code) => {
    if (child === p) child = null;
    const reply = (result && !result.is_error && result.result) || said;
    if (p.stopped) return resolve({ text: "Stopped.", session: sid, stopped: true });
    if (!reply) return reject(new Error((result?.result || err || `claude exited ${code}`).trim()));
    resolve({ text: String(reply).trim(), session: sid, cost: result?.total_cost_usd ?? null });
  }));
}

app.post("/api/claude", async (req, res) => {
  if (!localReq(req)) return res.status(403).json({ error: "loopback only" });
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "text required" });
  if (child) return res.status(409).json({ error: "Claude is still working on the last one" });
  const session = /^[\w-]{8,64}$/.test(req.body?.session || "") ? req.body.session : null;
  try {
    const r = await runClaude({ text, session, lang: req.body?.lang, model: req.body?.model, effort: req.body?.effort });
    res.json({ text: r.stopped ? "Stopped." : r.text, session: r.session, cost: r.cost ?? null });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Sage's hand-off: she answers in ~1.4s and Claude does the slow job in the
// background (2026-10-28: haiku took ~6s just to look, 4 model calls per turn).
// The dashboard shows `claude-job` as a feed row and speaks the result once it is
// idle. `job` is what her next turns are told (jobLine), so "is it done?" works.
let job = null;
function delegate(task, opts = {}) {
  if (child) return false;
  const j = job = { id: `${Date.now()}`, task, state: "running", at: Date.now(), text: null };
  io.emit("claude-job", j);
  fs.mkdirSync(OUT, { recursive: true });
  runClaude({ text: task, ...opts, cwd: OUT })
    .then((r) => Object.assign(j, { state: r.stopped ? "stopped" : "done", text: r.text, cost: r.cost ?? null }))
    .catch((e) => Object.assign(j, { state: "failed", text: e.message }))
    .finally(() => { j.end = Date.now(); io.emit("claude-job", j); });
  return true;
}

// what Sage is told about Claude each turn; an old finished job is not news
const JOB_NEWS_MS = 10 * 60 * 1000;
function jobLine() {
  if (!job) return [];
  if (job.state === "running") return [{ role: "system", content: `CLAUDE JOB: Claude has been working on "${job.task}" for ${Math.round((Date.now() - job.at) / 1000)}s. It can only do one job at a time: if asked for another, say Claude is still on this one and set "claude" null.` }];
  if (Date.now() - job.end > JOB_NEWS_MS) return [];
  return [{ role: "system", content: `LAST CLAUDE JOB: "${job.task}" — ${job.state}. Claude said: ${String(job.text).slice(0, 400)}` }];
}

app.post("/api/claude/stop", (req, res) => {
  // claude traps SIGTERM and exits 143 on its own, so the flag says why
  if (child) { child.stopped = true; child.kill("SIGTERM"); }
  res.json({ ok: true });
});

module.exports = { stepOf, MODELS, EFFORTS, delegate, jobLine };
