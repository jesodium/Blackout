// Funding numbers + donation methods come from donate.json —
// edit the goal, the raised amount and the handles there and both pages pick it up.
// To add a method, append { "id", "name", "handle", "note" (, "url") } to "methods".
const donateRender = (() => {
  let cache = null;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = (n, cur) => esc(cur || "$") + Number(n || 0).toLocaleString("en-US");

  const card = (m) => {
    const action = m.url
      ? `<a class="fund-go" href="${esc(m.url)}" target="_blank" rel="noopener">↗</a>`
      : `<button class="fund-go" type="button" data-copy="${esc(m.handle)}" aria-label="copy">⧉</button>`;
    return `<li><div><strong>${esc(m.name)}</strong><code data-copy="${esc(m.handle)}">${esc(m.handle)}</code>`
      + (m.note ? `<span>${esc(m.note)}</span>` : ``) + `</div>${action}</li>`;
  };

  const onCopy = (root) => {
    root.addEventListener("click", (e) => {
      const t = e.target.closest("[data-copy]");
      if (!t) return;
      const done = () => {
        t.style.borderColor = "var(--accent)";
        setTimeout(() => { t.style.borderColor = ""; }, 900);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t.dataset.copy).then(done, done);
      } else {
        const ta = document.createElement("textarea");
        ta.value = t.dataset.copy;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch (err) {}
        ta.remove();
        done();
      }
    });
  };

  return async () => {
    const roots = document.querySelectorAll("[data-donate]");
    if (!roots.length) return;
    if (!cache) cache = await fetch("donate.json").then(r => r.json()).catch(() => null);
    if (!cache) return;
    const pct = cache.goal > 0 ? Math.min(100, Math.round((cache.raised || 0) / cache.goal * 100)) : 0;
    document.querySelectorAll("[data-donate-raised]").forEach(el => { el.textContent = money(cache.raised, cache.currency); });
    document.querySelectorAll("[data-donate-goal]").forEach(el => { el.textContent = money(cache.goal, cache.currency); });
    document.querySelectorAll("[data-donate-pct]").forEach(el => { el.textContent = pct + "%"; });
    document.querySelectorAll("[data-donate-bar]").forEach(el => { el.style.width = pct + "%"; });
    document.querySelectorAll("[data-donate-methods]").forEach(ul => {
      ul.innerHTML = (cache.methods || []).map(card).join("");
      onCopy(ul);
    });
  };
})();
