import fs from "fs"; import "dotenv/config";
const P = f => fs.readFileSync("prompts/" + f, "utf8").trim();
const img = "data:image/jpeg;base64," + fs.readFileSync(process.argv[2]).toString("base64");
for (const demo of [false, true]) {
  const sys = [P("analysis.md"), ...(demo ? [P("demo.md")] : []), "Answer in Spanish."].join("\n\n");
  const r = await fetch("https://api.cerebras.ai/v1/chat/completions", { method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + process.env.CEREBRAS_API_KEY },
    body: JSON.stringify({ model: process.env.CEREBRAS_MODEL || "qwen-3.8-27b", max_tokens: 400, messages: [
      { role: "system", content: sys },
      { role: "user", content: [{ type: "text", text: "Latest telemetry — read the room and report.\nTemperature 26.1C [NORMAL]\nHumidity 61% [NORMAL]\nDistance ahead 14cm [NEAR]\n(Attached is your live forward-camera view — read it for what's ahead.)" }, { type: "image_url", image_url: { url: img } }] }] }) });
  const j = await r.json(); console.log(demo ? "DEMO ON :" : "DEMO OFF:", j.choices?.[0]?.message?.content || JSON.stringify(j).slice(0, 300));
}
