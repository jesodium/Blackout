// How the dashboard is found on the network: the LAN url for the judges'
// tablet, blackout.local over mDNS, and the SAGE/VOICE cloud reachability pills.
const os = require("os");
const { app, PORT } = require("./http");
const { BRAINS } = require("./brain");

const MDNS_HOST = process.env.MDNS_HOST || "blackout.local";

const lanIp = () => Object.values(os.networkInterfaces()).flat()
  .find(i => i.family === "IPv4" && !i.internal)?.address;

app.get("/api/lan", (req, res) => {
  const ip = lanIp();
  res.json({ url: ip ? `http://${ip}:${PORT}` : null, host: `http://blackout.local:${PORT}` });
});

// a reachability probe, not a health check: the venue has no internet, and the
// api ROOT answers where an authenticated path just hangs
const CLOUD_HOSTS = { sage: BRAINS[0] ? new URL(BRAINS[0].baseURL).origin + "/" : null, tts: "https://api.deepgram.com/" };
let cloudSeen = { at: 0, state: null };
app.get("/api/cloud", async (_req, res) => {
  if (cloudSeen.state && Date.now() - cloudSeen.at < 25000) return res.json(cloudSeen.state);
  const ping = async (url) => {
    try { await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(4000) }); return true; }
    catch { return false; }
  };
  const [sage, tts] = await Promise.all([ping(CLOUD_HOSTS.sage), ping(CLOUD_HOSTS.tts)]);
  cloudSeen = { at: Date.now(), state: { sage, tts } };
  res.json(cloudSeen.state);
});

function startMdns() {
  const mdnsServer = require("multicast-dns")();
  mdnsServer.on("query", (q) => {
    const want = q.questions.find(
      (x) => (x.type === "A" || x.type === "ANY") && x.name.toLowerCase() === MDNS_HOST
    );
    if (!want) return;
    const ip = lanIp();
    if (!ip) return;
    mdnsServer.respond({
      answers: [{ name: MDNS_HOST, type: "A", ttl: 120, data: ip }],
    });
  });
}

module.exports = { MDNS_HOST, startMdns };
