const test = require("node:test");
const assert = require("node:assert/strict");
const { openDb } = require("../src/db");
const { createApp } = require("../src/app");
const baseConfig = require("../src/config");

let now = Date.parse("2026-10-31T10:00:00+05:30");
const config = { ...baseConfig, disableRateLimit: true, otpMode: "dev", demoMode: true };
const db = openDb(":memory:");
const { app, service } = createApp({ db, config, clock: () => now });
service.seedDemo(now);

let server, base;
test.before(async () => { await new Promise((r) => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}/api`; });
test.after(() => server.close());

async function call(method, path, { body, token, headers } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json() };
}
const book = (over = {}) => ({ siteId: "thapar-b24", vehicle: "PB 11 AB 1234", energyKwh: 20, arrivalTime: "10:30", departureTime: "14:00", ...over });

test("public: health, sites, stations", async () => {
  assert.equal((await call("GET", "/health")).body.ok, true);
  const sites = (await call("GET", "/sites")).body.sites;
  assert.equal(sites[0].id, "thapar-b24");
  assert.equal(sites[0].ownerPhone, undefined, "owner phone must not leak");
  const st = (await call("GET", "/stations?type=fast")).body;
  assert.ok(st.stations.length > 0 && st.stations.every((s) => s.connectors.some((c) => c.kw >= 50)));
});

test("OTP login: wrong code rejected, right code issues a working JWT", async () => {
  const phone = "9811122233";
  const { body: sent } = await call("POST", "/auth/request-otp", { body: { phone } });
  assert.match(sent.devOtp, /^\d{6}$/);
  assert.equal((await call("POST", "/auth/request-otp", { body: { phone } })).status, 429, "resend throttled");
  const wrong = sent.devOtp === "000000" ? "111111" : "000000";
  assert.equal((await call("POST", "/auth/verify-otp", { body: { phone, otp: wrong } })).status, 400);
  const ok = await call("POST", "/auth/verify-otp", { body: { phone, otp: sent.devOtp } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.registered, false);
  assert.equal((await call("GET", "/me", { token: ok.body.token })).body.phone, "919811122233");
  assert.equal((await call("GET", "/me")).status, 401);
});

test("operator registers a site; another operator cannot read its dashboard", async () => {
  const demo = (await call("POST", "/auth/demo")).body;
  const created = await call("POST", "/sites", { token: demo.token, body: { name: "Test Lot", address: "Patiala", phone: "98765 00000", chargerCount: 2, chargerKw: 7, capKw: 10 } });
  assert.equal(created.status, 201);
  assert.equal((await call("GET", `/sites/${created.body.site.id}/snapshot`, { token: demo.token })).status, 200);

  const otp = (await call("POST", "/auth/request-otp", { body: { phone: "9700000001" } })).body.devOtp;
  const other = (await call("POST", "/auth/verify-otp", { body: { phone: "9700000001", otp } })).body;
  assert.equal((await call("GET", "/sites/thapar-b24/snapshot", { token: other.token })).status, 403);
  assert.equal((await call("GET", "/sites/thapar-b24/snapshot")).status, 401);

  const bad = await call("POST", "/sites", { token: demo.token, body: { name: "X", address: "Y", phone: "9876500000", chargerCount: 2, chargerKw: 7, capKw: 99 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "errCap");
});

test("booking lifecycle: create, duplicate, driver cancel (token), operator complete", async () => {
  const demo = (await call("POST", "/auth/demo")).body;

  const a = await call("POST", "/bookings", { body: book() });
  assert.equal(a.status, 201);
  assert.ok(["confirmed", "delayed"].includes(a.body.booking.status));
  assert.ok(a.body.cancelToken.length >= 32);
  assert.equal(a.body.booking.cancel_hash, undefined);

  assert.equal((await call("POST", "/bookings", { body: book() })).status, 409, "same vehicle, overlapping window");
  assert.equal((await call("POST", "/bookings", { body: book({ vehicle: "ab" }) })).status, 400);
  assert.equal((await call("POST", "/bookings", { body: book({ energyKwh: 500 }) })).status, 400);

  // cancel needs the token
  assert.equal((await call("POST", `/bookings/${a.body.booking.id}/cancel`)).status, 403);
  assert.equal((await call("POST", `/bookings/${a.body.booking.id}/cancel`, { headers: { "X-Cancel-Token": "nope".repeat(12) } })).status, 403);
  const cancelled = await call("POST", `/bookings/${a.body.booking.id}/cancel`, { headers: { "X-Cancel-Token": a.body.cancelToken } });
  assert.equal(cancelled.body.booking.status, "cancelled");
  assert.equal((await call("POST", `/bookings/${a.body.booking.id}/cancel`, { headers: { "X-Cancel-Token": a.body.cancelToken } })).status, 409);

  // operator completes another booking; drivers cannot
  const b = await call("POST", "/bookings", { body: book({ vehicle: "HR 26 CD 5678" }) });
  assert.equal((await call("POST", `/bookings/${b.body.booking.id}/complete`)).status, 401);
  const done = await call("POST", `/bookings/${b.body.booking.id}/complete`, { token: demo.token });
  assert.equal(done.body.booking.status, "done");
});

test("dashboard snapshot reflects bookings, never exceeds the site cap, and time moves sessions to done", async () => {
  const demo = (await call("POST", "/auth/demo")).body;
  for (let i = 0; i < 5; i++) await call("POST", "/bookings", { body: book({ vehicle: `CH 01 XY 90${i}0`, arrivalTime: "10:05", departureTime: "16:00", energyKwh: 30 }) });
  const snap = (await call("GET", "/sites/thapar-b24/snapshot", { token: demo.token })).body;
  assert.ok(snap.bookings.length >= 5);
  assert.ok(snap.usedKw <= snap.capKw);
  assert.ok(snap.events.length > 0);

  now += 24 * 3600 * 1000;                                  // jump a day ahead
  const later = (await call("GET", "/sites/thapar-b24/snapshot", { token: demo.token })).body;
  assert.equal(later.bookings.length, 0, "everything finished or expired");
  assert.equal(later.inUse, 0);
});

test("GET /bookings?ids= returns the driver's list", async () => {
  now = Date.parse("2026-11-02T10:00:00+05:30");
  const a = await call("POST", "/bookings", { body: book({ vehicle: "DL 01 EV 0001" }) });
  const list = await call("GET", `/bookings?ids=${a.body.booking.id},missing`);
  assert.equal(list.body.bookings.length, 1);
});
