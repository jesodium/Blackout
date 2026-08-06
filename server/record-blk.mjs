// screen-records the blk editor being used, for the landing page.
// needs: PORT=3111 node server.js  +  a debuggable chrome on 9333 (see test-blk-editor.mjs)
//   node record-blk.mjs   ->  /tmp/blkcast/*.jpg  ->  ffmpeg
import { open, sleep } from "./cdp.mjs";
import fs from "fs";

const DIR = "/tmp/blkcast";
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

const p = await open("http://localhost:3111/blk.html");
await p.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(1200);
await p.evaluate("localStorage.clear(); location.reload(); return 1").catch(() => {});
await sleep(2200);

// a visible cursor, so the recording reads as someone using it
await p.evaluate(`
  const c = document.createElement('div');
  c.id='__cur';
  c.style.cssText='position:fixed;z-index:99999;left:0;top:0;width:22px;height:22px;pointer-events:none;'+
    'border-radius:50%;background:rgba(255,255,255,.9);box-shadow:0 0 0 6px rgba(255,255,255,.18),0 2px 10px rgba(0,0,0,.6);'+
    'transform:translate(-50%,-50%);transition:transform 60ms linear';
  document.body.appendChild(c);
  window.__cur=(x,y,down)=>{c.style.left=x+'px';c.style.top=y+'px';c.style.transform='translate(-50%,-50%) scale('+(down?0.6:1)+')'};
  window.__cur(720,500,false);
  return 1;`);

const PTR = `const P=(el,type,x,y)=>{el.dispatchEvent(new PointerEvent(type,{bubbles:true,clientX:x,clientY:y,button:0,isPrimary:true,pointerId:1}));window.__cur(x,y,type!=='pointerup')};`;

// glide the cursor to a point over `steps` frames
const glide = (sel, nth = 0, dx = 40, dy = 0, steps = 18) => p.evaluate(`${PTR}
  const el=document.querySelectorAll('${sel}')[${nth}]; if(!el) return 0;
  const r=el.getBoundingClientRect(); const x1=r.left+${dx}, y1=r.top+r.height/2+${dy};
  const c=document.getElementById('__cur');
  const x0=parseFloat(c.style.left)||720, y0=parseFloat(c.style.top)||500;
  for(let i=1;i<=${steps};i++){
    const t=i/${steps}, e=1-Math.pow(1-t,3);
    window.__cur(x0+(x1-x0)*e, y0+(y1-y0)*e, false);
    await new Promise(r=>setTimeout(r,16));
  }
  return 1;`);

const tap = (sel, nth = 0, dx = 40) => p.evaluate(`${PTR}
  const el=document.querySelectorAll('${sel}')[${nth}]; if(!el) return 0;
  const r=el.getBoundingClientRect(), x=r.left+${dx}, y=r.top+r.height/2;
  P(el,'pointerdown',x,y); await new Promise(r=>setTimeout(r,90)); P(window,'pointerup',x,y);
  return 1;`);

// press on `from`, drag to `to` over `steps` frames, release
const drag = (fromSel, nth, toSel, toNth = 0, dy = 0, steps = 22) => p.evaluate(`${PTR}
  const a=document.querySelectorAll('${fromSel}')[${nth}], b=document.querySelectorAll('${toSel}')[${toNth}];
  if(!a||!b) return 0;
  const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
  const x0=ra.left+40, y0=ra.top+ra.height/2, x1=rb.left+50, y1=rb.top+rb.height/2+${dy};
  P(a,'pointerdown',x0,y0);
  for(let i=1;i<=${steps};i++){
    const t=i/${steps}, e=t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2;
    P(window,'pointermove',x0+(x1-x0)*e,y0+(y1-y0)*e);
    await new Promise(r=>setTimeout(r,16));
  }
  await new Promise(r=>setTimeout(r,140));
  P(window,'pointerup',x1,y1);
  await new Promise(r=>setTimeout(r,120));
  return 1;`);

/* --- record --- */
let n = 0;
const frames = [];
p.on((m) => {
  if (m.method !== "Page.screencastFrame") return;
  const f = `${DIR}/${String(n++).padStart(5, "0")}.jpg`;
  fs.writeFileSync(f, Buffer.from(m.params.data, "base64"));
  frames.push({ f, t: m.params.metadata.timestamp });
  p.send("Page.screencastFrameAck", { sessionId: m.params.sessionId });
});
await p.send("Page.startScreencast", { format: "jpeg", quality: 80, everyNthFrame: 1 });

await sleep(700);
// 1. drag a turn block in from the palette, under the first say
await glide("#palette .blk-head", 2);
await sleep(200);
await drag("#palette .blk-head", 2, "#canvas .blk-head", 1, 24);
await sleep(500);
// 2. retype its duration
await glide("#canvas input[type=number]", 1, 30);
await p.evaluate(`
  const el=[...document.querySelectorAll('#canvas input[type=number]')][1];
  el.focus(); el.select();
  for (const ch of "900"){ el.value = (el.value===el.defaultValue?'':el.value)+ch; }
  el.value="900"; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
  el.blur(); return 1;`);
await sleep(700);
// 3. tap a block to select it — the action bar comes up
await glide("#canvas .blk-head", 4);
await tap("#canvas .blk-head", 4);
await sleep(900);
await tap("#canvas", 0, 700); // deselect
await sleep(400);
// 4. run it in the simulator
await glide("#sim-run", 0, 90);
await sleep(200);
await p.evaluate(`${PTR}
  const b=document.getElementById('sim-run'), r=b.getBoundingClientRect();
  window.__cur(r.left+90,r.top+r.height/2,true); await new Promise(r=>setTimeout(r,120));
  b.click(); window.__cur(r.left+90,r.top+r.height/2,false); return 1;`);
await sleep(11000);
await p.evaluate("document.getElementById('sim-run').click(); return 1");
await sleep(600);

await p.send("Page.stopScreencast");
await sleep(300);
fs.writeFileSync(`${DIR}/frames.txt`, frames.map((fr, i) => {
  const dur = i < frames.length - 1 ? Math.max(0.016, frames[i + 1].t - fr.t) : 0.2;
  return `file '${fr.f}'\nduration ${dur.toFixed(3)}`;
}).join("\n") + `\nfile '${frames.at(-1).f}'\n`);
console.log("frames:", frames.length, "→", DIR);
await p.close();
