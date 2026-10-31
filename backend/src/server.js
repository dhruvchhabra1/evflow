const config = require("./config");
const { openDb } = require("./db");
const { createApp } = require("./app");

const db = openDb(config.dbPath);
const { app, service } = createApp({ db, config });
if (config.demoMode) service.seedDemo();

// Background ticker: marks finished sessions "done" and re-plans so the queue
// keeps moving even when nobody is polling.
const tick = setInterval(() => { try { service.refreshAllSites(); } catch (e) { console.error("tick failed", e); } }, config.tickMs);
tick.unref();

const server = app.listen(config.port, () => console.log(`EVFlow API listening on :${config.port} (otp=${config.otpMode}, demo=${config.demoMode})`));
const shutdown = () => server.close(() => { db.close(); process.exit(0); });
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
