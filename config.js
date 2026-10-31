require("dotenv").config();

const env = process.env;
const isProd = env.NODE_ENV === "production";

const config = {
  isProd,
  port: Number(env.PORT || 3000),
  dbPath: env.DB_PATH || "./data/evflow.db",
  corsOrigin: env.CORS_ORIGIN || "*",           // set to your frontend URL in production
  jwtSecret: env.JWT_SECRET || (isProd ? null : "dev-only-secret-change-me"),
  jwtTtl: env.JWT_TTL || "30d",
  otpMode: env.OTP_MODE || (isProd ? "sms" : "dev"), // dev = OTP is returned in the API response + logged
  otpTtlMs: 5 * 60 * 1000,
  otpMaxAttempts: 5,
  otpResendMs: 30 * 1000,
  demoMode: (env.DEMO_MODE || (isProd ? "false" : "true")) === "true",
  defaultTzOffsetMin: Number(env.DEFAULT_TZ_OFFSET_MIN || 330), // IST
  tickMs: Number(env.TICK_MS || 30000),
  twilio: { sid: env.TWILIO_ACCOUNT_SID, token: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_FROM }
};

if (!config.jwtSecret) throw new Error("JWT_SECRET must be set in production");
module.exports = config;
