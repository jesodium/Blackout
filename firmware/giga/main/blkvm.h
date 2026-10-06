// instruction layout, shared with compile() in blk.mjs — keep BOPS in step with this

#pragma once

#define BLK_MAX 200
#define BLK_VARS 8
#define BLK_EVT_MS 60000

enum Bop : uint8_t { B_END, B_MOVE, B_MOVEU, B_WAIT, B_WAITU, B_SPEED, B_SET, B_ADD, B_JMP, B_JMPF, B_EVT, B_STOP };

struct Ins { uint8_t op, a, lhs, cmp; int16_t b, c; float rhs; };
