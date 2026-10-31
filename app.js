// EVFlow app shell — vanilla JS, no framework/build step (keeps the wrapped APK tiny).

/* ---------- state + navigation ---------- */
const LIVE_VIEWS = ["op-dashboard", "driver-bookings", "driver-stations"];
const DRIVER_VIEWS = ["driver-home", "driver-book", "driver-result", "driver-bookings", "driver-stations"];
const OP_VIEWS = ["op-dashboard", "op-locations", "op-register"];

function getSession() { return Store.get("session", null); }
function bootView() {
  if (!Store.get("onboarded", false)) return "lang-select";
  if (Store.get("role", "driver") === "operator" && getSession()) return "op-dashboard";
  return "driver-home";
}

let state = {
  view: bootView(),
  stack: [],                 // history, so the Back button always has somewhere to go
  siteId: null,              // site the driver is booking at
  opSiteId: null,            // location the operator is viewing
  opDraft: null,             // { mode: "new" | "add", phone }
  lastBooking: null,
  stationFilter: { type: "all", freeOnly: false }
};

const root = document.getElementById("screen-content");

const LOADING_COPY = {
  "driver-result": { en: "Building your schedule…", hi: "आपका शेड्यूल बन रहा है…", pa: "ਤੁਹਾਡਾ ਸ਼ਡਿਊਲ ਬਣ ਰਿਹਾ ਹੈ…", gu: "તમારું શેડ્યુલ બની રહ્યું છે…" },
  "op-dashboard": { en: "Reading site status…", hi: "साइट की स्थिति पढ़ी जा रही है…", pa: "ਸਾਈਟ ਦੀ ਸਥਿਤੀ ਪੜ੍ਹੀ ਜਾ ਰਹੀ ਹੈ…", gu: "સાઈટની સ્થિતિ વાંચાઈ રહી છે…" }
};

function showLoading(view) {
  const overlay = document.createElement("div");
  overlay.className = "loading-overlay";
  const copy = LOADING_COPY[view] ? (LOADING_COPY[view][CURRENT_LANG] || LOADING_COPY[view].en) : "";
  overlay.innerHTML = `<div class="spinner-bolt"></div>${copy ? `<div class="loading-text">${esc(copy)}</div>` : ""}`;
  document.body.appendChild(overlay);
  return overlay;
}

// go(view)                 → push current view on the history stack (Back returns to it)
// go(view, {root:true})    → start a fresh stack (used by tab bars / role switches)
// go(view, {loading:true}) → brief loading beat first
function go(view, opts = {}) {
  const apply = () => {
    if (opts.root) state.stack = [];
    else if (state.view !== view) state.stack.push(state.view);
    state.view = view;
    window.scrollTo(0, 0);
    render();
  };
  if (!opts.loading) { apply(); return; }
  const overlay = showLoading(view);
  setTimeout(() => {
    apply();
    overlay.classList.add("leaving");
    setTimeout(() => overlay.remove(), 220);
  }, 420 + Math.random() * 260);
}

function goBack() {
  const prev = state.stack.pop();
  if (prev) { state.view = prev; window.scrollTo(0, 0); render(); }
  else { state.view = bootView() === "lang-select" ? "role-select" : bootView(); render(); }
}

/* ---------- helpers ---------- */
function esc(str) {
  const d = document.createElement("div");
  d.textContent = str == null ? "" : String(str);
  return d.innerHTML;
}
const pad2 = (n) => String(n).padStart(2, "0");
function fmtClock(ts) { const d = new Date(ts); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); }
function fmtTs(ts) {
  if (ts == null) return "—";
  const d = new Date(ts), n = new Date();
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(n).setHours(0, 0, 0, 0)) / 864e5);
  return fmtClock(ts) + (days > 0 ? ` (+${days})` : "");
}
function fmtIsoDate(iso) { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; }
const STATUS_KEY = { confirmed: "statusConfirmed", delayed: "statusDelayed", waiting: "statusWaiting", done: "statusDone", cancelled: "statusCancelled" };

