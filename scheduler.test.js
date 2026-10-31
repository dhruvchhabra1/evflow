const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../src/scheduler");

const { HOUR, MIN } = S;
const NOW = Date.parse("2026-10-31T10:00:00+05:30");
const SITE = { id: "t", capKw: 30, chargers: [{ id: "C1", maxKw: 7 }, { id: "C2", maxKw: 7 }, { id: "C3", maxKw: 7 }, { id: "C4", maxKw: 22 }] };

function mk(i, over = {}) {
  return { id: "b" + i, siteId: "t", vehicle: "PB11AB000" + i, vehicleKey: "PB11AB000" + i, energyKwh: 20,
    arrivalAt: NOW, deadlineAt: NOW + 4 * HOUR, createdAt: NOW + i, status: "waiting", profile: [], ...over };
}
function maxLoad(bookings) {
  const pts = new Set();
  bookings.forEach((b) => b.profile.forEach((s) => { pts.add(s.from); pts.add(s.to - 1); }));
  return Math.max(0, ...[...pts].map((t) => bookings.reduce((s, b) => s + S.kwAt(b.profile, t), 0)));
}

test("parseWindow is timezone-explicit (IST) and handles overnight", () => {
  const { arrivalAt, deadlineAt } = S.parseWindow("22:00", "06:00", NOW, 330);
  assert.equal(new Date(arrivalAt).toISOString(), "2026-10-31T16:30:00.000Z");   // 22:00 IST
  assert.equal(deadlineAt - arrivalAt, 8 * HOUR);
});

test("site power cap is never exceeded, even with more demand than power", () => {
  const all = Array.from({ length: 6 }, (_, i) => mk(i, { energyKwh: 25 }));
  S.replanSite(SITE, all, NOW);
  assert.ok(all.every((b) => b.charger), "everyone got a charger");
  assert.ok(maxLoad(all) <= SITE.capKw + 1e-6, `peak ${maxLoad(all)} kW exceeds cap`);
});

test("a session squeezed by the cap is throttled and explained", () => {
  const all = [mk(0, { energyKwh: 50, deadlineAt: NOW + 8 * HOUR }), mk(1, { energyKwh: 30, deadlineAt: NOW + 8 * HOUR }),
               mk(2, { energyKwh: 30, deadlineAt: NOW + 8 * HOUR }), mk(3, { energyKwh: 30, deadlineAt: NOW + 8 * HOUR })];
  S.replanSite(SITE, all, NOW);
  assert.ok(all.some((b) => b.reasonKey === "reason_powerCap"));
});

test("impossible deadline -> delayed with lateMin", () => {
  const all = [mk(0, { energyKwh: 100, deadlineAt: NOW + 30 * MIN })];
  S.replanSite(SITE, all, NOW);
  assert.equal(all[0].status, "delayed");
  assert.ok(all[0].lateMin > 0);
});

test("earliest-deadline-first: tighter deadline is served before looser one", () => {
  const one = { id: "t", capKw: 7, chargers: [{ id: "C1", maxKw: 7 }] };
  const loose = mk(0, { energyKwh: 7, deadlineAt: NOW + 6 * HOUR });
  const tight = mk(1, { energyKwh: 7, deadlineAt: NOW + 2 * HOUR });
  S.replanSite(one, [loose, tight], NOW);
  assert.ok(tight.startAt < loose.startAt);
});

test("fairness: a vehicle that just finished is ordered behind an otherwise-equal newcomer", () => {
  const one = { id: "t", capKw: 7, chargers: [{ id: "C1", maxKw: 7 }] };
  const prev = mk(9, { vehicle: "PB11AA1111", vehicleKey: "PB11AA1111", status: "done", charger: "C1", startAt: NOW - 2 * HOUR, completeAt: NOW - HOUR });
  const repeat = mk(0, { vehicle: "PB11AA1111", vehicleKey: "PB11AA1111", energyKwh: 7, deadlineAt: NOW + 3 * HOUR });
  const fresh = mk(1, { energyKwh: 7, deadlineAt: NOW + 3 * HOUR + 10 * MIN });
  S.replanSite(one, [prev, repeat, fresh], NOW);
  assert.ok(fresh.startAt < repeat.startAt);
});

test("sessions already charging are locked and finish automatically", () => {
  const b = mk(0, { energyKwh: 7 });
  S.replanSite(SITE, [b], NOW);
  const [first] = [b.startAt];
  S.replanSite(SITE, [b], NOW + 10 * MIN);
  assert.equal(b.startAt, first);
  S.replanSite(SITE, [b], b.completeAt + 1000);
  assert.equal(b.status, "done");
});
