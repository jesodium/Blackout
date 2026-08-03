import React, { useEffect, useRef } from "react";
import htm from "htm";
const html = htm.bind(React.createElement);

/* sage's face — an svg eye rig, not a text glyph.
   the shapes are all drawn at once and cross-faded by mood, so every state change
   tweens (opacity + transform) instead of swapping a character. everything that
   moves lives in css (.sage-face.is-<mood> in style.css); this file only decides
   which mood is on and where the eyes are looking.

   IMPORTANT NOTE: rolled by hand rather than pulled in. the surveyed js options
   (CyberAgentAILab/Web-Eye-Animation, the roboeyes ports) are fullscreen
   black-canvas agents that inject global css — this dashboard is self-hosted, no
   cdn, and the face has to sit inline at 46px next to a label. */

// the moods app.js may ask for. test-sageface.mjs checks each one has css.
export const MOODS = ["idle", "scanning", "thinking", "clear", "caution", "alert", "work"];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function SageFace({ mood = "idle", gaze = true }) {
  const ref = useRef(null);

  // eyes follow the pointer. written straight to css vars — no state, no re-render.
  useEffect(() => {
    const el = ref.current;
    if (!gaze || !el) return;
    const onMove = (e) => {
      const r = el.getBoundingClientRect();
      if (!r.width) return;
      const dx = clamp((e.clientX - (r.left + r.width / 2)) / (r.width * 3), -1, 1);
      const dy = clamp((e.clientY - (r.top + r.height / 2)) / (r.height * 3), -1, 1);
      el.style.setProperty("--sf-gx", (dx * 7).toFixed(2) + "px");
      el.style.setProperty("--sf-gy", (dy * 5).toFixed(2) + "px");
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [gaze]);

  const m = MOODS.includes(mood) ? mood : "idle";
  return html`
    <svg ref=${ref} class=${"sage-face is-" + m} viewBox="0 0 120 76" aria-hidden="true">
      <g class="sf-eyes"><g class="sf-scan">
        <g class="sf-eye sf-l">
          <rect class="sf-open" x="24" y="14" width="26" height="32" rx="11" />
          <path class="sf-arc" d="M25 38 Q37 14 49 38" />
          <path class="sf-x" d="M26 18 L48 42 M48 18 L26 42" />
        </g>
        <g class="sf-eye sf-r">
          <rect class="sf-open" x="70" y="14" width="26" height="32" rx="11" />
          <path class="sf-arc" d="M71 38 Q83 14 95 38" />
          <path class="sf-x" d="M72 18 L94 42 M94 18 L72 42" />
        </g>
      </g></g>
      <g class="sf-mouth">
        <path class="sf-m-line" d="M48 62 H72" />
        <path class="sf-m-smile" d="M46 56 Q60 71 74 56" />
        <ellipse class="sf-m-o" cx="60" cy="60" rx="9.5" ry="11" />
      </g>
    </svg>`;
}