function currentSite() {
  const sites = getSites();
  return sites.find((s) => s.id === state.siteId) || sites[0];
}
function openWhatsApp(site, vehicle, kwh) {
  if (!site || !site.phone) return;
  const msg = t("waMsgTemplate")(vehicle || "", site.name, kwh || "");
  window.open(`https://wa.me/${site.phone}?text=${encodeURIComponent(msg)}`, "_blank");
}
function fmtEvent(e) {
  switch (e.type) {
    case "booked": return t("ev_booked")(e.vehicle, e.charger, fmtClock(e.startAt), fmtClock(e.completeAt));
    case "done": return t("ev_done")(e.vehicle, e.charger);
    case "cancelled": return t("ev_cancelled")(e.vehicle);
    case "moved": return t("ev_moved")(e.vehicle, e.charger, fmtClock(e.completeAt));
    default: return t("ev_noSlot")(e.vehicle);
  }
}
function kwRange(chargers) {
  const k = chargers.map((c) => c.maxKw);
  const lo = Math.min(...k), hi = Math.max(...k);
  return lo === hi ? `${hi}` : `${lo}–${hi}`;
}
function errorBox(id) { return `<div class="form-error" id="${id}" role="alert" hidden></div>`; }
function showError(id, key) {
  const el = document.getElementById(id);
  el.textContent = t(key); el.hidden = false;
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/* ---------- chrome ---------- */
function renderTopbar() {
  document.getElementById("topbar-title").textContent = t("appName");
  document.getElementById("lang-pill").textContent = I18N[CURRENT_LANG]._label;
  const back = document.getElementById("back-btn");
  back.style.display = state.stack.length > 0 ? "flex" : "none";
  back.setAttribute("aria-label", t("back"));
  document.documentElement.lang = CURRENT_LANG;
}

function renderFooterNav() {
  const nav = document.getElementById("footer-nav");
  const v = state.view;
  if (DRIVER_VIEWS.includes(v)) {
    const on = (list) => (list.includes(v) ? "active" : "");
    nav.style.display = "flex";
    nav.innerHTML = `
      <button class="${on(["driver-home", "driver-book", "driver-result"])}" id="nav-book">${t("newBooking")}</button>
      <button class="${on(["driver-stations"])}" id="nav-stations">${t("findChargers")}</button>
      <button class="${on(["driver-bookings"])}" id="nav-list">${t("myBookings")}</button>
      <button id="nav-op">${t("roleOperator")}</button>`;
    document.getElementById("nav-book").addEventListener("click", () => go("driver-home", { root: true }));
    document.getElementById("nav-stations").addEventListener("click", () => go("driver-stations", { root: true }));
    document.getElementById("nav-list").addEventListener("click", () => go("driver-bookings", { root: true }));
    document.getElementById("nav-op").addEventListener("click", enterOperator);
  } else if (OP_VIEWS.includes(v) && getSession()) {
    const on = (x) => (v === x ? "active" : "");
    nav.style.display = "flex";
    nav.innerHTML = `
      <button class="${on("op-dashboard")}" id="nav-dash">${t("navDashboard")}</button>
      <button class="${on("op-locations") || on("op-register")}" id="nav-locs">${t("navLocations")}</button>
      <button id="nav-driver">${t("navDriverView")}</button>`;
    document.getElementById("nav-dash").addEventListener("click", () => go("op-dashboard", { root: true }));
    document.getElementById("nav-locs").addEventListener("click", () => go("op-locations", { root: true }));
    document.getElementById("nav-driver").addEventListener("click", enterDriver);
  } else {
    nav.style.display = "none";
  }
}

function enterDriver() {
  Store.set("role", "driver"); Store.set("onboarded", true);
  go("driver-home", { root: true });
}
function enterOperator() {
  Store.set("role", "operator"); Store.set("onboarded", true);
  if (getSession()) go("op-dashboard", { root: true, loading: true });
  else go("op-login", { root: true });
}

/* ---------- first run: language + role ---------- */
function renderLangSelect() {
  const langs = Object.keys(I18N);
  root.innerHTML = `
    <div class="screen">
      <h1>${t("chooseLanguage")}</h1>
      <div class="lang-grid" style="margin-top:20px;">
        ${langs.map((l) => `<button class="lang-btn ${l === CURRENT_LANG ? "active" : ""}" data-lang="${l}">${I18N[l]._label}</button>`).join("")}
      </div>
      <button class="primary" id="lang-continue">${t("continueBtn")}</button>
    </div>`;
  root.querySelectorAll(".lang-btn").forEach((btn) => {
    btn.addEventListener("click", () => { setLang(btn.dataset.lang); renderTopbar(); renderLangSelect(); });
  });
  document.getElementById("lang-continue").addEventListener("click", () => {
    if (!Store.get("onboarded", false)) go("role-select");
    else goBack();
  });
}

function renderRoleSelect() {
  const role = Store.get("role", null);
  const here = `<span class="rc-here">${t("currentRole")}</span>`;
  root.innerHTML = `
    <div class="screen stack">
      <h1>${t("roleTitle")}</h1>
      <p class="sub">${t("tagline")}</p>
      <button class="role-card" id="pick-driver">
        <div class="rc-title">${t("roleDriver")}${role === "driver" ? here : ""}</div>
        <div class="rc-sub">${t("roleDriverSub")}</div>
      </button>
      <button class="role-card" id="pick-operator">
        <div class="rc-title">${t("roleOperator")}${role === "operator" ? here : ""}</div>
        <div class="rc-sub">${t("roleOperatorSub")}</div>
      </button>
    </div>`;
  document.getElementById("pick-driver").addEventListener("click", enterDriver);
  document.getElementById("pick-operator").addEventListener("click", enterOperator);
}

/* ---------- driver ---------- */
function renderDriverHome() {
  const site = currentSite();
  root.innerHTML = `
    <div class="screen stack">
      <h1>${t("driverHomeTitle")}</h1>
      <p class="sub">${t("driverHomeSub")}</p>
      <button class="primary" id="go-book">${t("newBooking")}</button>
      <button class="secondary" id="go-stations">${t("findChargers")}</button>
      <button class="secondary" id="go-bookings">${t("myBookings")}</button>
      ${site && site.phone ? `
      <div class="wa-block">
        <h2>${t("whatsappTitle")}</h2>
        <p>${t("whatsappBody")}</p>
        <button class="whatsapp" id="wa-generic">${t("whatsappButton")}</button>
      </div>` : ""}
      <button class="linkbtn" id="switch-role">${t("switchRole")}</button>
    </div>`;
  document.getElementById("go-book").addEventListener("click", () => go("driver-book"));
  document.getElementById("go-stations").addEventListener("click", () => go("driver-stations"));
  document.getElementById("go-bookings").addEventListener("click", () => go("driver-bookings"));
  document.getElementById("switch-role").addEventListener("click", () => go("role-select"));
  const wa = document.getElementById("wa-generic");
  if (wa) wa.addEventListener("click", () => openWhatsApp(site, "", ""));
}

function renderDriverBook() {
  const sites = getSites();
  const site = currentSite();
  const now = new Date();
  const later = new Date(now.getTime() + 3 * 3600000);
  const nowStr = pad2(now.getHours()) + ":" + pad2(now.getMinutes());
  const laterStr = pad2(later.getHours()) + ":" + pad2(later.getMinutes());

  root.innerHTML = `
    <div class="screen">
      <h1>${t("newBooking")}</h1>
      <div class="stack">
        <div class="field">
          <label for="f-site">${t("selectSite")}</label>
          <select id="f-site">${sites.map((s) => `<option value="${esc(s.id)}" ${s.id === site.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>
          <div class="field-hint" id="site-hint"></div>
        </div>
        <div class="field">
          <label for="f-vehicle">${t("vehicleNumber")}</label>
          <input id="f-vehicle" type="text" placeholder="PB10 AB 1234" autocapitalize="characters" autocomplete="off" maxlength="14" />
        </div>
        <div class="row">
          <div class="field"><label for="f-arrival">${t("arrivalTime")}</label><input id="f-arrival" type="time" value="${nowStr}" /></div>
          <div class="field"><label for="f-deadline">${t("departureDeadline")}</label><input id="f-deadline" type="time" value="${laterStr}" /></div>
        </div>
        <div class="field">
          <label>${t("energyNeeded")}</label>
          <div class="toggle-group">
            <button type="button" class="e-mode active" data-mode="partial">${t("energyPartial")}</button>
            <button type="button" class="e-mode" data-mode="full">${t("energyFull")}</button>
          </div>
        </div>
        <div class="field" id="kwh-field">
          <label for="f-kwh">${t("kwhLabel")}</label>
          <input id="f-kwh" type="number" inputmode="decimal" min="1" max="100" value="12" />
        </div>
        ${errorBox("book-error")}
        <button class="primary" id="submit-booking" style="margin-top:4px;">${t("getSchedule")}</button>
        <button class="secondary" id="back-home">${t("back")}</button>
      </div>
    </div>`;

  const hint = () => {
    const s = getSite(document.getElementById("f-site").value);
    document.getElementById("site-hint").textContent = s ? `${t("chargerCount")(s.chargers.length)} · ${kwRange(s.chargers)} ${t("kw")} · ${s.address}` : "";
  };
  hint();
  document.getElementById("f-site").addEventListener("change", (e) => { state.siteId = e.target.value; hint(); });

  root.querySelectorAll(".e-mode").forEach((btn) => {
    btn.addEventListener("click", () => {
      root.querySelectorAll(".e-mode").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("kwh-field").style.display = btn.dataset.mode === "full" ? "none" : "flex";
      if (btn.dataset.mode === "full") document.getElementById("f-kwh").value = 40;
    });
  });

  document.getElementById("back-home").addEventListener("click", goBack);
  document.getElementById("submit-booking").addEventListener("click", () => {
    const res = createBooking({
      siteId: document.getElementById("f-site").value,
      vehicle: document.getElementById("f-vehicle").value,
      arrivalTime: document.getElementById("f-arrival").value || nowStr,
      departureTime: document.getElementById("f-deadline").value || laterStr,
      energyKwh: document.getElementById("f-kwh").value
    });
    if (res.error) { showError("book-error", res.error); return; }
    state.siteId = res.booking.siteId;
    state.lastBooking = res.booking.id;
    go("driver-result", { loading: true });
  });
}

function renderDriverResult() {
  const b = state.lastBooking && loadState().find((x) => x.id === state.lastBooking);
  if (!b) { go("driver-home", { root: true }); return; }
  const site = getSite(b.siteId);

  root.innerHTML = `
    <div class="screen">
      <h1>${t("resultTitle")}</h1>
      <div class="status-banner ${b.status}">
        <div class="st-label">${esc(b.vehicle)} · ${esc(b.siteName)}</div>
        <div class="st-value">${b.status === "confirmed" ? '<span class="check-pop"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,13 9,18 20,6"/></svg></span>' : ""}${t(STATUS_KEY[b.status])}</div>
      </div>
      ${b.charger ? `
      <div class="detail-row"><span class="dr-label">${t("chargerAssigned")}</span><span class="dr-value">${esc(b.charger)}</span></div>
      <div class="detail-row"><span class="dr-label">${t("expectedStart")}</span><span class="dr-value">${fmtTs(b.startAt)}</span></div>
      <div class="detail-row"><span class="dr-label">${t("expectedComplete")}</span><span class="dr-value">${fmtTs(b.completeAt)}</span></div>
      ${b.lateMin > 0 ? `<div class="detail-row"><span class="dr-label">${t("lateBy")}</span><span class="dr-value late">${b.lateMin} ${t("minUnit")}</span></div>` : ""}
      ` : ""}
      <div class="reason-box">
        <div class="rb-label">${t("reasonLabel")}</div>
        <div>${t(b.reasonKey)}</div>
        ${b.status === "delayed" || b.status === "waiting" ? `<div class="rb-tip">${t("delayedTip")}</div>` : ""}
      </div>
      ${site && site.phone ? `
      <div class="wa-block">
        <h2>${t("confirmWhatsapp")}</h2>
        <button class="whatsapp" id="wa-confirm">${t("whatsappButton")}</button>
      </div>` : ""}
      <div class="stack" style="margin-top:16px;">
        <button class="secondary" id="book-another">${t("bookAnother")}</button>
        <button class="secondary" id="view-bookings">${t("viewBookings")}</button>
      </div>
    </div>`;

  const wa = document.getElementById("wa-confirm");
  if (wa) wa.addEventListener("click", () => openWhatsApp(site, b.vehicle, b.energyKwh));
  document.getElementById("book-another").addEventListener("click", () => go("driver-book"));
  document.getElementById("view-bookings").addEventListener("click", () => go("driver-bookings", { root: true }));
}

function renderDriverBookings() {
  refreshAllSites();
  const bookings = loadState().slice().reverse();
  root.innerHTML = `
    <div class="screen">
      <h1>${t("bookingsTitle")}</h1>
      ${bookings.length === 0 ? `<div class="empty-state">${t("noBookings")}</div>` : bookings.map((b) => `
        <div class="booking-item">
          <div class="bi-top">
            <span class="bi-vehicle">${esc(b.vehicle)}</span>
            <span class="badge ${b.status}">${t(STATUS_KEY[b.status])}</span>
          </div>
          <div class="bi-meta">${esc(b.siteName)} · ${esc(b.charger || "—")} · ${fmtTs(b.startAt)}–${fmtTs(b.completeAt)}</div>
          ${b.status === "confirmed" || b.status === "delayed" || b.status === "waiting" ? `<button class="mini" data-cancel="${esc(b.id)}">${t("actionCancel")}</button>` : ""}
        </div>`).join("")}
    </div>`;
  root.querySelectorAll("[data-cancel]").forEach((btn) => {
    btn.addEventListener("click", () => { cancelBooking(btn.dataset.cancel); render({ quiet: true }); });
  });
}

/* ---------- find chargers ---------- */
function stationConnectorLabel(c) {
  if (c.type === "Wall socket") return t("wallSocket");
  if (c.type === "Unknown") return t("unknownPlug");
  return c.type; // CCS / Type 2 are standard connector names — not translated
}
function connectorRow(c) {
  let avail, cls;
  if (c.free == null) { avail = t("chargerCount")(c.total); cls = "unk"; }
  else { avail = t("freeOf")(c.free, c.total); cls = c.free > 0 ? "ok" : "none"; }
  return `<div class="st-conn"><span class="dot ${cls}"></span><span class="st-conn-type">${esc(stationConnectorLabel(c))} · ${c.kw} ${t("kw")}</span><span class="st-conn-avail ${cls}">${esc(avail)}</span></div>`;
}
function stationCard(st) {
  const phone = st.phone ? `<a class="st-btn" href="tel:${esc(st.phone)}">${t("call")}</a>` : "";
  const hours = st.open24 ? `<div class="st-meta">${t("open24")}</div>` : "";
  return `
    <div class="st-card">
      <div class="st-name">${esc(st.name)}</div>
      <div class="st-addr">${esc(st.address)}</div>
      ${hours}
      <div class="st-conns">${st.connectors.map(connectorRow).join("")}</div>
      <div class="st-actions">
        <a class="st-btn primary-ish" href="${directionsUrl(st)}" target="_blank" rel="noopener">${t("directions")}</a>
        ${phone}
      </div>
    </div>`;
}
// EVFlow-managed sites are the only ones a driver can book; availability comes from the live scheduler.
function evflowSiteCard(site) {
  const snap = siteSnapshot(site.id);
  const cls = snap.free > 0 ? "ok" : "none";
  const dirUrl = directionsUrl({ name: site.name, address: site.address, lat: null, lng: null });
  return `
    <div class="st-card evflow">
      <div class="st-tag">${t("bookableHere")}</div>
      <div class="st-name">${esc(site.name)}</div>
      <div class="st-addr">${esc(site.address)}</div>
      <div class="st-conns">
        <div class="st-conn"><span class="dot ${cls}"></span>
          <span class="st-conn-type">${t("chargerCount")(site.chargers.length)} · ${kwRange(site.chargers)} ${t("kw")}</span>
          <span class="st-conn-avail ${cls}">${esc(t("freeOf")(snap.free, site.chargers.length))}</span>
        </div>
      </div>
      <div class="st-actions">
        <button class="primary st-book" data-book="${esc(site.id)}">${t("bookSlot")}</button>
        <a class="st-btn" href="${dirUrl}" target="_blank" rel="noopener">${t("directions")}</a>
      </div>
    </div>`;
}

function renderDriverStations() {
  refreshAllSites();
  const f = state.stationFilter;
  const sites = getSites();
  root.innerHTML = `
    <div class="screen">
      <h1>${t("findChargers")}</h1>
      <p class="sub">${t("findSub")}</p>
      <h2 class="sec">${t("sitesHeading")}</h2>
      <div id="st-pinned">${sites.map(evflowSiteCard).join("")}</div>
      <h2 class="sec">${t("publicHeading")}</h2>
      <div class="chips" id="st-chips"></div>
      <div id="st-list"></div>
      <p class="st-note">${esc(t("dataNote")(fmtIsoDate(STATIONS_AS_OF)))}</p>
    </div>`;

  root.querySelectorAll("[data-book]").forEach((btn) => {
    btn.addEventListener("click", () => { state.siteId = btn.dataset.book; go("driver-book"); });
  });

  const chipDefs = [
    { kind: "type", val: "all", label: t("filterAll") },
    { kind: "type", val: "ccs", label: "CCS" },
    { kind: "type", val: "type2", label: "Type 2" },
    { kind: "type", val: "fast", label: t("filterFast") },
    { kind: "free", val: true, label: t("filterFree") }
  ];
  function paint() {
    const chips = document.getElementById("st-chips");
    chips.innerHTML = chipDefs.map((c, i) => {
      const on = c.kind === "type" ? f.type === c.val : f.freeOnly;
      return `<button class="chip ${on ? "active" : ""}" data-i="${i}" aria-pressed="${on}">${esc(c.label)}</button>`;
    }).join("");
    chips.querySelectorAll(".chip").forEach((el) => {
      el.addEventListener("click", () => {
        const c = chipDefs[Number(el.dataset.i)];
        if (c.kind === "type") f.type = c.val; else f.freeOnly = !f.freeOnly;
        paint();
      });
    });
    const list = sortStations(filterStations(STATIONS, f));
    document.getElementById("st-list").innerHTML =
      list.length ? list.map(stationCard).join("") : `<div class="empty-state">${t("noMatch")}</div>`;
  }
  paint();
}

/* ---------- operator ---------- */
function renderOpLogin() {
  root.innerHTML = `
    <div class="screen">
      <h1>${t("opLoginTitle")}</h1>
      <p class="sub">${t("opLoginSub")}</p>
      <div class="stack">
        <div class="field">
          <label for="f-phone">${t("phoneLabel")}</label>
          <div class="phone-row"><span class="phone-prefix">+91</span><input id="f-phone" type="tel" inputmode="numeric" placeholder="98765 43210" autocomplete="tel-national" /></div>
        </div>
        ${errorBox("login-error")}
        <button class="primary" id="op-continue">${t("continueBtn")}</button>
        <button class="secondary" id="op-demo">${t("opDemo")}</button>
        <p class="st-note">${t("opNewNote")}</p>
      </div>
    </div>`;

  const submit = (phone) => {
    if (isRegisteredOperator(phone)) {
      Store.set("session", phone);
      state.opSiteId = null;
      go("op-dashboard", { root: true, loading: true });
    } else {
      state.opDraft = { mode: "new", phone };
      go("op-register");
    }
  };
  document.getElementById("op-continue").addEventListener("click", () => {
    const phone = normalizePhone(document.getElementById("f-phone").value);
    if (!phone) { showError("login-error", "opBadPhone"); return; }
    submit(phone);
  });
  document.getElementById("f-phone").addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("op-continue").click(); });
  document.getElementById("op-demo").addEventListener("click", () => submit(DEMO_OPERATOR_PHONE));
}

function renderOpRegister() {
  const draft = state.opDraft || { mode: "add", phone: getSession() };
  if (!draft.phone) { go("op-login", { root: true }); return; }
  const isNew = draft.mode === "new";
  const POWERS = [3.3, 7, 11, 22, 30, 60];

  root.innerHTML = `
    <div class="screen">
      <h1>${isNew ? t("opRegisterTitle") : t("opAddTitle")}</h1>
      <p class="sub">${t("opRegisterSub")}</p>
      <div class="stack">
        <div class="field"><label for="r-name">${t("locName")}</label><input id="r-name" type="text" maxlength="60" /></div>
        <div class="field"><label for="r-addr">${t("locAddress")}</label><input id="r-addr" type="text" maxlength="120" /></div>
        <div class="field">
          <label for="r-phone">${t("locPhone")}</label>
          <div class="phone-row"><span class="phone-prefix">+91</span><input id="r-phone" type="tel" inputmode="numeric" value="${esc(draft.phone.slice(2))}" /></div>
          <div class="field-hint">${t("locPhoneHint")}</div>
        </div>
        <div class="row">
          <div class="field"><label for="r-count">${t("chargerCountLabel")}</label><input id="r-count" type="number" inputmode="numeric" min="1" max="12" value="4" /></div>
          <div class="field"><label for="r-kw">${t("chargerPower")}</label>
            <select id="r-kw">${POWERS.map((p) => `<option value="${p}" ${p === 7 ? "selected" : ""}>${p} ${t("kw")}</option>`).join("")}</select></div>
        </div>
        <div class="field">
          <label for="r-cap">${t("sitePower")}</label>
          <input id="r-cap" type="number" inputmode="decimal" min="1" />
          <div class="field-hint">${t("sitePowerHint")}</div>
        </div>
        ${errorBox("reg-error")}
        <button class="primary" id="r-save">${t("saveLocation")}</button>
        <button class="secondary" id="r-cancel">${t("back")}</button>
      </div>
    </div>`;

  let capTouched = false;
  const countEl = document.getElementById("r-count"), kwEl = document.getElementById("r-kw"), capEl = document.getElementById("r-cap");
  const suggest = () => {
    if (capTouched) return;
    const n = Math.max(1, Math.min(12, Number(countEl.value) || 1));
    capEl.value = Math.max(1, Math.round(n * Number(kwEl.value) * 0.7));
  };
  suggest();
  countEl.addEventListener("input", suggest);
  kwEl.addEventListener("change", suggest);
  capEl.addEventListener("input", () => { capTouched = true; });
  document.getElementById("r-cancel").addEventListener("click", goBack);

  document.getElementById("r-save").addEventListener("click", () => {
    const name = document.getElementById("r-name").value.trim();
    const address = document.getElementById("r-addr").value.trim();
    const phone = normalizePhone(document.getElementById("r-phone").value);
    const count = Math.round(Number(countEl.value));
    const kw = Number(kwEl.value);
    const cap = Number(capEl.value);
    if (!name || !address) return showError("reg-error", "errRequired");
    if (!phone) return showError("reg-error", "opBadPhone");
    if (!(count >= 1 && count <= 12)) return showError("reg-error", "errChargers");
    if (!(cap >= 1 && cap <= count * kw)) return showError("reg-error", "errCap");

    if (isNew) registerOperator(draft.phone);
    const site = addSite({
      id: "s" + Date.now().toString(36), name, address, phone,
      ownerPhone: draft.phone,
      chargers: Array.from({ length: count }, (_, i) => ({ id: "C" + (i + 1), maxKw: kw })),
      capKw: cap
    });
    Store.set("session", draft.phone);
    state.opSiteId = site.id;
    state.opDraft = null;
    go("op-dashboard", { root: true, loading: true });
  });
}

function renderOpLocations() {
  const phone = getSession();
  if (!phone) { go("op-login", { root: true }); return; }
  const mine = sitesOf(phone);
  root.innerHTML = `
    <div class="screen">
      <h1>${t("locationsTitle")}</h1>
      <p class="sub">${t("signedInAs")} ${esc(fmtPhone(phone))}</p>
      ${mine.map((s) => `
        <button class="loc-card" data-site="${esc(s.id)}">
          <div class="st-name">${esc(s.name)}</div>
          <div class="st-addr">${esc(s.address)}</div>
          <div class="st-meta-row">${t("chargerCount")(s.chargers.length)} · ${kwRange(s.chargers)} ${t("kw")} · ${t("sitePower")}: ${s.capKw} ${t("kw")}</div>
        </button>`).join("")}
      <div class="stack" style="margin-top:16px;">
        <button class="primary" id="add-loc">${t("addLocation")}</button>
        <button class="secondary" id="op-logout">${t("logout")}</button>
      </div>
    </div>`;
  root.querySelectorAll(".loc-card").forEach((el) => {
    el.addEventListener("click", () => { state.opSiteId = el.dataset.site; go("op-dashboard", { root: true }); });
  });
  document.getElementById("add-loc").addEventListener("click", () => { state.opDraft = { mode: "add", phone }; go("op-register"); });
  document.getElementById("op-logout").addEventListener("click", () => {
    Store.remove("session"); Store.set("role", "driver"); state.opSiteId = null;
    go("role-select", { root: true });
  });
}

function renderOpDashboard() {
  const phone = getSession();
  if (!phone) { go("op-login", { root: true }); return; }
  const mine = sitesOf(phone);
  if (mine.length === 0) { state.opDraft = { mode: "add", phone }; go("op-register"); return; }
  if (!mine.some((s) => s.id === state.opSiteId)) state.opSiteId = mine[0].id;

  refreshSite(state.opSiteId);
  const snap = siteSnapshot(state.opSiteId);
  const now = Date.now();
  const pct = Math.min(100, Math.round((snap.usedKw / snap.capKw) * 100));

  const alertsHtml = snap.alerts.length === 0
    ? `<div class="empty-state small">${t("noAlerts")}</div>`
    : snap.alerts.map((b) => `<div class="alert-item">${esc(b.status === "waiting" ? t("alert_waiting")(b.vehicle) : t("alert_delayed")(b.vehicle, b.lateMin))}</div>`).join("");

  root.innerHTML = `
    <div class="screen">
      <h1>${esc(snap.site.name)}</h1>
      <p class="sub">${esc(snap.site.address)}${snap.site.phone ? " · " + esc(fmtPhone(snap.site.phone)) : ""}</p>
      ${mine.length > 1 ? `
      <div class="field" style="margin-bottom:16px;">
        <label for="loc-switch">${t("switchLocation")}</label>
        <select id="loc-switch">${mine.map((s) => `<option value="${esc(s.id)}" ${s.id === snap.site.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>
      </div>` : ""}

      <div class="stat-grid">
        <div class="stat"><div class="sv">${snap.inUse}/${snap.chargers.length}</div><div class="sl">${t("statInUse")}</div></div>
        <div class="stat"><div class="sv">${snap.queued}</div><div class="sl">${t("statQueued")}</div></div>
        <div class="stat"><div class="sv">${snap.energyToday}<small> ${t("kwh")}</small></div><div class="sl">${t("statEnergy")}</div></div>
      </div>

      <div class="gauge-wrap">
        <div class="st-label">${t("powerUsage")}</div>
        <div class="gauge-nums">${snap.usedKw} <span>${t("ofWord")} ${snap.capKw} ${t("kw")}</span></div>
        <div class="gauge-track"><div class="gauge-fill" style="width:${pct}%"></div></div>
      </div>

      <h2>${t("alerts")}</h2>
      ${alertsHtml}

      <h2 class="sec">${t("chargerOccupancy")}</h2>
      <div class="charger-grid">
        ${snap.chargers.map((c) => `
          <div class="charger-tile ${c.current ? "occ" : ""}">
            <div class="ct-id">${esc(c.id)}</div>
            <div class="ct-kw">${c.current ? `${c.kwNow} / ${c.maxKw}` : c.maxKw}${t("kw")}</div>
            <div class="ct-veh">${c.current ? esc(c.current.vehicle) : (c.next ? `${t("nextAt")} ${fmtClock(c.next.startAt)}` : t("free"))}</div>
          </div>`).join("")}
      </div>

      <h2 class="sec">${t("currentSchedule")}</h2>
      ${snap.bookings.length === 0 ? `<div class="empty-state small">${t("noSiteBookings")}</div>` : snap.bookings.map((b) => {
        const started = b.charger && b.startAt <= now;
        return `
        <div class="booking-item">
          <div class="bi-top"><span class="bi-vehicle">${esc(b.vehicle)}</span><span class="badge ${b.status}">${t(STATUS_KEY[b.status])}</span></div>
          <div class="bi-meta">${esc(b.charger || "—")} · ${fmtTs(b.startAt)}–${fmtTs(b.completeAt)} · ${b.energyKwh} ${t("kwh")}</div>
          <div class="bi-actions">
            ${started ? `<button class="mini" data-done="${esc(b.id)}">${t("actionDone")}</button>` : ""}
            <button class="mini danger" data-cancel="${esc(b.id)}">${t("actionCancel")}</button>
          </div>
        </div>`;
      }).join("")}

      <h2 class="sec">${t("eventLog")}</h2>
      ${snap.events.length === 0 ? `<div class="empty-state small">${t("noEvents")}</div>` : snap.events.slice(0, 8).map((e) => `
        <div class="event-item">${esc(fmtEvent(e))}<span class="ev-ts">${fmtClock(e.ts)}</span></div>`).join("")}

      <button class="secondary" id="add-loc" style="margin-top:20px;">${t("addLocation")}</button>
    </div>`;

  const sw = document.getElementById("loc-switch");
  if (sw) sw.addEventListener("change", (e) => { state.opSiteId = e.target.value; render({ quiet: true }); });
  root.querySelectorAll("[data-done]").forEach((b) => b.addEventListener("click", () => { completeBooking(b.dataset.done); render({ quiet: true }); }));
  root.querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", () => { cancelBooking(b.dataset.cancel); render({ quiet: true }); }));
  document.getElementById("add-loc").addEventListener("click", () => { state.opDraft = { mode: "add", phone }; go("op-register"); });
}

/* ---------- render ---------- */
function render(opts = {}) {
  const y = window.scrollY;
  renderTopbar();
  const views = {
    "lang-select": renderLangSelect, "role-select": renderRoleSelect,
    "driver-home": renderDriverHome, "driver-book": renderDriverBook, "driver-result": renderDriverResult,
    "driver-bookings": renderDriverBookings, "driver-stations": renderDriverStations,
    "op-login": renderOpLogin, "op-register": renderOpRegister, "op-locations": renderOpLocations, "op-dashboard": renderOpDashboard
  };
  (views[state.view] || renderDriverHome)();
  const screenEl = root.querySelector(".screen");
  if (screenEl && !opts.quiet) screenEl.classList.add("screen-enter");
  renderFooterNav();
  if (opts.quiet) window.scrollTo(0, y);
}

document.getElementById("lang-pill").addEventListener("click", () => go("lang-select"));
document.getElementById("back-btn").addEventListener("click", goBack);
document.getElementById("brand-btn").addEventListener("click", () => { if (state.view !== "role-select") go("role-select"); });

// Keep live screens fresh (sessions finish, queue moves) without disturbing typing.
setInterval(() => {
  const a = document.activeElement;
  if (LIVE_VIEWS.includes(state.view) && !(a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) && !document.hidden) render({ quiet: true });
}, 30000);

// Boot splash
const splash = document.createElement("div");
splash.className = "splash";
splash.innerHTML = `<div class="splash-bolt"></div><div class="splash-name">EVFlow</div>`;
document.body.appendChild(splash);
setTimeout(() => splash.remove(), 1500);

getSites(); // seed demo data on first run
render();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => { navigator.serviceWorker.register("./sw.js").catch(() => {}); });
}
