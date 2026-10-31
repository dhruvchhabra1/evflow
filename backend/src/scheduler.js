/*
 * EVFlow scheduling engine — server-side port of the frontend scheduler.js.
 *
 * Pure logic only: no storage, no clock access (callers pass `now`).
 * Algorithm is unchanged from the frontend:
 *   - A site has chargers (max kW each) and ONE shared power cap (capKw).
 *   - A booking is one continuous session on one charger with an exact
 *     power-over-time `profile`; the sum of all profiles never exceeds capKw.
 *   - Not-yet-started bookings are re-planned earliest-deadline-first whenever
 *     anything changes; sessions already charging are locked.
 *   - Fairness: a vehicle that finished here in the last 3h is ordered as if
 *     its deadline were 30 min later.
 *   - Charger choice: earliest start that meets the deadline; ties go to the
 *     slower charger. If the deadline is impossible -> status "delayed".
 *
 * Only change vs. the frontend: "HH:MM" parsing is timezone-explicit
 * (the server's own timezone must not matter).
 */

const MIN = 60000;
const HOUR = 3600000;
const HORIZON_MS = 12 * HOUR;
const MIN_USEFUL_KW = 0.5;
const FAIRNESS_WINDOW_MS = 3 * HOUR;
const FAIRNESS_PENALTY_MS = 30 * MIN;

/* ---------- helpers ---------- */

// Accepts 10-digit Indian mobiles (optional 0 / 91 / +91 prefix). Returns "91XXXXXXXXXX" or null.
function normalizePhone(input) {
  let d = String(input || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? "91" + d : null;
}

function vehicleKey(v) {
  return String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Timestamp (ms) of "HH:MM" on the calendar day containing `refMs`, in a
// timezone given as minutes east of UTC (IST = 330).
function clockToTs(hhmm, refMs, tzOffsetMin) {
  const [h, m] = String(hhmm).split(":").map(Number);
  const local = new Date(refMs + tzOffsetMin * MIN); // UTC getters now read local wall-clock
  local.setUTCHours(h || 0, m || 0, 0, 0);
  return local.getTime() - tzOffsetMin * MIN;
}

// Arrival "HH:MM" long past -> tomorrow. Leave-by earlier than arrival -> next day (overnight).
function parseWindow(arrivalHHMM, departHHMM, now, tzOffsetMin = 330) {
  let a = clockToTs(arrivalHHMM, now, tzOffsetMin);
  if (a < now - 2 * HOUR) a += 24 * HOUR;
  let d = clockToTs(departHHMM, a, tzOffsetMin);
  if (d <= a) d += 24 * HOUR;
  return { arrivalAt: a, deadlineAt: d };
}

const isActive = (b) => b.status !== "done" && b.status !== "cancelled";

function kwAt(profile, t) {
  for (const s of profile || []) if (t >= s.from && t < s.to) return s.kw;
  return 0;
}
function loadAt(bookings, t) {
  return bookings.reduce((sum, b) => sum + kwAt(b.profile, t), 0);
}

/* ---------- placement ---------- */

// Simulate a continuous session on charger `c` starting at `s`, respecting the cap.
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
      if (mine.some(([a, e]) => s >= a && s < e)) continue;
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

/*
 * Re-plan one site. `all` = the site's bookings (every active one, plus any
 * "done" within the fairness window). Mutates them in place and returns the
 * events to log.
 */
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
  const locked = active.filter((b) => b.charger && b.startAt <= now);
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

module.exports = {
  MIN, HOUR, FAIRNESS_WINDOW_MS,
  normalizePhone, vehicleKey, clockToTs, parseWindow,
  isActive, kwAt, placeRequest, trimProfile, replanSite
};
