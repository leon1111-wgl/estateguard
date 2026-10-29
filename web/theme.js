// Appearance preference (system / light / dark). Runs before first paint; storage may be blocked.
(() => {
  const root = document.documentElement, key = 'estateguard-theme', modes = ['system', 'light', 'dark'];
  let mode = 'system';
  try { const saved = localStorage.getItem(key); if (modes.includes(saved)) mode = saved; } catch {}
  const apply = () => { if (mode === 'system') delete root.dataset.theme; else root.dataset.theme = mode; };
  apply();
  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('theme-select');
    if (!select) return;
    select.value = mode;
    select.addEventListener('change', () => {
      mode = modes.includes(select.value) ? select.value : 'system';
      try { localStorage.setItem(key, mode); } catch {}
      apply();
    });
  });
})();
