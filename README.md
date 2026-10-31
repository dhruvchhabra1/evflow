# EVFlow backend

REST API for the EVFlow charging scheduler: a hard site power cap, earliest-deadline-first
re-planning, a fairness rule, plain-language decision reasons, operator accounts and an event log.
Node.js + Express + SQLite (`better-sqlite3`). The scheduling algorithm is the frontend's
`scheduler.js`, ported unchanged into `src/scheduler.js` (pure functions, no storage).

## Run

```bash
npm install
cp .env.example .env        # defaults work for local dev
npm start                   # http://localhost:3000/api/health
npm test                    # 13 tests: scheduler rules + full HTTP flows
```

Dev mode (`OTP_MODE=dev`, `DEMO_MODE=true`) needs no SMS provider: the OTP is returned in the
`request-otp` response, and `POST /api/auth/demo` signs in as the seeded Thapar operator.

## What changed vs. the frontend-only build

| Frontend (localStorage) | Backend |
|---|---|
| Operator "login" = typing a number | Phone + 6-digit OTP, JWT session |
| Anyone could cancel anything on the device | Driver cancels with a per-booking token; operators only manage their own sites |
| State per device | Shared SQLite DB: drivers see every operator's sites |
| Planning on page load / timer | Planning inside a DB transaction on every write + a 30 s background tick |
| Device timezone | Explicit timezone (`tzOffsetMin`, default IST 330) |

## API

Errors: `{ "error": "<code>", "message": "..." }`. Codes such as `errKwh`, `errDup`, `errCap`, `errShort`
match the frontend's i18n keys, so existing translated messages keep working.

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/health` | – | liveness |
| `POST /api/auth/request-otp` `{phone}` | – | send OTP (dev: returned as `devOtp`) |
| `POST /api/auth/verify-otp` `{phone, otp}` | – | → `{token, phone, registered}`; `registered:false` → show registration form |
| `POST /api/auth/demo` | – | demo operator (only if `DEMO_MODE=true`) |
| `GET /api/me` | JWT | phone + own sites |
| `GET /api/sites`, `GET /api/sites/:id` | – | all locations (drivers) |
| `POST /api/sites` `{name,address,phone,chargerCount,chargerKw,capKw}` | JWT | register a location (`chargers:[{id,maxKw}]` also accepted) |
| `GET /api/me/sites` | JWT | operator's locations |
| `GET /api/sites/:id/snapshot` | JWT, owner | dashboard: chargers, live kW, queue, alerts, events |
| `GET /api/sites/:id/events?limit=` | JWT, owner | event log |
| `POST /api/bookings` `{siteId, vehicle, energyKwh, arrivalTime, departureTime, tzOffsetMin?}` | – | plan a session → `{booking, cancelToken}` (token shown **once**) |
| `GET /api/bookings?ids=a,b` / `GET /api/bookings/:id` | – | driver's bookings (ids are unguessable) |
| `POST /api/bookings/:id/cancel` | `X-Cancel-Token` or owner JWT | cancel + re-plan |
| `POST /api/bookings/:id/complete` | JWT, owner | mark done + re-plan |
| `GET /api/stations?type=all\|ccs\|type2\|fast&freeOnly=` | – | public stations (same static Patiala snapshot) |

Booking object: `status` (`waiting`/`confirmed`/`delayed`/`done`/`cancelled`), `reasonKey` (i18n key,
e.g. `reason_powerCap`), `charger`, `startAt`/`completeAt` (epoch ms), `profile` (`[{from,to,kw}]`), `lateMin`.

## Connecting the frontend

`client/api.js` replaces the frontend's `scheduler.js` with `fetch` calls (same function names).
The calls become `async`, so `await` them in `app.js` and re-render when they resolve. Set
`window.EVFLOW_API` to your deployed API URL. Drivers' cancel tokens are kept in `Store` under `myBookings`.

## Deploy

Any Node 20+ host (Render, Railway, Fly.io) or `docker build -t evflow-api . && docker run -p 3000:3000 -v evflow:/data -e JWT_SECRET=... -e CORS_ORIGIN=https://your-frontend evflow-api`.
Production needs `JWT_SECRET`; set `OTP_MODE=sms` + Twilio vars, `DEMO_MODE=false`, and `CORS_ORIGIN`.
Keep it to **one instance** (SQLite on a persistent disk); for more, move to Postgres.

## Limits / honest notes

- Twilio SMS sending is written but **untested** (needs real credentials); everything else is covered by `npm test`.
- Driver bookings are anonymous (vehicle number + cancel token) — no driver accounts, as in the frontend.
- Station availability is still the static 28-Oct-2026 snapshot; live data needs a charge-point network API.
- WhatsApp booking is unchanged (client-side `wa.me` link to the site's phone). A real bot needs a Meta Business API account.
- Only the planner's output is stored; the optimiser is the same heuristic as the frontend, not an ACN-Sim solver.
