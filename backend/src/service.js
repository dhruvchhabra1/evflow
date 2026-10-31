/*
 * Business logic + persistence. Everything that touches bookings runs inside a
 * SQLite transaction (better-sqlite3 is synchronous), so concurrent HTTP
 * requests can never interleave a read-replan-write cycle.
 */
const crypto = require("crypto");
const S = require("./scheduler");

const { MIN, HOUR } = S;

class ApiError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const rid = (n = 3) => crypto.randomBytes(n).toString("hex");

function createService(db, config) {
  /* ---------- row mapping ---------- */
  const toSite = (r) => r && ({
    id: r.id, name: r.name, address: r.address, phone: r.phone, ownerPhone: r.owner_phone,
    capKw: r.cap_kw, chargers: JSON.parse(r.chargers), createdAt: r.created_at
  });
  const toBooking = (r) => r && ({
    id: r.id, siteId: r.site_id, siteName: r.site_name, vehicle: r.vehicle, vehicleKey: r.vehicle_key,
    energyKwh: r.energy_kwh, arrivalAt: r.arrival_at, deadlineAt: r.deadline_at, createdAt: r.created_at,
    status: r.status, reasonKey: r.reason_key, charger: r.charger, startAt: r.start_at, completeAt: r.complete_at,
    profile: JSON.parse(r.profile), lateMin: r.late_min, penalized: !!r.penalized
  });
  // What the API returns for a booking (never leaks the cancel-token hash).
  const publicBooking = (b) => b && b;

  /* ---------- prepared statements ---------- */
  const q = {
    siteById: db.prepare("SELECT * FROM sites WHERE id = ?"),
    allSites: db.prepare("SELECT * FROM sites ORDER BY created_at"),
    sitesByOwner: db.prepare("SELECT * FROM sites WHERE owner_phone = ? ORDER BY created_at"),
    insertSite: db.prepare(`INSERT INTO sites (id,name,address,phone,owner_phone,cap_kw,chargers,created_at)
                            VALUES (@id,@name,@address,@phone,@ownerPhone,@capKw,@chargers,@createdAt)`),
    operator: db.prepare("SELECT * FROM operators WHERE phone = ?"),
    insertOperator: db.prepare("INSERT OR IGNORE INTO operators (phone, created_at) VALUES (?, ?)"),
    siteBookings: db.prepare(`SELECT * FROM bookings WHERE site_id = ?
                              AND (status NOT IN ('done','cancelled') OR (status = 'done' AND complete_at > ?))`),
    allSiteBookings: db.prepare("SELECT * FROM bookings WHERE site_id = ?"),
    bookingById: db.prepare("SELECT * FROM bookings WHERE id = ?"),
    bookingHash: db.prepare("SELECT cancel_hash FROM bookings WHERE id = ?"),
    insertBooking: db.prepare(`INSERT INTO bookings
      (id,site_id,site_name,vehicle,vehicle_key,energy_kwh,arrival_at,deadline_at,created_at,status,reason_key,
       charger,start_at,complete_at,profile,late_min,penalized,cancel_hash)
      VALUES (@id,@siteId,@siteName,@vehicle,@vehicleKey,@energyKwh,@arrivalAt,@deadlineAt,@createdAt,@status,@reasonKey,
       @charger,@startAt,@completeAt,@profile,@lateMin,@penalized,@cancelHash)`),
    updateBooking: db.prepare(`UPDATE bookings SET status=@status, reason_key=@reasonKey, charger=@charger,
       start_at=@startAt, complete_at=@completeAt, profile=@profile, late_min=@lateMin, penalized=@penalized
       WHERE id=@id`),
    insertEvent: db.prepare(`INSERT INTO events (ts,site_id,type,vehicle,charger,start_at,complete_at)
                             VALUES (@ts,@siteId,@type,@vehicle,@charger,@startAt,@completeAt)`),
    events: db.prepare("SELECT * FROM events WHERE site_id = ? ORDER BY ts DESC, id DESC LIMIT ?"),
    pruneEvents: db.prepare(`DELETE FROM events WHERE site_id = ? AND id NOT IN
                             (SELECT id FROM events WHERE site_id = ? ORDER BY ts DESC, id DESC LIMIT 200)`)
  };

  const dbBooking = (b) => ({
    id: b.id, status: b.status, reasonKey: b.reasonKey ?? null, charger: b.charger ?? null,
    startAt: b.startAt ?? null, completeAt: b.completeAt ?? null, profile: JSON.stringify(b.profile || []),
    lateMin: b.lateMin || 0, penalized: b.penalized ? 1 : 0
  });

  function logEvent(e, now) {
    q.insertEvent.run({
      ts: now, siteId: e.siteId, type: e.type, vehicle: e.vehicle ?? null, charger: e.charger ?? null,
      startAt: e.startAt ?? null, completeAt: e.completeAt ?? null
    });
  }

  /* ---------- operators + sites ---------- */
  const isOperator = (phone) => !!q.operator.get(phone);
  const ensureOperator = (phone, now = Date.now()) => q.insertOperator.run(phone, now);

  const listSites = () => q.allSites.all().map(toSite);
  const getSite = (id) => toSite(q.siteById.get(id));
  const sitesOf = (ownerPhone) => q.sitesByOwner.all(ownerPhone).map(toSite);

  function createSite(ownerPhone, input, now = Date.now()) {
    const phone = S.normalizePhone(input.phone);
    if (!phone) throw new ApiError(400, "opBadPhone", "Invalid contact phone number");

    let chargers = input.chargers;
    if (!chargers) {
      chargers = Array.from({ length: input.chargerCount }, (_, i) => ({ id: "C" + (i + 1), maxKw: input.chargerKw }));
    }
    const total = chargers.reduce((s, c) => s + c.maxKw, 0);
    if (new Set(chargers.map((c) => c.id)).size !== chargers.length) throw new ApiError(400, "errChargers", "Duplicate charger ids");
    if (!(input.capKw >= 1 && input.capKw <= total)) throw new ApiError(400, "errCap", "Site power limit must be between 1 kW and the total charger power");

    const site = {
      id: "s" + now.toString(36) + rid(2), name: input.name.trim(), address: input.address.trim(), phone,
      ownerPhone, capKw: input.capKw, chargers, createdAt: now
    };
    db.transaction(() => {
      ensureOperator(ownerPhone, now);
      q.insertSite.run({ ...site, chargers: JSON.stringify(chargers) });
    })();
    return site;
  }

  /* ---------- planning ---------- */
  // Re-plan one site inside the caller's transaction. Returns nothing; persists changes + events.
  function replanTx(site, now) {
    const all = q.siteBookings.all(site.id, now - S.FAIRNESS_WINDOW_MS).map(toBooking);
    const before = new Map(all.map((b) => [b.id, JSON.stringify(dbBooking(b))]));
    const events = S.replanSite(site, all, now);
    all.forEach((b) => { if (JSON.stringify(dbBooking(b)) !== before.get(b.id)) q.updateBooking.run(dbBooking(b)); });
    events.forEach((e) => logEvent(e, now));
    if (events.length) q.pruneEvents.run(site.id, site.id);
  }

  function refreshSite(siteId, now = Date.now()) {
    const site = getSite(siteId);
    if (!site) return;
    db.transaction(() => replanTx(site, now))();
  }
  const refreshAllSites = (now = Date.now()) => listSites().forEach((s) => refreshSite(s.id, now));

  /* ---------- bookings ---------- */
  function createBooking(form, now = Date.now()) {
    const site = getSite(form.siteId);
    if (!site) throw new ApiError(404, "errSite", "Unknown charging site");
    const key = S.vehicleKey(form.vehicle);
    if (key.length < 4) throw new ApiError(400, "errVehicle", "Enter a valid vehicle number");

    const energyKwh = Number(form.energyKwh);
    if (!(energyKwh >= 1 && energyKwh <= 100)) throw new ApiError(400, "errKwh", "Energy must be between 1 and 100 kWh");

    let arrivalAt, deadlineAt;
    if (form.arrivalAt != null && form.deadlineAt != null) {
      arrivalAt = Number(form.arrivalAt); deadlineAt = Number(form.deadlineAt);
    } else {
      ({ arrivalAt, deadlineAt } = S.parseWindow(
        form.arrivalTime, form.departureTime, now, form.tzOffsetMin ?? config.defaultTzOffsetMin));
    }
    const gap = deadlineAt - arrivalAt;
    if (!(gap >= 10 * MIN)) throw new ApiError(400, "errShort", "Leave-by time must be at least 10 minutes after arrival");
    if (gap > 16 * HOUR) throw new ApiError(400, "errWindow", "Window cannot be longer than 16 hours");
    if (deadlineAt <= now) throw new ApiError(400, "errShort", "Leave-by time is already in the past");

    const cancelToken = crypto.randomBytes(24).toString("hex");
    const id = "B" + now.toString(36) + rid(5);

    return db.transaction(() => {
      replanTx(site, now);
      const dup = q.siteBookings.all(site.id, now).map(toBooking).some((b) =>
        S.isActive(b) && b.vehicleKey === key && b.arrivalAt < deadlineAt && b.deadlineAt > arrivalAt);
      if (dup) throw new ApiError(409, "errDup", "This vehicle already has a booking in that window");

      q.insertBooking.run({
        id, siteId: site.id, siteName: site.name,
        vehicle: String(form.vehicle).trim().replace(/\s+/g, " ").toUpperCase(), vehicleKey: key,
        energyKwh, arrivalAt, deadlineAt, createdAt: now,
        status: "waiting", reasonKey: "reason_noSlot", charger: null, startAt: null, completeAt: null,
        profile: "[]", lateMin: 0, penalized: 0, cancelHash: sha256(cancelToken)
      });
      replanTx(site, now);
      const booking = toBooking(q.bookingById.get(id));
      logEvent({ siteId: site.id, type: booking.charger ? "booked" : "noSlot", vehicle: booking.vehicle,
                 charger: booking.charger, startAt: booking.startAt, completeAt: booking.completeAt }, now);
      return { booking: publicBooking(booking), cancelToken };
    })();
  }

  const getBooking = (id) => publicBooking(toBooking(q.bookingById.get(id)));

  function getBookings(ids, now = Date.now()) {
    const sites = new Set();
    const rows = ids.map((id) => toBooking(q.bookingById.get(id))).filter(Boolean);
    rows.forEach((b) => sites.add(b.siteId));
    sites.forEach((sid) => refreshSite(sid, now));
    return ids.map((id) => getBooking(id)).filter(Boolean);
  }

  // `authz` is { cancelToken } (driver) or { operatorPhone } (site owner).
  function endBooking(id, status, authz, now = Date.now()) {
    const row = q.bookingById.get(id);
    if (!row) throw new ApiError(404, "errBooking", "Booking not found");
    const site = getSite(row.site_id);

    const isOwner = authz.operatorPhone && site && site.ownerPhone === authz.operatorPhone;
    const isDriver = authz.cancelToken && status === "cancelled" &&
      crypto.timingSafeEqual(Buffer.from(sha256(authz.cancelToken)), Buffer.from(row.cancel_hash));
    if (!isOwner && !isDriver) throw new ApiError(403, "forbidden", "Not allowed to change this booking");

    return db.transaction(() => {
      const b = toBooking(q.bookingById.get(id));
      if (!S.isActive(b)) throw new ApiError(409, "errClosed", "Booking is already closed");
      b.status = status;
      if (status === "done") b.completeAt = Math.min(b.completeAt || now, now);
      S.trimProfile(b, now);
      q.updateBooking.run(dbBooking(b));
      logEvent({ siteId: b.siteId, type: status === "done" ? "done" : "cancelled", vehicle: b.vehicle, charger: b.charger }, now);
      if (site) replanTx(site, now);
      return publicBooking(toBooking(q.bookingById.get(id)));
    })();
  }

  /* ---------- operator dashboard ---------- */
  function siteSnapshot(siteId, now = Date.now()) {
    const site = getSite(siteId);
    if (!site) throw new ApiError(404, "errSite", "Unknown charging site");
    refreshSite(siteId, now);

    const all = q.allSiteBookings.all(siteId).map(toBooking);
    const active = all.filter(S.isActive);
    const chargers = site.chargers.map((c) => {
      const current = active.find((b) => b.charger === c.id && b.startAt <= now && now < b.completeAt) || null;
      const next = active.filter((b) => b.charger === c.id && b.startAt > now).sort((a, b) => a.startAt - b.startAt)[0] || null;
      return { ...c, current, next, kwNow: current ? S.kwAt(current.profile, now) : 0 };
    });
    const usedKw = Math.round(chargers.reduce((s, c) => s + c.kwNow, 0) * 10) / 10;

    // "Today" is the calendar day in the site's timezone.
    const tz = config.defaultTzOffsetMin;
    const local = new Date(now + tz * MIN); local.setUTCHours(0, 0, 0, 0);
    const dayStart = local.getTime() - tz * MIN;
    const energyToday = all
      .filter((b) => b.status !== "cancelled" && b.arrivalAt >= dayStart && b.arrivalAt < dayStart + 24 * HOUR)
      .reduce((s, b) => s + b.energyKwh, 0);

    return {
      site: { ...site, ownerPhone: undefined }, chargers, usedKw, capKw: site.capKw,
      inUse: chargers.filter((c) => c.current).length,
      free: chargers.filter((c) => !c.current).length,
      queued: active.filter((b) => !b.charger || b.startAt > now).length,
      energyToday: Math.round(energyToday),
      bookings: active.sort((a, b) => (a.startAt ?? Infinity) - (b.startAt ?? Infinity)),
      alerts: active.filter((b) => b.status === "delayed" || b.status === "waiting"),
      events: listEvents(siteId, 50)
    };
  }

  const listEvents = (siteId, limit = 50) =>
    q.events.all(siteId, limit).map((e) => ({
      id: e.id, ts: e.ts, siteId: e.site_id, type: e.type, vehicle: e.vehicle,
      charger: e.charger, startAt: e.start_at, completeAt: e.complete_at
    }));

  /* ---------- demo seed ---------- */
  function seedDemo(now = Date.now()) {
    if (listSites().length) return;
    const demoPhone = "919876543210";
    ensureOperator(demoPhone, now);
    q.insertSite.run({
      id: "thapar-b24", name: "Thapar Institute — Block 24 Lot",
      address: "Thapar Institute of Engineering and Technology, Patiala",
      phone: "911234567890", // placeholder WhatsApp number — replace before submission
      ownerPhone: demoPhone, capKw: 30,
      chargers: JSON.stringify([{ id: "C1", maxKw: 7 }, { id: "C2", maxKw: 7 }, { id: "C3", maxKw: 7 }, { id: "C4", maxKw: 22 }]),
      createdAt: now
    });
  }

  return {
    ApiError, isOperator, ensureOperator, listSites, getSite, sitesOf, createSite,
    refreshSite, refreshAllSites, createBooking, getBooking, getBookings, endBooking,
    siteSnapshot, listEvents, seedDemo
  };
}

module.exports = { createService, ApiError };
