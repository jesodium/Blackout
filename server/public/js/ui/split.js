import { useEffect, useRef } from "react";
import { t } from "../i18n.js";
import { html } from "./core.js";

// ---- pane splitters ----
// Drag a divider and the pane AFTER it takes a fixed px size; the pane before it
// keeps flex:1 and absorbs the rest, so panes always tile — no gaps, no overlap,
// no second layout to keep in step. Sizes are per rig in localStorage;
// double-click or Enter hands the pane back to the stylesheet.
// IMPORTANT NOTE: dead under 1024px — that layout stacks everything into one
// column and a pinned px size there is just a broken pane.
const SPLIT_MIN = 120;
function Split({ id, axis = "x" }) {
  const ref = useRef(null);
  const key = "split." + id;
  const y = axis === "y";
  // px === null hands the pane back to css.
  const size = (px) => {
    const pane = ref.current?.nextElementSibling;
    if (!pane) return;
    if (px == null) { pane.style.flex = ""; localStorage.removeItem(key); return; }
    const box = ref.current.parentElement;
    const room = (y ? box.clientHeight : box.clientWidth) - SPLIT_MIN;
    const v = Math.round(Math.min(Math.max(px, SPLIT_MIN), Math.max(SPLIT_MIN, room)));
    pane.style.flex = `0 0 ${v}px`;
    try { localStorage.setItem(key, v); } catch {}
  };
  useEffect(() => {
    if (window.innerWidth <= 1024) return;
    const v = +localStorage.getItem(key);
    if (v) size(v);
  }, []);
  const down = (e) => {
    const pane = ref.current.nextElementSibling;
    const from = y ? pane.offsetHeight : pane.offsetWidth;
    const p0 = y ? e.clientY : e.clientX;
    e.currentTarget.setPointerCapture(e.pointerId);
    // dragging toward the pane shrinks it, which is what a divider does
    const move = (ev) => size(from - ((y ? ev.clientY : ev.clientX) - p0));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const keys = (e) => {
    const pane = ref.current.nextElementSibling;
    const step = { ArrowLeft: 1, ArrowUp: 1, ArrowRight: -1, ArrowDown: -1 }[e.key];
    if (step) { e.preventDefault(); size((y ? pane.offsetHeight : pane.offsetWidth) + step * (e.shiftKey ? 40 : 10)); }
    else if (e.key === "Enter") { e.preventDefault(); size(null); }
  };
  return html`<div ref=${ref} class=${"split split--" + axis} role="separator" tabIndex="0"
    aria-orientation=${y ? "horizontal" : "vertical"} aria-label=${t("split.resize")}
    onPointerDown=${down} onDblClick=${() => size(null)} onKeyDown=${keys} />`;
}

export { Split };
