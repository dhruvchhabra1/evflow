/*
 * EVFlow scheduling engine (runs on-device; pure logic + Store persistence).
 *
 * Model
 *   - A SITE has chargers (each with a max kW) and ONE shared power cap (capKw).
 *   - A BOOKING is placed on one charger for one continuous session. Its
 *     `profile` is a list of {from,to,kw} segments, so the power it draws over
 *     time is known exactly. At any instant the sum of all profiles at a site
 *     never exceeds capKw — a booking that would push the site over the cap is
 *     throttled (lower kW, longer session) or started later.
 *   - Rolling horizon: every time something changes (new booking, cancel, done,
 *     time passing) the site's NOT-YET-STARTED bookings are re-planned in
 *     earliest-deadline-first order. Sessions already in progress are locked.
 *   - Fairness: a vehicle that finished here in the last 3 hours is ordered as
 *     if its deadline were 30 min later, so drivers who have waited go first.
 *   - Charger choice: the earliest start that meets the deadline; ties go to
 *     the SLOWER charger so fast chargers stay free for drivers who need them.
 *     If no option meets the deadline, the earliest finish is used (status
 *     "delayed") and the driver is told by how much.
 */

const MIN = 60000, HOUR = 3600000;
const HORIZON_MS = 12 * HOUR;      // don't plan a start more than 12h out
const MIN_USEFUL_KW = 0.5;         // below this a session is treated as "can't charge"
const FAIRNESS_WINDOW_MS = 3 * HOUR;
const FAIRNESS_PENALTY_MS = 30 * MIN;

// Demo seed: one site + one registered operator so the app is explorable on first run.
const DEMO_OPERATOR_PHONE = "919876543210";
const DEFAULT_SITE = {
  id: "thapar-b24",
  name: "Thapar Institute — Block 24 Lot",
  address: "Thapar Institute of Engineering and Technology, Patiala",
  phone: "911234567890", // TODO: placeholder WhatsApp number — replace before submission
  ownerPhone: DEMO_OPERATOR_PHONE,
  chargers: [
    { id: "C1", maxKw: 7 }, { id: "C2", maxKw: 7 }, { id: "C3", maxKw: 7 }, { id: "C4", maxKw: 22 }
  ],
  capKw: 30
};

/* ---------- storage ---------- */
function getSites() {
  let sites = Store.get("sites", null);
  if (!sites) {
    sites = [DEFAULT_SITE];
    Store.set("sites", sites);
    Store.set("operators", { [DEMO_OPERATOR_PHONE]: { phone: DEMO_OPERATOR_PHONE, createdAt: 0 } });
  }
  return sites;
}
function getSite(id) { return getSites().find((s) => s.id === id) || null; }
function sitesOf(ownerPhone) { return getSites().filter((s) => s.ownerPhone === ownerPhone); }
function addSite(site) { const s = getSites(); s.push(site); Store.set("sites", s); return site; }

function isRegisteredOperator(phone) { getSites(); return !!Store.get("operators", {})[phone]; }
function registerOperator(phone) {
  const ops = Store.get("operators", {});
  ops[phone] = { phone, createdAt: Date.now() };
  Store.set("operators", ops);
}

function loadState() { return Store.get("bookings", []); }
function saveState(b) { Store.set("bookings", b); }
function loadEvents() { return Store.get("events", []); }
function logEvent(e) {
  const evs = loadEvents();
  evs.unshift({ ts: Date.now(), ...e });
  Store.set("events", evs.slice(0, 200));
}

