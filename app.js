const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { z } = require("zod");

const S = require("./scheduler");
const stations = require("./stations");
const { createService } = require("./service");
const { createAuth } = require("./auth");

const DEMO_PHONE = "919876543210";

function createApp({ db, config, clock = Date.now }) {
  const service = createService(db, config);
  const auth = createAuth(db, config, service);
  const { ApiError } = service;

  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(","), allowedHeaders: ["Content-Type", "Authorization", "X-Cancel-Token"] }));
  app.use(express.json({ limit: "20kb" }));

  const limiter = (windowMs, max) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false,
    handler: (_req, _res, next) => next(new ApiError(429, "rateLimited", "Too many requests, slow down")) });
  if (!config.disableRateLimit) {
    app.use("/api", limiter(60_000, 300));
    app.use("/api/auth", limiter(10 * 60_000, 20));
    app.post("/api/bookings", limiter(60_000, 20));
  }

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const parse = (schema, data) => {
    const r = schema.safeParse(data);
    if (!r.success) throw new ApiError(400, "validation", r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
    return r.data;
  };
  const phoneField = z.string().transform((v, ctx) => {
    const p = S.normalizePhone(v);
    if (!p) { ctx.addIssue({ code: "custom", message: "invalid Indian mobile number" }); return z.NEVER; }
    return p;
  });
  const publicSite = (s) => s && ({ id: s.id, name: s.name, address: s.address, phone: s.phone, chargers: s.chargers, capKw: s.capKw });
  const ownedSite = (siteId, phone) => {
    const site = service.getSite(siteId);
    if (!site) throw new ApiError(404, "errSite", "Unknown charging site");
    if (site.ownerPhone !== phone) throw new ApiError(403, "forbidden", "You do not manage this location");
    return site;
  };

  /* ---------- health ---------- */
  app.get("/api/health", (_req, res) => res.json({ ok: true, time: clock() }));

  /* ---------- auth ---------- */
  app.post("/api/auth/request-otp", wrap(async (req, res) => {
    const { phone } = parse(z.object({ phone: phoneField }), req.body);
    res.json(await auth.requestOtp(phone, clock()));
  }));
  app.post("/api/auth/verify-otp", wrap(async (req, res) => {
    const { phone, otp } = parse(z.object({ phone: phoneField, otp: z.string().regex(/^\d{6}$/) }), req.body);
    res.json(auth.verifyOtp(phone, otp, clock()));
  }));
  // One-tap demo operator (seeded Thapar site). Disabled unless DEMO_MODE=true.
  app.post("/api/auth/demo", (_req, res, next) => {
    if (!config.demoMode) return next(new ApiError(404, "notFound", "Not found"));
    res.json(auth.issueSession(DEMO_PHONE));
  });
  app.get("/api/me", auth.requireOperator, (req, res) =>
    res.json({ phone: req.phone, registered: service.isOperator(req.phone), sites: service.sitesOf(req.phone).map(publicSite) }));

  /* ---------- sites ---------- */
  app.get("/api/sites", (_req, res) => res.json({ sites: service.listSites().map(publicSite) }));
  app.get("/api/sites/:id", (req, res, next) => {
    const s = service.getSite(req.params.id);
    if (!s) return next(new ApiError(404, "errSite", "Unknown charging site"));
    res.json({ site: publicSite(s) });
  });
  app.post("/api/sites", auth.requireOperator, (req, res) => {
    const body = parse(z.object({
      name: z.string().trim().min(1).max(120),
      address: z.string().trim().min(1).max(300),
      phone: z.string(),
      chargerCount: z.number().int().min(1).max(12).optional(),
      chargerKw: z.number().positive().max(350).optional(),
      chargers: z.array(z.object({ id: z.string().min(1).max(8), maxKw: z.number().positive().max(350) })).min(1).max(12).optional(),
      capKw: z.number().min(1)
    }).refine((b) => b.chargers || (b.chargerCount && b.chargerKw), { message: "provide chargers[] or chargerCount + chargerKw" }), req.body);
    const site = service.createSite(req.phone, body, clock());
    res.status(201).json({ site: publicSite(site) });
  });
  app.get("/api/me/sites", auth.requireOperator, (req, res) => res.json({ sites: service.sitesOf(req.phone).map(publicSite) }));
  app.get("/api/sites/:id/snapshot", auth.requireOperator, (req, res) => {
    ownedSite(req.params.id, req.phone);
    res.json(service.siteSnapshot(req.params.id, clock()));
  });
  app.get("/api/sites/:id/events", auth.requireOperator, (req, res) => {
    ownedSite(req.params.id, req.phone);
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    res.json({ events: service.listEvents(req.params.id, limit) });
  });

  /* ---------- bookings ---------- */
  app.post("/api/bookings", (req, res) => {
    const body = parse(z.object({
      siteId: z.string().min(1),
      vehicle: z.string().min(1).max(20),
      energyKwh: z.coerce.number(),
      arrivalTime: z.string().regex(/^\d{1,2}:\d{2}$/).optional(),
      departureTime: z.string().regex(/^\d{1,2}:\d{2}$/).optional(),
      arrivalAt: z.number().int().optional(),
      deadlineAt: z.number().int().optional(),
      tzOffsetMin: z.number().int().min(-720).max(840).optional()
    }).refine((b) => (b.arrivalTime && b.departureTime) || (b.arrivalAt && b.deadlineAt),
      { message: "provide arrivalTime + departureTime (HH:MM) or arrivalAt + deadlineAt (epoch ms)" }), req.body);
    // cancelToken is shown once: the driver's app must keep it to cancel later.
    res.status(201).json(service.createBooking(body, clock()));
  });
  app.get("/api/bookings", (req, res) => {
    const ids = String(req.query.ids || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50);
    res.json({ bookings: service.getBookings(ids, clock()) });
  });
  app.get("/api/bookings/:id", (req, res, next) => {
    const [b] = service.getBookings([req.params.id], clock());
    if (!b) return next(new ApiError(404, "errBooking", "Booking not found"));
    res.json({ booking: b });
  });
  app.post("/api/bookings/:id/cancel", (req, res) => {
    const authz = { operatorPhone: auth.phoneFromRequest(req), cancelToken: req.get("x-cancel-token") || req.body?.cancelToken };
    res.json({ booking: service.endBooking(req.params.id, "cancelled", authz, clock()) });
  });
  app.post("/api/bookings/:id/complete", auth.requireOperator, (req, res) => {
    res.json({ booking: service.endBooking(req.params.id, "done", { operatorPhone: req.phone }, clock()) });
  });

  /* ---------- public stations (static snapshot, same as the frontend) ---------- */
  app.get("/api/stations", (req, res) => {
    const type = ["all", "ccs", "type2", "fast"].includes(req.query.type) ? req.query.type : "all";
    const list = stations.sortStations(stations.filterStations(stations.STATIONS, { type, freeOnly: req.query.freeOnly === "true" }));
    res.json({ asOf: stations.STATIONS_AS_OF, stations: list.map((s) => ({ ...s, directionsUrl: stations.directionsUrl(s) })) });
  });

  /* ---------- errors ---------- */
  app.use("/api", (_req, _res, next) => next(new ApiError(404, "notFound", "Not found")));
  app.use((err, _req, res, _next) => {
    if (err instanceof ApiError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "badJson", message: "Malformed JSON" });
    console.error(err);
    res.status(500).json({ error: "internal", message: "Something went wrong" });
  });

  return { app, service, auth };
}

module.exports = { createApp };
