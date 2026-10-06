// The server's live state, shared by every module. One object on purpose: a
// `let` exported from one file is a stale copy in every file that imports it,
// so anything written in one place and read in another lives here.
const state = {
  latestData: null,     // the newest telemetry packet
  dataHistory: [],      // ~100s of packets, oldest first (snapshots + trends read it)
  currentMission: "",   // non-empty turns the autonomous analysis loop on
  currentLanguage: "en",
  // CONSOLE -> DEMO and CONSOLE -> SAGE LAMP: last value any client sent wins
  demoMode: false,
  lampAllowed: true,
};

// a packet older than 10s is not "now"
state.freshData = () => (state.latestData && Date.now() - state.latestData.timestamp < 10000 ? state.latestData : null);

module.exports = state;
