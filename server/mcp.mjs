#!/usr/bin/env node
// MCP stdio server for Blackout. Lets Claude Desktop / Claude Code see and drive
// the rover next to whatever else they can do on this machine. It is a thin
// client of the running dashboard server (npm start), so the link, the cam and
// Sage stay owned there and nothing here learns a second shape.
//
// IMPORTANT NOTE: hand-rolled JSON-RPC over newline-delimited stdio instead of
// @modelcontextprotocol/sdk -- tools only, no resources/prompts/sampling. Add the
// sdk if any of those are ever wanted.
//
// Claude Code:    claude mcp add blackout -- node "<repo>/server/mcp.mjs"
// Claude Desktop: mcpServers.blackout = { command: "node", args: ["<repo>/server/mcp.mjs"] }
// BLACKOUT_URL overrides http://127.0.0.1:3000.

import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const BASE = process.env.BLACKOUT_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;

async function api(path, body) {
  // x-blackout-mcp: the dashboard logs every call it sees with this, so an MCP
  // client driving the rover is never invisible to the operator.
  const headers = { "x-blackout-mcp": "1" };
  const r = await fetch(BASE + path, body === undefined ? { headers } : {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r;
}

const txt = (o) => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] });

// Sage is stateless per /api/chat call, so the conversation lives here.
const history = [];

export const TOOLS = {
  robot_status: {
    description: "Latest telemetry (temp C, humid %, dist cm -- 999 = nothing in range, pressure hPa, alt m since start, lux), whether the board link is up, and the current mission. data is null when nothing arrived in 10s.",
    inputSchema: { type: "object", properties: {} },
    run: async () => txt(await (await api("/api/now")).json()),
  },
  robot_camera: {
    description: "One fresh still from the rover's camera (cam 0 = front, 1 = gripper).",
    inputSchema: { type: "object", properties: { cam: { type: "integer", minimum: 0, maximum: 1 } } },
    run: async ({ cam = 0 }) => {
      const b = Buffer.from(await (await api(`/api/look?cam=${cam}`)).arrayBuffer());
      return { content: [{ type: "image", data: b.toString("base64"), mimeType: "image/jpeg" }] };
    },
  },
  robot_command: {
    description: [
      "Send one raw command line to the board, exactly what the dashboard sends.",
      "Drive (time-limited on the board, 50-10000ms, default 800): drv,fwd|back|left|right,<pwm 0-255>[,<ms>] or drv,tank,<l -255..255>,<r>[,<ms>]. Below ~90 pwm the motors only buzz.",
      "stop = halt everything. go,<routine> runs an on-board routine (test, mission, test2, run).",
      "Arm: arm,<joint 0-5>,<speed -100..100> (0 base,1 shoulder,2 elbow,3 wrist,4 gripwrist,5 gripper); every joint is a 360 with no end stop and a 3s deadman, so re-send within 3s to keep moving and send arm,<j>,0 or arm, to stop.",
      "Screensaver: scr,<n>, 0 off. Buzzer mute: buz,<0|1>.",
      "Check robot_status / robot_camera before and after moving -- there is no other feedback.",
    ].join(" "),
    inputSchema: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
    run: async ({ cmd }) => txt(await (await api("/api/cmd", { cmd })).json()),
  },
  robot_blk: {
    description: [
      "Run a BLK program on the rover and wait for it to finish (up to 2 min). This is the way to do anything conditional:",
      "\"go forward until 20cm\" is `forward until dist < 20 timeout 8000` -- compiled to the board, the stop happens in one loop() pass instead of a network round trip.",
      "One statement per line. Motion: forward|back|left|right <ms> or `... until <cond> [timeout <ms>]` (ms 50-10000; without a timeout an `until` move gives up after 2000ms).",
      "speed <pwm 60-255> (default 140, below ~90 only buzzes). wait <ms> | wait until <cond>. repeat <n> ... end, repeat until <cond> ... end, if <cond> ... else ... end, break, stop.",
      "set <var> <expr>, change <var> <n>. Blocks are indented two spaces and close with `end`; def <name> ... end + call <name>. #comments. Sensors in conditions/exprs: dist (cm, 999 = clear), temp, humid, pressure, lux, roll, pitch, yaw. say <text>, log <text> ({var} interpolates), led <0-255>, analyze [focus].",
      "Programs with only constant arguments and one comparison per condition run ON the board; and/or/maths fall back to the dashboard (slower stops) -- the result says where.",
      "Every bare `forward` is rewritten to stop at dist < 10; the sonar faces forward, so don't put dist checks on back/left/right. Needs the dashboard open and CONNECTed.",
    ].join(" "),
    inputSchema: { type: "object", properties: { program: { type: "string", description: "BLK source, newline-separated" } }, required: ["program"] },
    run: async ({ program }) => txt(await (await api("/api/blk-run", { text: program })).json()),
  },
  robot_mission: {
    description: "Set the mission (auto mode): with one set, Sage analyses the camera + sensors on her own whenever a reading changes level and speaks it on the dashboard. Empty string clears it.",
    inputSchema: { type: "object", properties: { mission: { type: "string" } }, required: ["mission"] },
    run: async ({ mission }) => txt(await (await api("/api/mission", { mission })).json()),
  },
  sage_chat: {
    description: "Talk to Sage, the rover's onboard AI. She can look through the camera and read sensors herself. Keeps a short conversation history.",
    inputSchema: { type: "object", properties: { message: { type: "string" }, lang: { type: "string", enum: ["en", "es"] } }, required: ["message"] },
    run: async ({ message, lang = "en" }) => {
      history.push({ role: "user", content: message });
      // moves:false -- her move/arm cards need the dashboard's YES press; the MCP
      // client drives with robot_command instead.
      const { reply, steps } = await (await api("/api/chat", { messages: history.slice(-12), lang, moves: false })).json();
      history.push({ role: "assistant", content: reply?.text || "" });
      if (history.length > 24) history.splice(0, history.length - 24);
      return txt({ text: reply?.text, status: reply?.status, finding: reply?.finding, used: steps?.map((s) => s.name) });
    },
  },
};

