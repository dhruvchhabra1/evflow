# EVFlow — submission build

This is a real, working app matching the EVFlow planning deck (UCS503): a
rolling-horizon-style charging scheduler with a site power cap, an
earliest-deadline-first + fairness allocation rule, plain-language decision
explanations, an operator dashboard, and an event log — with a multilingual
driver UI (English, Hindi, Punjabi, Gujarati) and WhatsApp booking.

It's built as a PWA (the same architecture your own deck specifies on slide
10), which is the only realistic way to get a genuinely functioning app into
a sub-100MB `.apk` without a native Android build pipeline. Wrapped, it comes
out to roughly 3–15MB — nowhere near the cap.

## What's real vs. simulated

- **Real and working:** the scheduling algorithm (a hard site power cap that
  throttles charging speed, earliest-deadline-first re-planning, fairness
  rule, deadline-feasibility check, generated explanations), the full driver
  flow, operator registration + multi-location dashboard, a structured event
  log, all four languages, offline support, and WhatsApp booking (via `wa.me`
  click-to-chat links — see note below).
- **Simulated for the demo:** there's no backend server or database — all
  state lives on-device (`localStorage`). That includes operator "accounts":
  registering a phone number only exists on this device, there is no OTP/
  password, and a driver on another phone will not see a location an operator
  registered on theirs. Real sign-in and cross-device sync need a backend. Your deck's ACN-Sim/ACN-Data
  integration, the actual optimization solver, and multi-user sync across
  devices are semester-long research components, not something to fake in a
  demo app. If you need a shared backend later, the scheduling logic in
  `scheduler.js` is written as pure functions so it can be lifted into a real
  API without a rewrite.

## Operators and locations

- **Site operator → enter mobile number.** A number registered on this device
  signs straight in; a new number goes to a short registration form (location
  name, address, contact/WhatsApp number, number + power of chargers, site
  power limit). The session is remembered until "Log out".
- A signed-in operator can **Add another location** (dashboard or My
  locations) and switch between their locations. Each location's contact
  number becomes the WhatsApp number drivers message when booking there.
- Operators only see their own locations. Drivers see every location in
  **Find chargers** and the booking form.
- **Demo:** the login screen has a "Try the demo operator" button (it signs in
  as the seeded Thapar site's owner, `9876543210`).
- Navigation: a Back button appears whenever there is somewhere to go back to;
  tapping the EVFlow logo opens the role chooser from anywhere.

## How scheduling works (scheduler.js)

Each site has chargers (max kW each) and one shared power cap. Every booking is
one continuous session on one charger with an exact power-over-time profile,
and the sum of all profiles never exceeds the cap — a session that would break
the cap is slowed down (or starts later). Not-yet-started bookings are
re-planned earliest-deadline-first whenever anything changes; sessions already
charging are locked. A driver who finished here in the last 3 hours is ordered
as if their deadline were 30 min later (fairness). The scheduler picks the
earliest start that meets the deadline, preferring slower chargers so fast
ones stay free; if the deadline is impossible the booking is "Delayed" and
the app says by how many minutes. Sessions finish automatically when their time
passes; operators can also "Mark done" or "Cancel".

## About the WhatsApp booking

A genuine automated WhatsApp bot (someone messages "book" and a server
replies) needs a Meta-verified WhatsApp Business API account, which no one
can set up on your behalf without your business details. What's implemented
instead is the standard, legitimate alternative small businesses use: a
`wa.me` **click-to-chat** link that opens WhatsApp with a pre-filled booking
message addressed to the site's number. A driver taps "Open WhatsApp," the
message is already written, they hit send. It's a real, working booking
channel — just human-confirmed on the operator's end rather than bot-confirmed.

**Before you submit:** the seeded demo site uses a placeholder WhatsApp number.
Open `scheduler.js` and change `phone` in `DEFAULT_SITE` (country code + number,
no `+` or spaces, e.g. `919876543210`). Operator-registered locations use the
contact number their operator typed in.

## Step 1 — Try it locally first

No build step needed. From this folder:
```bash
python3 -m http.server 8000
```
Then open `http://localhost:8000` in a browser. Click through both the
driver flow and the operator dashboard, and test all four languages via the
pill in the top-right corner.

## Step 2 — Put it online (required before making the APK)

PWABuilder (next step) needs a live HTTPS URL to scan — it can't read files
off your laptop. Easiest free options, pick one:

**Netlify (fastest, no account tricks needed):**
1. Go to https://app.netlify.com/drop
2. Drag this whole folder onto the page
3. You'll get a URL like `https://random-name-123.netlify.app` — that's your
   site.

**GitHub Pages (if you already use GitHub):**
1. Create a new repo, push this folder's contents to it
2. Repo Settings → Pages → Deploy from branch → `main` / root
3. Your URL will be `https://<username>.github.io/<repo>`

## Step 3 — Generate the signed APK

1. Go to https://www.pwabuilder.com
2. Paste your live URL from Step 2 and click **Start**
3. Wait for it to score your manifest/service worker (it should score well —
   both are already set up correctly)
4. Click **Package for stores** → choose **Android**
5. Leave the defaults (it will offer to generate a signing key for you —
   keep that keystore file somewhere safe, you'll need it for future updates)
6. Download the generated package — it contains your signed `.apk`
   (typically 3–15MB, well under your 100MB limit)

That `.apk` is what you submit. It installs and runs like any Android app,
works offline after first launch (via the service worker), and needs no
backend server to demo the full driver + operator flow.

## File map

| File | Purpose |
|---|---|
| `index.html` | App shell |
| `style.css` | All styling |
| `i18n.js` | English/Hindi/Punjabi/Gujarati translation strings |
| `store.js` | Storage wrapper (localStorage with an in-memory fallback) |
| `scheduler.js` | Sites, operators, scheduling engine, event log |
| `stations.js` | Public charging stations around Patiala (static snapshot) + filter/sort/directions helpers |
| `app.js` | Screens, navigation (history stack + Back button), operator flow |
| `manifest.json` | PWA metadata (name, icons, theme color) — what PWABuilder reads |
| `sw.js` | Service worker — enables offline use after first load |
| `icons/` | App icons (192px, 512px) |

## Find chargers (public stations)

The **Find chargers** tab lists 14 public stations around Patiala plus every
EVFlow-managed site (pinned at the top — the only ones that can be booked).
Two Google listings with no connector or power details were removed.

- Data lives in `stations.js`, collected from Google Maps listings on
  28 Oct 2026. It is a **static snapshot**: the "x of y free" counts do not
  update live, and the screen says so.
- **Coordinates:** 6 stations list a Google plus code, which was decoded to
  exact lat/lng. The other 8 have `lat: null`; their Directions button
  searches Google Maps by name + address instead. Nothing is guessed.
- **Directions** opens Google Maps (`maps/dir/?api=1&destination=…`); **Call**
  uses a `tel:` link.
- **To refresh or add a station:** edit the `STATIONS` array, then bump
  `CACHE` in `sw.js` (e.g. `evflow-v4`) so installed copies pick up the change.
