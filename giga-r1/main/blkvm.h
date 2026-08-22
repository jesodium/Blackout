// instruction set for blk workflows uploaded from the dashboard.
// data only: the vm that runs these lives in main.ino, next to the motor code.
#pragma once

/* ───────────────────────── blk vm ─────────────────────────
   a workflow authored in the dashboard's blk editor is compiled in the browser
   and *uploaded here* before it runs, so the board plays it standalone the way
   routines.h tables do. the point is the sensor conditions: `forward until
   dist < 15` interpreted over ble costs a ~400ms round trip per burst (write ->
   drive -> notify -> decide) and the rover overshoots. here it's one loop() pass.

   the pc is still in the loop for what only it has — sage, tts, the camera, the
   headlamp. those compile to B_EVT: the board halts, notifies "E:blk,...", and
   for kind 1/2 parks until the browser writes "blk,res,<v>". a silent browser
   times out (BLK_EVT_MS) and the program carries on rather than hanging — same
   reasoning as routines.h's fire-and-forget analyze.

   a ble drop mid-program is deliberately not fatal: the wheels are already
   time-limited per instruction, and stranding a running program is exactly what
   uploading it avoids. "stop" is what ends it.

   the instruction set is narrow on purpose (const args, one-term comparisons).
   the compiler in server/public/js/blk.mjs refuses anything else and runs that
   workflow in the browser instead — so the language stays whole up there and
   this stays small. op numbers and the upload line are shared with BOPS there;
   change one, change both. npm test covers the pairing. */
#define BLK_MAX 200      // instructions — 2.4KB, blk.mjs refuses anything longer
#define BLK_VARS 8       // variable slots, likewise
#define BLK_EVT_MS 60000 // longest we'll wait on the browser for one evt answer

enum Bop : uint8_t { B_END, B_MOVE, B_MOVEU, B_WAIT, B_WAITU, B_SPEED, B_SET, B_ADD, B_JMP, B_JMPF, B_EVT, B_STOP };
// fields by op: move a=verb c=ms · moveu a=verb c=timeout +cond · wait c=ms
// waitu c=timeout +cond · speed b=pwm · set/add a=slot rhs=value · jmp/jmpf c=target
// (+cond on jmpf: jump when it's false) · evt a=kind b=node c=slot
struct Ins { uint8_t op, a, lhs, cmp; int16_t b, c; float rhs; };