export async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return null;                    // notification
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  if (method === "initialize") return ok({
    protocolVersion: params?.protocolVersion || "2025-06-18",
    capabilities: { tools: {} },
    serverInfo: { name: "blackout", version: "1.0.0" },
  });
  if (method === "ping") return ok({});
  if (method === "tools/list") return ok({
    tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
  });
  if (method === "tools/call") {
    const t = TOOLS[params?.name];
    if (!t) return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${params?.name}` } };
    try { return ok(await t.run(params.arguments || {})); }
    catch (e) { return ok({ ...txt(`${e.message}${e.cause ? ` (${e.cause.code || e.cause.message}) -- is the dashboard server running at ${BASE}?` : ""}`), isError: true }); }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
}

if (process.argv.includes("--selftest")) {
  const { strict: assert } = await import("node:assert");
  assert.equal(await handle({ method: "notifications/initialized" }), null);
  assert.equal((await handle({ id: 1, method: "initialize", params: { protocolVersion: "x" } })).result.protocolVersion, "x");
  assert.deepEqual((await handle({ id: 2, method: "tools/list" })).result.tools.map((t) => t.name), Object.keys(TOOLS));
  assert.equal((await handle({ id: 3, method: "nope" })).error.code, -32601);
  assert.equal((await handle({ id: 4, method: "tools/call", params: { name: "nope" } })).error.code, -32602);
  console.log("mcp selftest ok");
} else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  createInterface({ input: process.stdin }).on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); }
    catch { return process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n"); }
    const out = await handle(msg);
    if (out) process.stdout.write(JSON.stringify(out) + "\n");
  });
}
