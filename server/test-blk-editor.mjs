// browser smoke test for the blk editor — drives the real page over CDP, with
// pointer events, the way a finger would. needs two things running, then:
//   node test-blk-editor.mjs
//   1. this server            PORT=3111 node server.js
//   2. a debuggable chrome    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
//                               --headless=new --remote-debugging-port=9333 --user-data-dir=/tmp/blk-chrome about:blank
// override with BLK_TEST_URL / BLK_TEST_CDP. ws comes in with socket.io.
import WebSocket from "ws";

const URL_PAGE = process.env.BLK_TEST_URL || "http://localhost:3111/blk.html";
const CDP = process.env.BLK_TEST_CDP || "http://localhost:9333";
const ORIGIN = URL_PAGE.replace(/\/blk\.html$/, "");

const t = await (await fetch(CDP + "/json/new?" + encodeURIComponent(URL_PAGE), { method: "PUT" })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const errors = [];
await new Promise(r => ws.on("open", r));
ws.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push("EXCEPTION: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push("CONSOLE: " + m.params.args.map(a => a.value || a.description).join(" "));
});
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval failed");
  return r.result.result.value;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// the editor listens for pointer events, not clicks — so does this test
const PTR = `const P=(el,type,x,y)=>el.dispatchEvent(new PointerEvent(type,{bubbles:true,clientX:x,clientY:y,button:0,isPrimary:true,pointerId:1}));`;
const tap = (sel, nth = 0) => evaluate(`${PTR}
  const el=document.querySelectorAll('${sel}')[${nth}]; if(!el) return 0;
  const r=el.getBoundingClientRect(), x=r.left+8, y=r.top+r.height/2;
  P(el,'pointerdown',x,y); P(window,'pointerup',x,y); return 1;`);
// press, move in steps (so the 8px threshold trips), release over the target
const dragTo = (fromSel, nth, toSel, dy = 0) => evaluate(`${PTR}
  const a=document.querySelectorAll('${fromSel}')[${nth}], b=document.querySelector('${toSel}');
  if(!a||!b) return 0;
  const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
  const x0=ra.left+8, y0=ra.top+ra.height/2;
  const x1=rb.left+Math.min(40,rb.width/2), y1=rb.top+rb.height/2+${dy};
  P(a,'pointerdown',x0,y0);
  for(let i=1;i<=6;i++) P(window,'pointermove',x0+(x1-x0)*i/6,y0+(y1-y0)*i/6);
  await new Promise(r=>setTimeout(r,30));
  P(window,'pointerup',x1,y1);
  await new Promise(r=>setTimeout(r,60));
  return 1;`);

