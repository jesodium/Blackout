const sponsorsRender = (() => {
  let cache = null;
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const cell = (s) => {
    const inner = s.logo
      ? `<img src="${esc(s.logo)}" alt="${esc(s.name)}" loading="lazy">`
      : esc(s.name);
    return `<li>${s.url ? `<a href="${esc(s.url)}" rel="noopener">${inner}</a>` : inner}</li>`;
  };

  const showSponsorWindow = (raw, found) => {
    let box = document.getElementById('sponsor-window');
    if (!raw) { if (box) box.remove(); return; }
    if (!box) {
      box = document.createElement('div');
      box.id = 'sponsor-window';
      box.setAttribute('role', 'status');
      box.style.cssText = 'margin:0 0 18px;padding:14px 18px;border:1px solid var(--accent);'
        + 'border-radius:10px;background:rgba(224,164,92,.08);font-size:14px';
      const anchor = document.querySelector('.ranks, .tiers, .sponsor-ad');
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(box, anchor);
      else document.body.prepend(box);
    }
    box.innerHTML = found
      ? `Sponsor: <strong>${esc(raw)}</strong> <span style="opacity:.65">· ${esc(found)} rank</span>`
      : `Sponsor: <strong>${esc(raw)}</strong>`;
  };

  const highlightFromUrl = () => {
    let raw = null;
    try { raw = new URLSearchParams(location.search).get('sponsor'); } catch (e) { raw = null; }
    raw = (raw || '').trim();
    document.querySelectorAll('[data-tier] li.is-sponsor').forEach(li => li.classList.remove('is-sponsor'));
    if (!raw) { showSponsorWindow(null); return; }
    const needle = raw.toLowerCase();
    let foundTier = null;
    let foundLi = null;
    for (const ul of document.querySelectorAll('[data-tier]')) {
      for (const li of ul.querySelectorAll('li')) {
        if (li.textContent.trim().toLowerCase().includes(needle)) {
          foundTier = ul.dataset.tier;
          foundLi = li;
          break;
        }
      }
      if (foundLi) break;
    }
    if (foundLi) {
      foundLi.classList.add('is-sponsor');
      foundLi.style.cssText += ';outline:2px solid var(--accent);outline-offset:2px;border-radius:8px';
      try { foundLi.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {}
    }
    showSponsorWindow(raw, foundTier);
  };

  return async (openLabel) => {
    const lists = document.querySelectorAll('[data-tier]');
    if (!lists.length) return;
    if (!cache) cache = await fetch('sponsors.json').then(r => r.json()).catch(() => ({}));
    for (const ul of lists) {
      const tier = cache[ul.dataset.tier] || [];
      ul.innerHTML = tier.length ? tier.map(cell).join('') : `<li class="open">${esc(openLabel)}</li>`;
    }
    highlightFromUrl();
  };
})();
