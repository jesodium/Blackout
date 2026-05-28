# AGENTS — Shared Project Context

Read this first. All model-specific configs (claude.md, deepseek.md, gemini.md) delegate here.

## Doc Rules

- README.md → detailed codebase docs (lots of tokens)
- AGENTS.md → crucial codebase context (pinout, wiring, logic)

## Project

WRO 2026 — Arduino Mega 2560 robot. Motor control via L298N.

## L298N → Arduino Mega Wiring

```
POWER
  L298N 12V  ── Battery (7-12V)
  L298N GND  ── Arduino GND + Battery GND
  Jumper ON  ── enables onboard 5V regulator

MOTOR A (LEFT)
  IN1 ── Mega D8
  IN2 ── Mega D9
  ENA ── Mega D10 (PWM~)
  OUT1/OUT2 ── DC Motor A

MOTOR B (RIGHT)
  IN3 ── Mega D11
  IN4 ── Mega D12
  ENB ── Mega D13 (PWM~)
  OUT3/OUT4 ── DC Motor B
```

## Control Logic

| IN1/IN3 | IN2/IN4 | ENA/ENB | Motor State |
|---------|---------|---------|-------------|
| LOW     | LOW     | PWM     | BRAKE       |
| HIGH    | LOW     | PWM     | FORWARD     |
| LOW     | HIGH    | PWM     | BACKWARD    |
| HIGH    | HIGH    | PWM     | BRAKE       |

PWM duty cycle = speed (0-255).

## Code Location

All sketches in `main/`.
