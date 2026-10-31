// Tiny storage wrapper. Uses localStorage when available; falls back to memory
// (private browsing, sandboxed iframes) so the app never crashes on storage errors.
const Store = (() => {
  const mem = {};
  let ls = null;
  try { ls = window.localStorage; ls.setItem("__evf", "1"); ls.removeItem("__evf"); } catch (e) { ls = null; }
  return {
    get(key, fallback) {
      try {
        const raw = ls ? ls.getItem("evflow2_" + key) : mem[key];
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      const raw = JSON.stringify(value);
      if (ls) { try { ls.setItem("evflow2_" + key, raw); return; } catch (e) { /* quota — fall through */ } }
      mem[key] = raw;
    },
    remove(key) { try { if (ls) ls.removeItem("evflow2_" + key); } catch (e) {} delete mem[key]; }
  };
})();
