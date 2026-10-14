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
const os = require("os");
const path = require("path");
const { app, io, localReq, PORT } = require("../http");

const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CLAUDE_CWD = process.env.CLAUDE_CWD || os.homedir();
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
  `Relative paths are from ${CLAUDE_CWD}. ` +
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

app.post("/api/claude", (req, res) => {
  if (!localReq(req)) return res.status(403).json({ error: "loopback only" });
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "text required" });
  if (child) return res.status(409).json({ error: "Claude is still working on the last one" });
  const session = /^[\w-]{8,64}$/.test(req.body?.session || "") ? req.body.session : null;
  const lang = req.body?.lang === "es" ? " Answer in Spanish." : "";
  const model = MODELS.includes(req.body?.model) ? req.body.model : "haiku";
  const effort = EFFORTS.includes(req.body?.effort) ? req.body.effort : "low";

  const args = ["-p", text, "--output-format", "stream-json", "--verbose",
    "--model", model, "--effort", effort,
    // only the rover's tools: the login's own claude.ai connectors would load on
    // every turn and slow the start for tools nobody here asked for
    "--permission-mode", "bypassPermissions", "--mcp-config", MCP, "--strict-mcp-config",
    "--disallowedTools", "mcp__blackout__sage_chat",
    "--append-system-prompt", PERSONA + lang];
  if (session) args.push("--resume", session);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const p = child = spawn(CLAUDE_BIN, args, { cwd: CLAUDE_CWD, env, stdio: ["ignore", "pipe", "pipe"] });

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
  p.on("close", (code) => {
    if (child === p) child = null;
    const reply = (result && !result.is_error && result.result) || said;
    if (p.stopped) return res.json({ text: "Stopped.", session: sid });
    if (!reply) return res.status(502).json({ error: (result?.result || err || `claude exited ${code}`).trim() });
    res.json({ text: String(reply).trim(), session: sid, cost: result?.total_cost_usd ?? null });
  });
});

app.post("/api/claude/stop", (req, res) => {
  // claude traps SIGTERM and exits 143 on its own, so the flag says why
  if (child) { child.stopped = true; child.kill("SIGTERM"); }
  res.json({ ok: true });
});

module.exports = { stepOf, MODELS, EFFORTS };
