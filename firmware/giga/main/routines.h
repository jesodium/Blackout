#pragma once

// dictated Step tables. ms/pwm are open loop, so a spoken duration or angle wants
// bench tuning. adding one: table here, a case in startRoutine(), a dashboard button.

#define SPEED_SLOW 125

enum Op : uint8_t { FWD, BACK, LEFT, RIGHT, WAIT, ANALYZE, END };
struct Step { Op op; uint16_t ms; uint8_t pwm; };

const Step TEST[] = {
  {FWD, 600, SPEED_SLOW},   {WAIT, 600, 0},
  {BACK, 600, SPEED_SLOW},  {WAIT, 600, 0},
  {LEFT, 600, SPEED_SLOW},  {WAIT, 600, 0},
  {RIGHT, 600, SPEED_SLOW}, {WAIT, 600, 0},
  {ANALYZE, 2500, 0},
  {END, 0, 0},
};

const Step PRESENTATION[] = {
  {LEFT, 501, 140},
  {RIGHT, 501, 140},
  {RIGHT, 501, 140},
  {LEFT, 501, 140},
  {WAIT, 1500, 0},
  {ANALYZE, 10000, 0},
  {END, 0, 0},
};

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

const Step RUN[] = { {END, 0, 0} };
