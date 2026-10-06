import { useEffect, useState } from "react";
import { t } from "../i18n.js";
import { SENSORS, html, reads } from "./core.js";

// ---- verdict + mood ----
const INTENTS = {
  idle:     { key: "idle",     label: "intent.idle",     color: "var(--ink-3)" },
  scanning: { key: "scanning", label: "intent.scanning", color: "var(--ink-2)" },
  thinking: { key: "thinking", label: "intent.thinking", color: "var(--ink)"   },
  clear:    { key: "clear",    label: "intent.clear",    color: "var(--go)"     },
  caution:  { key: "caution",  label: "intent.caution",  color: "var(--warn)"   },
  alert:    { key: "alert",    label: "intent.alert",    color: "var(--accent)" },
};

function worstSensor(packet) {
  if (!packet) return null;
  let rank = -1;
  for (const s of SENSORS) {
    const v = packet[s.key];
    if (!reads(s, v)) continue;
    const k = s.st(v)[1];
    rank = Math.max(rank, k === "abort" ? 2 : k === "warn" ? 1 : 0);
  }
  return rank < 0 ? null : rank;
}

function assess(packet) {
  const rank = worstSensor(packet);
  if (rank == null) return { kind: "idle", label: t("verdict.awaiting"), cause: t("verdict.noTelemetry") };
  let cause = t("verdict.nominal");
  if (rank > 0) {
    for (const s of SENSORS) {
      const v = packet[s.key];
      if (!reads(s, v)) continue;
      const [lblKey, k] = s.st(v);
      if ((k === "abort" ? 2 : k === "warn" ? 1 : 0) === rank) { cause = `${t("sensor." + s.key)} · ${t(lblKey)}`; break; }
    }
  }
  if (rank === 2) return { kind: "abort", label: t("verdict.danger"), cause };
  if (rank === 1) return { kind: "warn",  label: t("verdict.caution"), cause };
  return { kind: "go", label: t("verdict.safe"), cause };
}

function deriveIntent(ai, packet, connected) {
  if (ai.analyzing) return INTENTS.thinking;
  const txt = (ai.text || "").toLowerCase();
  if (/\b(danger|abort|critical|hazard|emergency|evacuat|fire|toxic|peligro|abortar|crítico|critico|emergencia|evacua|fuego|tóxico|toxico)\b/.test(txt)) return INTENTS.alert;
  if (/\b(caution|warning|careful|slow|obstacle|collision|bump|approach|elevated|moderate|watch|steer|precaución|precaucion|advertencia|cuidado|lento|obstácul|obstacul|colisión|colision|acerca|moderad|vigila)\b/.test(txt)) return INTENTS.caution;
  if (/\b(clear|safe|normal|nominal|stable|good|proceed|no threat|all systems|despejado|seguro|estable|bien|procede|sin amenaza)\b/.test(txt)) return INTENTS.clear;
  const w = worstSensor(packet);
  if (w === 2) return INTENTS.alert;
  if (w === 1) return INTENTS.caution;
  if (w === 0) return INTENTS.clear;
  return connected ? INTENTS.scanning : INTENTS.idle;
}

function Stopwatch({ since }) {
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick(n => n + 1), 90); return () => clearInterval(id); }, [since]);
  return html`${((Date.now() - since) / 1000).toFixed(1)}s`;
}

export { Stopwatch, assess, deriveIntent };
