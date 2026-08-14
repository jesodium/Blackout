// the ui's icon set. the drawings are files — public/icons/<name>.svg — and the
// css paints them: `.icn-<name>` masks the file with currentColor, so an icon is
// just a class name and it inherits the colour and size of the text it sits in.
// no icon font, no cdn (comp-day rule: the venue has no internet), no emoji —
// an emoji is a different picture on every machine the judges bring.
//
// IMPORTANT NOTE: geometric glyphs (✕ ● ○ △ ▶ ■ …) are NOT emoji and stay as
// text — they're the terminal look, and on the pad they *are* the button faces.
//
// adding one: drop the .svg in public/icons/, add the name here and a
// `.icn-<name>` rule in style.css (+ blk.html's own <style>). test-icons.mjs
// checks all three line up.
export const ICON_NAMES = [
  "mic", "camera", "trash", "volume", "mute", "pause", "step", "timer", "warn", "gear",
];

// plain dom: prefix an element with an icon without touching its text
export const prefixIcon = (node, name) => {
  const i = document.createElement("i");
  i.className = "icn icn-" + name;
  i.setAttribute("aria-hidden", "true");
  node.prepend(i, " ");
  return node;
};

// for innerHTML callers (static labels)
export const icon = (name) => `<i class="icn icn-${name}" aria-hidden="true"></i>`;
