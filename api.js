/*
 * Drop-in client for the EVFlow frontend. Replaces the on-device scheduler.js
 * calls (createBooking, cancelBooking, siteSnapshot, ...) with HTTP calls.
 * Every function is async — the frontend's render() calls need `await`.
 *
 *   <script src="store.js"></script>   (still used for language, role, session token, my booking ids)
 *   <script src="api.js"></script>     (this file; replaces scheduler.js)
 */
const API_BASE = window.EVFLOW_API || "http://localhost:3000/api";

async function api(method, path, { body, auth, cancelToken } = {}) {
  const headers = { "Content-Type": "application/json" };
  const tok = Store.get("token", null);
  if (auth && tok) headers.Authorization = "Bearer " + tok;
  if (cancelToken) headers["X-Cancel-Token"] = cancelToken;
  const res = await fetch(API_BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.message || res.statusText); e.code = data.error; e.status = res.status; throw e; }
  return data;
}

/* ----- operator auth ----- */
const requestOtp = (phone) => api("POST", "/auth/request-otp", { body: { phone } });              // dev mode returns { devOtp }
async function verifyOtp(phone, otp) {
  const r = await api("POST", "/auth/verify-otp", { body: { phone, otp } });
  Store.set("token", r.token); Store.set("session", r.phone);
  return r;                                                                                        // r.registered === false -> show the registration form
}
async function demoLogin() { const r = await api("POST", "/auth/demo"); Store.set("token", r.token); Store.set("session", r.phone); return r; }
const logout = () => { Store.remove("token"); Store.remove("session"); };

/* ----- sites ----- */
const getSites = async () => (await api("GET", "/sites")).sites;
const sitesOf = async () => (await api("GET", "/me/sites", { auth: true })).sites;
const addSite = async (s) => (await api("POST", "/sites", { auth: true, body: s })).site;           // {name,address,phone,chargerCount,chargerKw,capKw}
const siteSnapshot = (siteId) => api("GET", `/sites/${siteId}/snapshot`, { auth: true });

/* ----- bookings (driver) ----- */
async function createBooking(form) {                                                               // {siteId,vehicle,arrivalTime,departureTime,energyKwh}
  const tzOffsetMin = -new Date().getTimezoneOffset();                                             // device timezone, so "HH:MM" means the driver's wall-clock
  const { booking, cancelToken } = await api("POST", "/bookings", { body: { ...form, energyKwh: Number(form.energyKwh), tzOffsetMin } });
  const mine = Store.get("myBookings", {});                                                        // { bookingId: cancelToken }
  mine[booking.id] = cancelToken; Store.set("myBookings", mine);
  return { booking };
}
async function myBookings() {
  const mine = Store.get("myBookings", {});
  const ids = Object.keys(mine);
  return ids.length ? (await api("GET", "/bookings?ids=" + ids.join(","))).bookings : [];
}
const cancelMyBooking = (id) => api("POST", `/bookings/${id}/cancel`, { cancelToken: Store.get("myBookings", {})[id] });

/* ----- bookings (operator) ----- */
const completeBooking = (id) => api("POST", `/bookings/${id}/complete`, { auth: true });
const operatorCancel = (id) => api("POST", `/bookings/${id}/cancel`, { auth: true });

/* ----- public stations ----- */
const getStations = (type = "all", freeOnly = false) => api("GET", `/stations?type=${type}&freeOnly=${freeOnly}`);
