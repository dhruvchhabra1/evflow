/*
 * Phone-number OTP login for operators, JWT sessions.
 *   POST /api/auth/request-otp  -> sends a 6-digit code (OTP_MODE=sms) or returns it (OTP_MODE=dev)
 *   POST /api/auth/verify-otp   -> returns a JWT proving the caller owns that phone number
 * Codes are stored hashed, expire in 5 min, allow 5 attempts, and can be re-sent every 30 s.
 */
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

function createAuth(db, config, service) {
  const { ApiError } = service;
  const hash = (phone, code) =>
    crypto.createHmac("sha256", config.jwtSecret).update(`${phone}:${code}`).digest("hex");

  const getOtp = db.prepare("SELECT * FROM otps WHERE phone = ?");
  const putOtp = db.prepare(`INSERT INTO otps (phone, code_hash, expires_at, attempts, sent_at)
    VALUES (@phone, @codeHash, @expiresAt, 0, @sentAt)
    ON CONFLICT(phone) DO UPDATE SET code_hash=@codeHash, expires_at=@expiresAt, attempts=0, sent_at=@sentAt`);
  const delOtp = db.prepare("DELETE FROM otps WHERE phone = ?");
  const bumpAttempts = db.prepare("UPDATE otps SET attempts = attempts + 1 WHERE phone = ?");

  async function sendSms(phone, text) {
    if (config.otpMode === "dev") { console.log(`[otp:dev] ${phone}: ${text}`); return; }
    const { sid, token, from } = config.twilio;
    if (!sid || !token || !from) throw new ApiError(503, "smsNotConfigured", "SMS provider is not configured");
    // Twilio REST API (untested here — needs real credentials). Swap for MSG91/etc. if preferred.
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ To: "+" + phone, From: from, Body: text })
    });
    if (!res.ok) throw new ApiError(502, "smsFailed", "Could not send the OTP SMS");
  }

  async function requestOtp(phone, now = Date.now()) {
    const existing = getOtp.get(phone);
    if (existing && now - existing.sent_at < config.otpResendMs) {
      throw new ApiError(429, "otpTooSoon", "Please wait a few seconds before requesting another code");
    }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    putOtp.run({ phone, codeHash: hash(phone, code), expiresAt: now + config.otpTtlMs, sentAt: now });
    await sendSms(phone, `Your EVFlow code is ${code}. It expires in 5 minutes.`);
    return config.otpMode === "dev" ? { sent: true, devOtp: code } : { sent: true };
  }

  function verifyOtp(phone, code, now = Date.now()) {
    const row = getOtp.get(phone);
    if (!row || row.expires_at < now) throw new ApiError(400, "otpInvalid", "Code expired or not requested");
    if (row.attempts >= config.otpMaxAttempts) { delOtp.run(phone); throw new ApiError(429, "otpLocked", "Too many wrong attempts — request a new code"); }
    const ok = crypto.timingSafeEqual(Buffer.from(hash(phone, code)), Buffer.from(row.code_hash));
    if (!ok) { bumpAttempts.run(phone); throw new ApiError(400, "otpInvalid", "Incorrect code"); }
    delOtp.run(phone);
    return issueSession(phone);
  }

  function issueSession(phone) {
    const token = jwt.sign({ sub: phone }, config.jwtSecret, { expiresIn: config.jwtTtl });
    return { token, phone, registered: service.isOperator(phone) };
  }

  function phoneFromRequest(req) {
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return null;
    try { return jwt.verify(h.slice(7), config.jwtSecret).sub; } catch { return null; }
  }

  const requireOperator = (req, _res, next) => {
    const phone = phoneFromRequest(req);
    if (!phone) return next(new ApiError(401, "unauthenticated", "Sign in required"));
    req.phone = phone;
    next();
  };

  return { requestOtp, verifyOtp, issueSession, phoneFromRequest, requireOperator };
}

module.exports = { createAuth };
