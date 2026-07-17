// motion routines — edit this file to choreograph the robot.
// data only: no motor code, no ble, no timing machinery. main.ino runs these.
//
// each step is {op, ms, pwm}: what to do, for how long, at what speed (0-255).
// wait / analyze / end ignore pwm — pass 0.
//
//   fwd back      both motors, straight
//   left right    pivot turns — motors oppose, robot spins about its centre
//   wait          sit still
//   analyze       stop and ask the dashboard for an ai read, then sit still `ms`
//   end           finish. every routine needs one or it runs off the array.
//
// important note: open loop — no encoders. `ms` buys you an angle/distance that
// drifts with battery charge and floor grip, so a 400ms pivot is not a fixed
// number of degrees. tune on the real field, not the bench.
//
// analyze is fire-and-forget: the board asks, never waits for the answer, and
// never sees it. a round-trip would put the pc back in the loop mid-run, which is
// exactly what running routines on-board avoids. sage's verdict cannot steer the
// routine — `ms` is just "give it a couple seconds".
//
// editing anything here means reflashing the board.
#pragma once

// duty cycle 0-255. below ~90 most geared dc motors won't break stiction — they
// just buzz. tune per chassis/battery, a loaded robot needs more than a bench test.
#define SPEED_SLOW 125

enum Op : uint8_t { FWD, BACK, LEFT, RIGHT, WAIT, ANALYZE, END };
struct Step { Op op; uint16_t ms; uint8_t pwm; };

// bench diagnostic — run this first, wheels off the ground. fires every op once,
// in isolation, with a pause between so you can name what you're watching:
// forward, back, pivot left, pivot right, then an analyze. ~7s total.
//
// what it checks: each motor primitive does what its name says. if fwd
// drives backward or left pivots right, one motor's wires are swapped — fix it at
// the l298n screw terminals, not by flipping pin logic here, or forward/back stop
// meaning the same thing for every other routine.
const Step TEST[] = {
  {FWD, 600, SPEED_SLOW},   {WAIT, 600, 0},
  {BACK, 600, SPEED_SLOW},  {WAIT, 600, 0},
  {LEFT, 600, SPEED_SLOW},  {WAIT, 600, 0},
  {RIGHT, 600, SPEED_SLOW}, {WAIT, 600, 0},
  {ANALYZE, 2500, 0},
  {END, 0, 0},
};

// audience scan, dictated on the field. pivot left / right / right / left in 501ms bursts
// at 140 — the whole move is theatre, it shows the judges the robot drives — then settle
// and analyse once at the end. ~15s total. net rotation is zero (left and right cancel)
// so the final look faces where it started, at the audience.
//
// important note: one analyze, deliberately, and it goes last. analysing between pivots
// made sage greet the room four times over and talk over her own tts — the camera-grab +
// model + tts round trip is slower than the moves are. the pivots are for the audience to
// watch, not for sage to look at, she only speaks once the robot is parked and still.
//
// the 1500 settle before it is what buys the still frame — analysing mid-motion gets a
// motion-blurred grab. the 10s dwell after is sage's talking room, mission parks 10s too.
//
// important note: 501ms at 140 is an unknown angle — open loop, see the note up top. tune
// ms down if the pivots swing past the audience, leave pwm alone, it's clear of stiction.
const Step PRESENTATION[] = {
  {LEFT, 501, 140},
  {RIGHT, 501, 140},
  {RIGHT, 501, 140},
  {LEFT, 501, 140},
  {WAIT, 1500, 0},
  {ANALYZE, 10000, 0},
  {END, 0, 0},
};

// dictated on the field. moves are 125ms bursts at 103 — nudges, not travel — with
// 1.5s of settle between them and 10s parked on each analyze so sage gets a still
// frame of a robot that isn't moving.
//
// important note: 125ms at pwm 103 is short and close to stiction on geared dc motors.
// it was 50ms and may have only buzzed, 125 gives the motors time to actually break
// away. bench it — if a burst still does nothing, raise pwm rather than ms, pwm is
// what beats stiction. test2 below is this same routine at 215ms, for a/b on the field.
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

// mission with every burst at 215ms instead of 125ms — same ops, same pwm, same
// waits. on-field a/b for whether the 125ms nudges are actually moving the robot or
// just buzzing. whichever wins, fold the number back into mission and delete this.
//
// button-only, on purpose: no cmd_triggers phrase in app.js, so sage can't
// start it. it's a trial routine — it runs when someone at the field presses ▶test2,
// not because a spoken phrase happened to match mid-demo.
const Step TEST2[] = {
  {FWD, 215, 103},   {WAIT, 1500, 0},
  {FWD, 215, 103},   {WAIT, 1500, 0},
  {ANALYZE, 10000, 0},
  {BACK, 215, 103},  {WAIT, 1500, 0},
  {BACK, 215, 103},  {WAIT, 1500, 0},
  {RIGHT, 215, 103}, {WAIT, 1500, 0},
  {ANALYZE, 10000, 0},
  {BACK, 215, 103},  {WAIT, 1500, 0},
  {BACK, 215, 103},
  {END, 0, 0},
};

const Step RUN[] = { {END, 0, 0} }; // filled in on the field

// adding a routine: write the table here, then add one line to startroutine()
// in main.ino mapping its name, and a button in the dashboard masthead.
