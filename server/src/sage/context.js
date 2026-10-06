// The live lines a turn is built from: readings, mission, lamp, and what she is
// allowed to reach for (recorded arm takes, tapes, the gripper cam).
const state = require("../state");
const { readingLines, trendLine } = require("../status");
const { readArmMoves, readTapes } = require("../data");
const { camCount, getLed } = require("../vision");
const { armMovesFor } = require("./parse");

const missionLine = () => (state.currentMission ? `Your mission, briefed by the operator: ${state.currentMission}\n\n` : "");

const lampLine = () => `\nYour headlamp is at ${getLed()} of 255, and NOTHING moves it but you. If the picture you are looking at is too dark to make out, raise it. Judge that off the picture, never off the light reading — the lx number is there for the operator's screen, not for you to decide the lamp from.`;

function buildChatContext(data) {
  return `${missionLine()}Current readings from the rover right now (each line is already judged — trust the [STATUS] tag for the verdict, do NOT re-judge from the number, but DO say the number aloud with its unit when the operator asks about it):
${readingLines(data)}${trendLine(data)}${lampLine()}`;
}

function buildAiPrompt(data) {
  return `${missionLine()}Latest telemetry from your sensors — read the room and report to the operator. Each line is already judged: trust the [STATUS] tag for the verdict and do NOT re-judge from the raw number — but DO say the numbers aloud, value plus unit, when they are what the operator asked about or what you are reacting to.

${readingLines(data)}${trendLine(data)}${lampLine()}`;
}

// The takes are the whole of Sage's arm, so the list goes into her prompt from
// the file rather than being written into chat.md — record one in
// arm-configurator.sh and she can ask for it on the next turn, no edit anywhere.
function armLine() {
  const names = Object.keys(armMovesFor(readArmMoves(), "sage_can_use"));
  return [{ role: "system", content: names.length
    ? `ARM MOVES the crew recorded — these names, exactly as written, are the only arm moves you can ask for: ${names.map((n) => `"${n}"`).join(", ")}.`
    : "ARM: nothing has been recorded yet, so you have no arm moves at all. Never set \"arm\", and tell the operator there is nothing recorded if they ask for it." }];
}

// The same two flags an arm take carries, read by the same filter: a debug tape
// is exactly what should not be in Sage's hands during a presentation. There is
// no toggle in the drawer — the file is the editor, so it is a line of json.
// `sage_can_use` defaults to true (a bare take counts everywhere), same as arm.
function tapeLine() {
  const names = Object.keys(armMovesFor(readTapes(), "sage_can_use"));
  return [{ role: "system", content: names.length
    ? `RECORDED RUNS the crew drove and kept — these names, exactly as written, are the only runs you can ask to play: ${names.map((n) => `"${n}"`).join(", ")}.`
    : "RECORDED RUNS: nothing has been recorded, so you have none. Never set \"tape\"." }];
}

// A rig with one camera in CAM_URL has no gripper eye, and chat.md hands her the
// "armcam" tool either way -- so tell her, or she reaches for it and reports her
// gripper view as dark. Once, though: repeating it every turn is how it ends up
// in an answer nobody asked for.
function camLine() {
  return camCount > 1 ? [] : [{ role: "system", content:
    "NO GRIPPER EYE: this rig has only the forward camera. Never set \"tool\" to \"armcam\". If the operator asks about the arm camera, say once, plainly, that you have no eye down on the arm — then drop it and never mention it again." }];
}

// what every chat-shaped turn says when there is no packet to read
const contextOrDark = (d) => (d ? buildChatContext(d) : "No live readings right now — running dark.");

module.exports = { buildChatContext, buildAiPrompt, contextOrDark, armLine, tapeLine, camLine };
