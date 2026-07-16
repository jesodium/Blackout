// Motion routines — this is the file you edit to choreograph the robot.
// Data only: no motor code, no BLE, no timing machinery. main.ino runs these.
//
// Each step is {op, ms, pwm}: what to do, for how long, at what speed (0-255).
// WAIT / ANALYZE / END ignore pwm — pass 0.
//
//   FWD BACK      both motors, straight
//   LEFT RIGHT    pivot turns — motors oppose, robot spins about its centre
//   WAIT          sit still
//   ANALYZE       stop and ask the dashboard for an AI read, then sit still `ms`
//   END           finish. EVERY routine needs one or it runs off the array.
//
// IMPORTANT NOTE: open loop — no encoders. `ms` buys you an angle/distance that
// drifts with battery charge and floor grip, so a 400ms pivot is not a fixed
// number of degrees. Tune on the real field, not the bench.
//
// ANALYZE is fire-and-forget: the board asks, never waits for the answer, and
// never sees it. A round-trip would put the PC back in the loop mid-run, which is
// exactly what running routines on-board avoids. Sage's verdict cannot steer the
// routine — `ms` is just "give it a couple seconds".
//
// Editing anything here means reflashing the board.
#pragma once

// Duty cycle 0-255. Below ~90 most geared DC motors won't break stiction — they
// just buzz. Tune per chassis/battery; a loaded robot needs more than a bench test.
#define SPEED_SLOW 125

enum Op : uint8_t { FWD, BACK, LEFT, RIGHT, WAIT, ANALYZE, END };
struct Step { Op op; uint16_t ms; uint8_t pwm; };

// Bench diagnostic — run this first, wheels off the ground. Fires every op once,
// in isolation, with a pause between so you can name what you're watching:
// forward, back, pivot left, pivot right, then an analyze. ~7s total.
//
// What it's checking: that each motor primitive does what its name says. If FWD
// drives backward or LEFT pivots right, one motor's wires are swapped — fix it at
// the L298N screw terminals, NOT by flipping pin logic here, or forward/back stop
// meaning the same thing for every other routine.
const Step TEST[] = {
  {FWD, 600, SPEED_SLOW},   {WAIT, 600, 0},
  {BACK, 600, SPEED_SLOW},  {WAIT, 600, 0},
  {LEFT, 600, SPEED_SLOW},  {WAIT, 600, 0},
  {RIGHT, 600, SPEED_SLOW}, {WAIT, 600, 0},
  {ANALYZE, 2500, 0},
  {END, 0, 0},
};

// Audience scan, dictated on the field. Pivot left / right / right / left in 501ms bursts
// at 140 — the whole move is theatre, it shows the judges the robot drives — then settle
// and analyse ONCE at the end. ~15s total. Net rotation is zero (LEFT and RIGHT cancel)
// so the final look faces where it started, at the audience.
//
// IMPORTANT NOTE: one ANALYZE, deliberately, and it goes last. Analysing between pivots
// made Sage greet the room four times over and talk over her own TTS — the camera-grab +
// model + TTS round trip is slower than the moves are. The pivots are for the audience to
// watch, not for Sage to look at; she only speaks once the robot is parked and still.
//
// The 1500 settle before it is what buys the still frame — analysing mid-coast gets a
// motion-blurred grab. The 10s dwell after is Sage's talking room; MISSION parks 10s too.
//
// IMPORTANT NOTE: 501ms at 140 is an unknown angle — open loop, see the note up top. Tune
// ms down if the pivots swing past the audience; leave pwm alone, it's clear of stiction.
const Step PRESENTATION[] = {
  {LEFT, 501, 140},
  {RIGHT, 501, 140},
  {RIGHT, 501, 140},
  {LEFT, 501, 140},
  {WAIT, 1500, 0},
  {ANALYZE, 10000, 0},
  {END, 0, 0},
};

// Dictated on the field. Moves are 125ms bursts at 103 — nudges, not travel — with
// 1.5s of settle between them and 10s parked on each ANALYZE so Sage gets a still
// frame of a robot that isn't moving.
//
// IMPORTANT NOTE: 125ms at pwm 103 is short and close to stiction on geared DC motors.
// It was 50ms and may have only buzzed; 125 gives the motors time to actually break
// away. Bench it — if a burst still does nothing, raise pwm rather than ms, the pwm is
// what beats stiction.
const Step MISSION[] = {
  {FWD, 125, 103},   {WAIT, 1500, 0},
  {FWD, 125, 103},   {WAIT, 1500, 0},
  {ANALYZE, 10000, 0},
  {BACK, 125, 103},  {WAIT, 1500, 0},
  {BACK, 125, 103},  {WAIT, 1500, 0},
  {RIGHT, 125, 103}, {WAIT, 1500, 0},
  {ANALYZE, 10000, 0},
  {BACK, 125, 103},  {WAIT, 1500, 0},
  {BACK, 125, 103},
  {END, 0, 0},
};

const Step RUN[] = { {END, 0, 0} }; // filled in on the field

// Adding a routine: write the table here, then add one line to startRoutine()
// in main.ino mapping its name, and a button in the dashboard masthead.
