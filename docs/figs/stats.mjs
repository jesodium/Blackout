import { execSync } from "child_process";
import fs from "fs";
const files = execSync("git ls-files", { maxBuffer: 1 << 28 }).toString().trim().split("\n");
const LANG = { js:"JavaScript", mjs:"JavaScript", ino:"C++ (Arduino)", h:"C++ (Arduino)", py:"Python", css:"CSS", html:"HTML", sh:"Shell", md:"Markdown", json:"JSON", yaml:"YAML", yml:"YAML" };
const skip = /vendor\/|models\/|\.min\.|node_modules|package-lock/;
const byLang = {}, byDir = {}, rows = [];
for (const f of files) {
  if (skip.test(f)) continue;
  const ext = f.split(".").pop();
  const lang = LANG[ext]; if (!lang) continue;
  let n = 0;
  try { n = fs.readFileSync(f, "utf8").split("\n").length; } catch { continue; }
  const dir = f.split("/")[0];
  byLang[lang] = (byLang[lang] || 0) + n;
  byDir[dir] = (byDir[dir] || 0) + n;
  rows.push({ f, lang, n });
}
rows.sort((a,b)=>b.n-a.n);
console.log(JSON.stringify({ byLang, byDir, top: rows.slice(0,25), total: rows.reduce((s,r)=>s+r.n,0), files: rows.length }, null, 1));
