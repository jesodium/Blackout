/* Sponsor names live in sponsors.json — one list, both pages (index.html's strip and
   sponsors.html). An entry is { "name", "url"?, "logo"? }; logo is a path under assets/,
   and without one the name is drawn as text. Fills every [data-tier] <ul> on the page.
   IMPORTANT NOTE: fetch, so it needs to be served over http — open the pages through a
   server, not file://. */
const sponsorsRender = (() => {
  let cache = null;                                   // one fetch, reused across language switches
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const cell = (s) => {
    const inner = s.logo
      ? `<img src="${esc(s.logo)}" alt="${esc(s.name)}" loading="lazy">`
      : esc(s.name);
    return `<li>${s.url ? `<a href="${esc(s.url)}" rel="noopener">${inner}</a>` : inner}</li>`;
  };

  return async (openLabel) => {
    const lists = document.querySelectorAll('[data-tier]');
    if (!lists.length) return;
    if (!cache) cache = await fetch('sponsors.json').then(r => r.json()).catch(() => ({}));
    for (const ul of lists) {
      const tier = cache[ul.dataset.tier] || [];
      ul.innerHTML = tier.length ? tier.map(cell).join('') : `<li class="open">${esc(openLabel)}</li>`;
    }
  };
})();