/* ---------- phone + time helpers ---------- */
// Accepts 10-digit Indian mobiles (with optional 0 / 91 / +91 prefix). Returns "91XXXXXXXXXX" or null.
function normalizePhone(input) {
  let d = String(input || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? "91" + d : null;
}
function fmtPhone(p) { return p && p.length === 12 ? `+91 ${p.slice(2, 7)} ${p.slice(7)}` : (p || ""); }

function vehicleKey(v) { return String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }

function clockToTs(hhmm, ref) {
  const [h, m] = String(hhmm).split(":").map(Number);
  const d = new Date(ref); d.setHours(h || 0, m || 0, 0, 0);
  return d.getTime();
}
// Arrival "HH:MM" long past today → tomorrow. Leave-by earlier than arrival → next day (overnight).
function parseWindow(arrivalHHMM, departHHMM, now) {
  let a = clockToTs(arrivalHHMM, now);
  if (a < now - 2 * HOUR) a += 24 * HOUR;
  let d = clockToTs(departHHMM, a);
  if (d <= a) d += 24 * HOUR;
  return { arrivalAt: a, deadlineAt: d };
}

/* ---------- placement ---------- */
const isActive = (b) => b.status !== "done" && b.status !== "cancelled";
function kwAt(profile, t) {
  for (const s of profile || []) if (t >= s.from && t < s.to) return s.kw;
  return 0;
}
function loadAt(bookings, t) { return bookings.reduce((sum, b) => sum + kwAt(b.profile, t), 0); }

// Simulate a continuous session on charger `c` starting at `s`, respecting the cap.
// Returns { startAt, completeAt, profile, throttled } or null if it can't run contiguously.
function simulate(site, c, s, energyKwh, placed, breakpoints, nextBusyStart) {
  const bps = breakpoints.filter((x) => x > s);
  let t = s, remaining = energyKwh, i = 0, throttled = false;
  const profile = [];
  while (remaining > 1e-6) {
    const t1 = i < bps.length ? bps[i] : Infinity;
    const p = Math.min(c.maxKw, site.capKw - loadAt(placed, t));
    if (p < MIN_USEFUL_KW) return null;
    if (p < c.maxKw - 1e-6) throttled = true;
    const end = Math.min(t1, t + (remaining / p) * HOUR);
    if (end > nextBusyStart + 1) return null;
    profile.push({ from: Math.round(t), to: Math.round(end), kw: Math.round(p * 100) / 100 });
    remaining -= p * ((end - t) / HOUR);
    t = end;
    if (end === t1) i++;
  }
  return { startAt: Math.round(s), completeAt: Math.ceil(t / 1000) * 1000, profile, throttled };
}

function placeRequest(site, placed, req, now) {
  const s0 = Math.max(req.arrivalAt, now);
  const bpSet = new Set();
  placed.forEach((b) => (b.profile || []).forEach((seg) => { bpSet.add(seg.from); bpSet.add(seg.to); }));
  const breakpoints = [...bpSet].sort((a, b) => a - b);

  const options = [];
  for (const c of site.chargers) {
    const mine = placed.filter((b) => b.charger === c.id).map((b) => [b.startAt, b.completeAt]);
    const cands = new Set([s0]);
    mine.forEach(([, e]) => { if (e > s0) cands.add(e); });
    breakpoints.forEach((t) => { if (t > s0) cands.add(t); });
    for (const s of [...cands].sort((a, b) => a - b)) {
      if (s > s0 + HORIZON_MS) break;
      if (mine.some(([a, e]) => s >= a && s < e)) continue;                 // charger busy at s
      const nextBusy = Math.min(Infinity, ...mine.filter(([a]) => a > s).map(([a]) => a));
      const sim = simulate(site, c, s, req.energyKwh, placed, breakpoints, nextBusy);
      if (sim) options.push({ charger: c, ...sim });
    }
  }
  if (options.length === 0) {
    return { status: "waiting", reasonKey: "reason_noSlot", charger: null, startAt: null, completeAt: null, profile: [], lateMin: 0 };
  }

  const feasible = options.filter((o) => o.completeAt <= req.deadlineAt);
  const best = feasible.length
    ? feasible.sort((a, b) => a.startAt - b.startAt || a.charger.maxKw - b.charger.maxKw || a.charger.id.localeCompare(b.charger.id))[0]
    : options.sort((a, b) => a.completeAt - b.completeAt || a.startAt - b.startAt)[0];

  const meets = best.completeAt <= req.deadlineAt;
  const queued = best.startAt - s0 > 2 * MIN;
  let reasonKey;
  if (best.throttled) reasonKey = "reason_powerCap";
  else if (queued) reasonKey = req.penalized ? "reason_fairness" : "reason_queued";
  else reasonKey = meets ? "reason_onTrack" : "reason_deadlineTight";

  return {
    status: meets ? "confirmed" : "delayed",
    reasonKey,
    charger: best.charger.id,
    startAt: best.startAt,
    completeAt: best.completeAt,
    profile: best.profile,
    lateMin: meets ? 0 : Math.ceil((best.completeAt - req.deadlineAt) / MIN)
  };
}

function trimProfile(b, now) {
  b.profile = (b.profile || []).filter((s) => s.from < now).map((s) => ({ ...s, to: Math.min(s.to, now) }));
}

// Re-plan one site. Mutates the bookings in `all`; returns events to log.
function replanSite(site, all, now) {
  const events = [];
  const mine = all.filter((b) => b.siteId === site.id);

  mine.forEach((b) => {
    if (isActive(b) && b.charger && b.completeAt <= now) {
      b.status = "done";
      events.push({ siteId: site.id, type: "done", vehicle: b.vehicle, charger: b.charger });
    }
  });

  const active = mine.filter(isActive);
  const locked = active.filter((b) => b.charger && b.startAt <= now);        // already charging
  const pending = active.filter((b) => !locked.includes(b));

  const recent = mine.filter((b) => b.status === "done" && b.completeAt > now - FAIRNESS_WINDOW_MS);
  pending.forEach((b) => { b.penalized = recent.some((r) => r.vehicleKey === b.vehicleKey); });
  pending.sort((a, b) =>
    (a.deadlineAt + (a.penalized ? FAIRNESS_PENALTY_MS : 0)) - (b.deadlineAt + (b.penalized ? FAIRNESS_PENALTY_MS : 0)) ||
    a.createdAt - b.createdAt);

  const placed = locked.slice();
  pending.forEach((b) => {
    const prev = b.charger ? { status: b.status, charger: b.charger, completeAt: b.completeAt } : null;
    Object.assign(b, placeRequest(site, placed, b, now));
    placed.push(b);
    if (prev && (prev.status !== b.status || prev.charger !== b.charger || Math.abs(prev.completeAt - b.completeAt) > 5 * MIN)) {
      events.push({ siteId: site.id, type: "moved", vehicle: b.vehicle, charger: b.charger, startAt: b.startAt, completeAt: b.completeAt });
    }
  });
  return events;
}

function refreshSite(siteId, now = Date.now()) {
  const site = getSite(siteId);
  if (!site) return;
  const all = loadState();
  const events = replanSite(site, all, now);
  saveState(all);
  events.forEach(logEvent);
}
function refreshAllSites(now = Date.now()) { getSites().forEach((s) => refreshSite(s.id, now)); }

/* ---------- public actions ---------- */
// Returns { booking } or { error: "<i18n key>" }.
function createBooking(form, now = Date.now()) {
  const site = getSite(form.siteId);
  if (!site) return { error: "errSite" };
  const key = vehicleKey(form.vehicle);
  if (key.length < 4) return { error: "errVehicle" };
  const energyKwh = Number(form.energyKwh);
  if (!(energyKwh >= 1 && energyKwh <= 100)) return { error: "errKwh" };

  const { arrivalAt, deadlineAt } = parseWindow(form.arrivalTime, form.departureTime, now);
  const gap = deadlineAt - arrivalAt;
  if (gap < 10 * MIN) return { error: "errShort" };
  if (gap > 16 * HOUR) return { error: "errWindow" };

  refreshSite(site.id, now);
  const all = loadState();
  if (all.some((b) => b.siteId === site.id && isActive(b) && b.vehicleKey === key &&
                      b.arrivalAt < deadlineAt && b.deadlineAt > arrivalAt)) {
    return { error: "errDup" };
  }

  const booking = {
    id: "B" + now.toString(36) + Math.random().toString(36).slice(2, 5),
    siteId: site.id, siteName: site.name,
    vehicle: String(form.vehicle).trim().replace(/\s+/g, " ").toUpperCase(), vehicleKey: key,
    energyKwh, arrivalAt, deadlineAt, createdAt: now,
    status: "waiting", reasonKey: "reason_noSlot", charger: null, startAt: null, completeAt: null, profile: [], lateMin: 0
  };
  all.push(booking);
  const events = replanSite(site, all, now);
  saveState(all);
  events.forEach(logEvent);
  logEvent({ siteId: site.id, type: booking.charger ? "booked" : "noSlot", vehicle: booking.vehicle, charger: booking.charger, startAt: booking.startAt, completeAt: booking.completeAt });
  return { booking: all.find((b) => b.id === booking.id) };
}

function endBooking(id, status, now = Date.now()) {
  const all = loadState();
  const b = all.find((x) => x.id === id);
  if (!b || !isActive(b)) return;
  b.status = status;
  if (status === "done") b.completeAt = Math.min(b.completeAt || now, now);
  trimProfile(b, now);
  logEvent({ siteId: b.siteId, type: status === "done" ? "done" : "cancelled", vehicle: b.vehicle, charger: b.charger });
  const site = getSite(b.siteId);
  const events = site ? replanSite(site, all, now) : [];
  saveState(all);
  events.forEach(logEvent);
}
const completeBooking = (id, now) => endBooking(id, "done", now);
const cancelBooking = (id, now) => endBooking(id, "cancelled", now);

function siteSnapshot(siteId, now = Date.now()) {
  const site = getSite(siteId);
  const all = loadState().filter((b) => b.siteId === siteId);
  const active = all.filter(isActive);
  const chargers = site.chargers.map((c) => {
    const current = active.find((b) => b.charger === c.id && b.startAt <= now && now < b.completeAt) || null;
    const next = active.filter((b) => b.charger === c.id && b.startAt > now).sort((a, b) => a.startAt - b.startAt)[0] || null;
    return { ...c, current, next, kwNow: current ? kwAt(current.profile, now) : 0 };
  });
  const usedKw = Math.round(chargers.reduce((s, c) => s + c.kwNow, 0) * 10) / 10;
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const energyToday = all
    .filter((b) => b.status !== "cancelled" && b.arrivalAt >= dayStart.getTime() && b.arrivalAt < dayStart.getTime() + 24 * HOUR)
    .reduce((s, b) => s + b.energyKwh, 0);
  return {
    site, chargers, usedKw, capKw: site.capKw,
    inUse: chargers.filter((c) => c.current).length,
    free: chargers.filter((c) => !c.current).length,
    queued: active.filter((b) => !b.charger || b.startAt > now).length,
    energyToday: Math.round(energyToday),
    bookings: active.sort((a, b) => (a.startAt ?? Infinity) - (b.startAt ?? Infinity)),
    alerts: active.filter((b) => b.status === "delayed" || b.status === "waiting"),
    events: loadEvents().filter((e) => e.siteId === siteId)
  };
}
