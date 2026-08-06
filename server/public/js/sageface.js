import React, { useEffect, useRef } from "react";
import htm from "htm";
const html = htm.bind(React.createElement);

/* sage's face — ascii glyphs, animated.
   every eye is two stacked glyphs (open + shut) and the blink is a step-timed
   opacity swap, so it snaps like text instead of fading like a shape. the mood
   picks the glyphs here; everything that moves is `.sage-face.is-<mood>` in
   style.css. adding a mood without its css rule renders a still face —
   `npm run test:face` is the check.

   IMPORTANT NOTE: no animation library. the whole rig is 3 spans and a handful
   of keyframes; a tweening lib would be more code than the face. */

// the moods app.js may ask for. test-sageface.mjs checks each one has css.
export const MOODS = ["idle", "scanning", "thinking", "clear", "caution", "alert", "work"];

// [left eye, mouth, right eye] — same glyph set the old face used.
const FACES = {
  idle:     ["-", "_", "-"],
  scanning: ["o", "_", "o"],
  thinking: ["o", "_", "O"],
  clear:    ["^", "_", "^"],
  caution:  [":", "o", ":"],
  alert:    ["x", "_", "x"],
  work:     ["O", "_", "O"],
};

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
      el.style.setProperty("--sf-gx", (dx * 0.14).toFixed(3) + "em");
      el.style.setProperty("--sf-gy", (dy * 0.1).toFixed(3) + "em");
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [gaze]);

  const m = MOODS.includes(mood) ? mood : "idle";
  const [l, mo, r] = FACES[m];
  return html`
    <div ref=${ref} class=${"sage-face is-" + m} aria-hidden="true">
      <span class="sf-scan">
        <span class="sf-eye sf-l"><b class="sf-open">${l}</b><b class="sf-shut">-</b></span>
        <span class="sf-mouth">${mo}</span>
        <span class="sf-eye sf-r"><b class="sf-open">${r}</b><b class="sf-shut">-</b></span>
      </span>
      <span class="sf-z">z</span>
    </div>`;
}
