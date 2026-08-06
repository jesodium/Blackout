// One-shot: server/public/brand.svg -> build/icon.png (1024) + build/icon.icns.
// Uses server's sharp + macOS sips/iconutil — no new deps. Outputs are committed;
// packaging never runs this.
import { createRequire } from "module";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sharp = createRequire(path.join(here, "..", "server", "package.json"))("sharp");

const svg = path.join(here, "..", "server", "public", "brand.svg");
const build = path.join(here, "build");
const iconset = path.join(build, "icon.iconset");
fs.mkdirSync(iconset, { recursive: true });

const png = path.join(build, "icon.png");
await sharp(svg, { density: 300 }).resize(1024, 1024).png().toFile(png);

for (const s of [16, 32, 64, 128, 256, 512]) {
  execFileSync("sips", ["-z", String(s), String(s), png, "--out", path.join(iconset, `icon_${s}x${s}.png`)]);
  execFileSync("sips", ["-z", String(s * 2), String(s * 2), png, "--out", path.join(iconset, `icon_${s}x${s}@2x.png`)]);
}
execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(build, "icon.icns")]);
fs.rmSync(iconset, { recursive: true });
console.log("icon.png + icon.icns written to", build);