await send("Runtime.enable");
await send("Page.enable");
// a real console window: under 1280px the simulator rail becomes a drawer
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await sleep(1200);
// start from a clean slate: the editor restores its autosaved draft otherwise
await evaluate("localStorage.clear(); location.reload(); return 1").catch(() => {});
await sleep(1600);

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? " — " + extra : ""}`); };
const count = () => evaluate("return document.querySelectorAll('#canvas .blk-node').length");

/* 1. boot */
check("page rendered blocks", (await count()) > 3, `${await count()} nodes`);
check("palette built", (await evaluate("return document.querySelectorAll('#palette .blk-node').length")) > 20);
check("category strip built", (await evaluate("return document.querySelectorAll('#cats .cat-btn').length")) === 7);
check("estimate shown", /blocks/.test(await evaluate("return document.getElementById('meta').textContent")));

/* 2. palette tap inserts (pointer tap, not a click) */
const before = await count();
await tap("#palette .blk-head");
check("palette tap inserts a block", (await count()) === before + 1);

/* 3. undo / redo */
await evaluate("document.getElementById('undo').click(); return 1");
check("undo removes it", (await count()) === before);
await evaluate("document.getElementById('redo').click(); return 1");
check("redo puts it back", (await count()) === before + 1);

/* 4. tap selects and raises the action bar */
await tap("#canvas .blk-head", 1);
check("tap selects a block", (await evaluate("return document.querySelectorAll('#canvas .is-sel').length")) === 1);
check("action bar shown", (await evaluate("return document.getElementById('actionbar').hidden")) === false,
  await evaluate("return document.getElementById('act-what').textContent"));

/* 5. every destructive action works by touch alone */
await evaluate("document.getElementById('act-dup').click(); return 1");
check("action bar duplicates", (await count()) === before + 2);
await evaluate("document.getElementById('act-off').click(); return 1");
check("action bar disables", (await evaluate("return document.querySelectorAll('#canvas .is-off').length")) === 1);
await evaluate("document.getElementById('act-del').click(); return 1");
check("action bar deletes", (await count()) === before + 1);
check("action bar hides after delete", (await evaluate("return document.getElementById('actionbar').hidden")) === true);

/* 6. drag a block in from the palette, and drag one out to the bin */
const n0 = await count();
await dragTo("#palette .blk-head", 2, "#canvas .blk-head", 0);
check("drag from palette drops on the canvas", (await count()) === n0 + 1, `${n0} -> ${await count()}`);
await evaluate(`${PTR}
  const a=document.querySelector('#canvas .blk-head'); const r=a.getBoundingClientRect();
  P(a,'pointerdown',r.left+8,r.top+10);
  for(let i=1;i<=4;i++) P(window,'pointermove',r.left+8+i*10,r.top+10+i*10);
  return 1;`);
check("bin appears while dragging", (await evaluate("return document.getElementById('trash').hidden")) === false);
await evaluate(`${PTR}
  const b=document.getElementById('trash'), rb=b.getBoundingClientRect();
  const x=rb.left+rb.width/2, y=rb.top+rb.height/2;
  P(window,'pointermove',x,y); P(window,'pointerup',x,y);
  await new Promise(r=>setTimeout(r,60)); return 1;`);
check("dropping on the bin deletes", (await count()) === n0, `${await count()} nodes`);
check("bin hidden again", (await evaluate("return document.getElementById('trash').hidden")) === true);

/* 7. text view roundtrip */
await evaluate("document.getElementById('tab-text').click(); return 1");
const txt = await evaluate("return document.getElementById('code').value");
check("text view serialised", txt.includes("forever") && txt.includes("speed"), JSON.stringify(txt.split("\n")[0]));
await evaluate(`const c=document.getElementById('code'); c.value='speed 120\\nset n 0\\nrepeat 3\\n  forward 300\\n  change n 1\\nend\\nsay done {n}'; document.getElementById('tab-blocks').click(); return 1`);
check("text edits flow back to blocks", (await count()) === 6, `${await count()} nodes`);
check("var block rendered", (await evaluate("return document.querySelectorAll('#canvas .cat-data').length")) === 2);

/* 7b. the condition picker can't be made to say something silly */
await evaluate(`document.getElementById('tab-text').click();
  const c=document.getElementById('code');
  c.value='ask is it clear\\nif answer = 1\\n  forward 300\\nend\\nset hits 0';
  document.getElementById('tab-blocks').click(); return 1`);
const condSels = () => evaluate("return [...document.querySelectorAll('#canvas .cat-control select')].map(s=>s.value).join('|')");
check("flag condition reads as a picker", (await condSels()).startsWith("answer|="), await condSels());
check("flag value is a yes/no list", (await evaluate("return [...document.querySelectorAll('#canvas .cat-control select')][2].options.length")) === 2);
check("flag comparators are limited to is / is not", (await evaluate("return [...document.querySelectorAll('#canvas .cat-control select')][1].options.length")) === 2);
check("your own variables are offered", (await evaluate(`
  return [...document.querySelectorAll('#canvas .cat-control select')[0].options].some(o=>o.value==='hits')`)) === true);
// switch the variable to a sensor: comparator and value must follow it
await evaluate(`const s=document.querySelectorAll('#canvas .cat-control select')[0];
  s.value='dist'; s.dispatchEvent(new Event('change')); return 1`);
await sleep(200);
check("switching to a sensor fixes up the row", (await condSels()).startsWith("dist|<"), await condSels());
check("value became a sensible default", (await evaluate("return document.querySelector('#canvas .cat-control input[type=number]').value")) === "20");
check("unit is shown", (await evaluate("return [...document.querySelectorAll('#canvas .cat-control .unit')].map(u=>u.textContent).join(',')")).includes("cm"));
check("sensor equality is linted", (await evaluate(`
  document.getElementById('tab-text').click();
  document.getElementById('code').value='if dist = 20\\nend';
  document.getElementById('tab-blocks').click();
  await new Promise(r=>setTimeout(r,120));
  return document.getElementById('lint').textContent`)).includes("almost never hits a number exactly"));
await evaluate(`document.getElementById('tab-text').click();
  document.getElementById('code').value='ask is it clear\\nif answer = 1\\n  forward 300\\nend\\nset hits 0';
  document.getElementById('tab-blocks').click(); return 1`);
// and back to the flag: the number can't survive as a comparison
await evaluate(`const s=document.querySelectorAll('#canvas .cat-control select')[0];
  s.value='answer'; s.dispatchEvent(new Event('change')); return 1`);
await sleep(200);
check("switching back to a flag re-limits the row", (await condSels()).startsWith("answer|="), await condSels());
check("nonsense text still lints", (await evaluate(`
  document.getElementById('tab-text').click();
  const c=document.getElementById('code');
  c.value='ask q\\nif answer <= 20\\n  forward 300\\nend';
  document.getElementById('tab-blocks').click();
  await new Promise(r=>setTimeout(r,120));
  return document.getElementById('lint').textContent`)).includes("only ever 0 or 1"));
check("and that condition falls back to the text field", (await evaluate("return document.querySelectorAll('#canvas .cat-control select').length")) === 0);

/* 8. bad text is refused */
await evaluate("document.getElementById('tab-text').click(); return 1");
await evaluate("document.getElementById('code').value='jump 3'; document.getElementById('tab-blocks').click(); return 1");
check("broken text blocks the view switch", (await evaluate("return document.getElementById('pane-text').hidden")) === false);
check("error surfaced in status", (await evaluate("return document.getElementById('status').className")).includes("is-err"));
await evaluate("document.getElementById('code').value='speed 120\\nrepeat 2\\n  forward 300\\nend'; document.getElementById('tab-blocks').click(); return 1");
check("good text switches back", (await evaluate("return document.getElementById('pane-blocks').hidden")) === false);

/* 9. simulator */
await evaluate("document.getElementById('sim-speed').value='100'; document.getElementById('sim-speed').dispatchEvent(new Event('change')); document.getElementById('sim-run').click(); return 1");
await sleep(2500);
check("sim produced log rows", (await evaluate("return document.querySelectorAll('#sim-log .sim-row').length")) > 0);
check("sim moved the rover", !/dist 170cm · yaw 0/.test(await evaluate("return document.getElementById('sim-tele').textContent")),
  await evaluate("return document.getElementById('sim-tele').textContent"));
check("run button reset", /run sim/i.test(await evaluate("return document.getElementById('sim-run').textContent")));
check("hit badges rendered", (await evaluate("return document.querySelectorAll('#canvas .hits').length")) >= 2,
  await evaluate("return [...document.querySelectorAll('#canvas .hits')].map(e=>e.textContent).join(',')"));

/* 10. breakpoint — set from the action bar, marked with a dot, pauses the run */
await evaluate("return document.querySelectorAll('#canvas .blk-head .bp').length");
check("no breakpoint control on blocks", (await evaluate("return document.querySelectorAll('#canvas .blk-head .bp').length")) === 0);
await tap("#canvas .blk-head", 1);
await evaluate("document.getElementById('act-bp').click(); return 1");
check("armed breakpoint shows a dot", (await evaluate("return document.querySelectorAll('#canvas .bpdot').length")) === 1);
await evaluate(`document.getElementById('sim-run').click(); return 1`);
await sleep(1200);
check("breakpoint paused the sim", /resume/i.test(await evaluate("return document.getElementById('sim-pause').textContent")));
await evaluate("document.getElementById('sim-run').click(); return 1"); // stop
await sleep(300);

/* 10b. the run controls live in the simulator — closing it stops the run */
check("run button is not in the top bar", (await evaluate("return !!document.querySelector('.bar #sim-run')")) === false);
check("ask sage is labelled", /ask sage/i.test(await evaluate("return document.getElementById('ask-sage').textContent")));
await evaluate("document.getElementById('sim-run').click(); return 1");
await sleep(500);
check("sim started from the rail", /stop/i.test(await evaluate("return document.getElementById('sim-run').textContent")));
await evaluate("document.getElementById('rail-close').click(); return 1");
await sleep(400);
check("closing the simulator stops the run", /run sim/i.test(await evaluate("return document.getElementById('sim-run').textContent")));
check("rail actually closed", (await evaluate("return document.body.classList.contains('rail-open')")) === false);
check("stop was logged", (await evaluate("return document.getElementById('sim-log').textContent")).includes("stopped by operator"));
await evaluate("document.getElementById('rail-toggle').click(); return 1"); // back for the rest

/* 11. arena editing + live sensors */
await evaluate(`${PTR}
  const cv=document.getElementById('sim-canvas'), r=cv.getBoundingClientRect();
  P(cv,'pointerup',r.left+r.width*0.5,r.top+r.height*0.8); return 1`);
check("arena tap handled", (await evaluate("return document.getElementById('sim-tele').textContent")).length > 5);
await evaluate("const t=document.getElementById('live-toggle'); t.checked=true; t.dispatchEvent(new Event('change')); return 1");
check("live sensors toggle", (await evaluate("return document.getElementById('status').textContent")).includes("live"));
await evaluate("const t=document.getElementById('live-toggle'); t.checked=false; t.dispatchEvent(new Event('change')); return 1");

/* 12. palette search + categories */
await evaluate("const s=document.getElementById('search'); s.value='say'; s.dispatchEvent(new Event('input')); return 1");
check("search filters the palette", (await evaluate("return document.querySelectorAll('#palette .blk-node').length")) <= 3);
await evaluate("document.querySelectorAll('#cats .cat-btn')[6].click(); return 1"); // AI
check("category filters the palette", (await evaluate("return document.querySelectorAll('#palette .blk-node').length")) === 3);
await evaluate("document.querySelectorAll('#cats .cat-btn')[0].click(); return 1"); // All

/* 13. files sheet + templates */
await evaluate("document.getElementById('menu-btn').click(); return 1");
check("files sheet opens", (await evaluate("return document.getElementById('files-sheet').hidden")) === false);
await evaluate("const s=document.getElementById('tpl'); s.value='Cave survey'; s.dispatchEvent(new Event('change')); return 1");
check("template loaded", (await count()) > 6, `${await count()} nodes`);
await sleep(260);  // sheet fades out
check("sheet closed after loading", (await evaluate("return document.getElementById('files-sheet').hidden")) === true);
check("ai blocks present", (await evaluate("return document.querySelectorAll('#canvas .cat-ai').length")) >= 2);
check("proc blocks present", (await evaluate("return document.querySelectorAll('#canvas .cat-proc').length")) >= 2);

/* 14. sage modal */
await evaluate("document.getElementById('ask-sage').click(); return 1");
check("sage modal opens", (await evaluate("return document.getElementById('sage-modal').hidden")) === false);
await evaluate("document.getElementById('sage-close').click(); return 1");
await sleep(320);
check("sage modal closes", (await evaluate("return document.getElementById('sage-modal').hidden")) === true);

/* 15. keyboard accelerators still work on a desktop */
await tap("#canvas .blk-head");
const n1 = await count();
await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'d',ctrlKey:true})); return 1");
check("ctrl+D duplicates", (await count()) === n1 + 1);
await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'c',ctrlKey:true})); return 1");
await sleep(120);
await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'v',ctrlKey:true})); return 1");
await sleep(360);
check("ctrl+C / ctrl+V pastes", (await count()) === n1 + 2, `${n1} -> ${await count()}`);

/* 16. tablet layout: panels collapse into drawers, targets stay thumb-sized */
await send("Emulation.setDeviceMetricsOverride", { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true });
await send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }] });
await sleep(300);
await evaluate("location.reload(); return 1");
await sleep(1700);
check("palette starts closed on a tablet", (await evaluate("return document.body.classList.contains('palette-open')")) === false);
check("rail starts closed on a tablet", (await evaluate("return document.body.classList.contains('rail-open')")) === false);
await evaluate("document.getElementById('palette-toggle').click(); return 1");
check("palette drawer opens", (await evaluate("return document.body.classList.contains('palette-open')")) === true);
check("scrim covers the canvas", (await evaluate("return document.getElementById('scrim').hidden")) === false);
await evaluate("document.getElementById('scrim').click(); return 1");
check("scrim tap closes the drawer", (await evaluate("return document.body.classList.contains('palette-open')")) === false);
const headH = await evaluate("return Math.round(document.querySelector('#canvas .blk-head').getBoundingClientRect().height)");
check("blocks are thumb-sized", headH >= 44, headH + "px tall");
await tap("#canvas .blk-head");
const delH = await evaluate("const b=document.getElementById('act-del').getBoundingClientRect(); return Math.round(Math.min(b.width,b.height))");
check("action bar buttons are thumb-sized", delH >= 44, delH + "px");
await send("Emulation.setEmulatedMedia", { features: [] });
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

/* 17. save round-trip through the api */
await evaluate("document.getElementById('name').value='cdp-test'; document.getElementById('save').click(); return 1");
await sleep(700);
const saved = await (await fetch(`${ORIGIN}/api/blk/cdp-test`)).text();
check("saved to the server", saved.includes("forward"), JSON.stringify(saved.split("\n")[0]));
await fetch(`${ORIGIN}/api/blk/cdp-test`, { method: "DELETE" });

/* 18. sage chats save themselves and can be reopened. no AI key needed — a 503
   still lands as a reply, which is exactly what has to survive the round trip. */
await evaluate("document.getElementById('ask-sage').click(); return 1");
await evaluate("document.getElementById('sage-input').value='patrol the room'; document.getElementById('sage-form').dispatchEvent(new Event('submit',{cancelable:true})); return 1");
await sleep(1200);
const chats = () => evaluate(`return JSON.parse(localStorage.getItem('blk.sage.chats')||'[]')`);
check("chat saved itself", (await chats())[0]?.title === "patrol the room", JSON.stringify(await chats()));
await evaluate("document.getElementById('sage-new').click(); return 1");
check("new chat clears the thread", (await evaluate("return document.querySelectorAll('#sage-msgs .sage-msg').length")) === 0);
await evaluate("document.getElementById('sage-chats').click(); return 1");
check("chat list lists it", (await evaluate("return document.querySelectorAll('#sage-list .sage-open').length")) === 1);
await evaluate("document.querySelector('#sage-list .sage-open').click(); return 1");
check("reopening restores the messages", (await evaluate("return document.querySelectorAll('#sage-msgs .sage-msg').length")) >= 2,
  await evaluate("return document.getElementById('sage-msgs').textContent.slice(0,80)"));
await evaluate("document.getElementById('sage-chats').click(); return 1");
await evaluate("document.querySelector('#sage-list .icon-btn').click(); return 1");
check("delete removes the chat", (await chats()).length === 0);
await evaluate("document.getElementById('sage-close').click(); return 1");
await sleep(250);

console.log("\nconsole errors:", errors.length ? errors : "none");
console.log(`\n${pass} passed, ${fail} failed`);
ws.close();
process.exit(fail || errors.length ? 1 : 0);
