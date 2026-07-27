// Re-download everything the dashboard used to pull from a CDN into
// server/public/vendor/. Run it only to bump a version — the output is
// committed, and comp day must work with the wifi unplugged.
//
//   node cmds/vendor.mjs
//
// esm.sh note: the plain https://esm.sh/react@18 URL is a re-export shim that
// still points at esm.sh. The real self-contained file is the `.bundle.mjs`
// path below. `X-ZXJlYWN0` is esm.sh's marker for "react left external", which
// is what keeps react-dom on the same react instance as the app.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const VENDOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "public", "vendor");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const FILES = {
  "three.min.js": "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js",
  "GLTFLoader.js": "https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js",
  "react.js": "https://esm.sh/react@18.3.1/es2022/react.bundle.mjs",
  // one react-dom for both "react-dom" and "react-dom/client" — it exports
  // createRoot, createPortal and flushSync, so no second copy of the reconciler.
  "react-dom.js": "https://esm.sh/react-dom@18.3.1/X-ZXJlYWN0/es2022/react-dom.bundle.mjs",
  "htm.js": "https://esm.sh/htm@3.1.1/es2022/htm.bundle.mjs",
};

// socket.io is NOT here: the server serves its own client at /socket.io/socket.io.js.
const FONTS_CSS = "https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@400;500;600;700;800;900&family=Caesar+Dressing&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap";

const get = async (url, headers = {}) => {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res;
};

fs.mkdirSync(path.join(VENDOR, "fonts"), { recursive: true });

for (const [name, url] of Object.entries(FILES)) {
  const buf = Buffer.from(await (await get(url)).arrayBuffer());
  fs.writeFileSync(path.join(VENDOR, name), buf);
  console.log(`${name}  ${(buf.length / 1024).toFixed(0)} KB`);
}

// Google hands back woff2 only to a browser UA. Keep the latin subsets (the UI
// is en/es) and drop cyrillic/greek/vietnamese — about half the bytes.
const css = await (await get(FONTS_CSS, { "User-Agent": UA })).text();
const out = [];
let bytes = 0;

for (const block of css.split(/(?=\/\* [a-z-]+ \*\/)/).filter(Boolean)) {
  const subset = block.match(/^\/\* ([a-z-]+) \*\//)?.[1];
  if (subset !== "latin" && subset !== "latin-ext") continue;
  const url = block.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/)?.[1];
  if (!url) continue;

  const fam = block.match(/font-family: '([^']+)'/)[1].replace(/\s+/g, "");
  const wght = block.match(/font-weight: (\d+)/)?.[1] || "400";
  const file = `${fam}-${wght}-${subset}.woff2`;

  const buf = Buffer.from(await (await get(url)).arrayBuffer());
  fs.writeFileSync(path.join(VENDOR, "fonts", file), buf);
  bytes += buf.length;
  out.push(block.replace(url, `fonts/${file}`).trimEnd());
}

fs.writeFileSync(path.join(VENDOR, "fonts.css"), out.join("\n") + "\n");
console.log(`fonts.css  ${out.length} faces, ${(bytes / 1024).toFixed(0)} KB`);

const left = fs.readFileSync(path.join(VENDOR, "fonts.css"), "utf8").match(/https?:\/\//g);
if (left) throw new Error(`fonts.css still points off-box: ${left.length} urls`);
