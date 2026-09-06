// icon names. each one needs an svg in public/icons/ and an .icn- rule in both
// style.css and blk.html.

export const ICON_NAMES = [
  "mic", "camera", "trash", "volume", "mute", "pause", "step", "timer", "warn", "gear",
  "shield", "shield-off",
];

export const prefixIcon = (node, name) => {
  const i = document.createElement("i");
  i.className = "icn icn-" + name;
  i.setAttribute("aria-hidden", "true");
  node.prepend(i, " ");
  return node;
};

export const icon = (name) => `<i class="icn icn-${name}" aria-hidden="true"></i>`;
