/*
 * Public EV charging stations around Patiala.
 *
 * Source: details collected from Google Maps listings on 28 Oct 2026.
 * This is a static snapshot — there is no backend, so `free` counts do NOT
 * update live. The UI says so. To refresh: edit this file, bump the CACHE
 * name in sw.js, and redeploy.
 *
 * Fields
 *   id        unique slug
 *   name      as listed
 *   address   as listed (may be a Google plus code when no street address is given)
 *   lat, lng  decoded from the plus code where one was listed; null otherwise.
 *             Never guessed — when null, Directions searches by name + address.
 *   open24    true if the listing says "Open 24 hours"; null if not stated
 *   phone     digits only (for tel: links), or null
 *   connectors[]  { type, kw, total, free }
 *             free = how many were available at snapshot time; null = the
 *             listing only showed a total (live availability not known)
 *
 * Listings with no connector/power details at all ("Electric Vehicle Charging
 * Station · C 71" and "· 89VX+XX2") were removed — a driver can't act on them.
 */

const STATIONS_AS_OF = "2026-10-28"; // ISO date; formatted per language in the UI

const STATIONS = [
  {
    id: "tata-bhupindra",
    name: "Tata Power Charging Station",
    address: "Raj Kamal Square, 22, Bhupindra Rd",
    lat: null, lng: null,
    open24: true, phone: "18008332233",
    connectors: [{ type: "CCS", kw: 30, total: 1, free: null }]
  },
  {
    id: "zevpoint",
    name: "Zevpoint Charging Station",
    address: "89QM+336",
    lat: 30.33766, lng: 76.38264,
    open24: null, phone: null,
    connectors: [{ type: "Type 2", kw: 22, total: 1, free: null }]
  },
  {
    id: "hp-99c7",
    name: "HP e-Charge Charging Station",
    address: "99C7+F9M",
    lat: 30.37121, lng: 76.36342,
    open24: true, phone: null,
    connectors: [{ type: "CCS", kw: 30, total: 2, free: null }]
  },
  {
    id: "chargezone-yashodha",
    name: "ChargeZone Charging Station",
    address: "Yashodha Hyundai, Sirhind Rd",
    lat: null, lng: null,
    open24: true, phone: "18001212025",
    connectors: [{ type: "CCS", kw: 60, total: 2, free: 2 }]
  },
  {
    id: "kazam-rajpura-rd",
    name: "Kazam Charging Station",
    address: "660, Rajpura Rd",
    lat: null, lng: null,
    open24: true, phone: null,
    connectors: [{ type: "CCS", kw: 30, total: 1, free: null }]
  },
  {
    id: "rimone-spectra",
    name: "Rimone Charging Station",
    address: "Spectra Mall, Rajpura Rd",
    lat: null, lng: null,
    open24: true, phone: null,
    connectors: [{ type: "Type 2", kw: 22, total: 1, free: null }]
  },
  {
    id: "hp-nh64",
    name: "HP e-Charge Charging Station",
    address: "Punjab University, 64, National Highway",
    lat: null, lng: null,
    open24: true, phone: null,
    connectors: [{ type: "CCS", kw: 30, total: 2, free: null }]
  },
  {
    id: "thunderplus",
    name: "ThunderPlus Charging Station",
    address: "Municipal Corporation",
    lat: null, lng: null,
    open24: true, phone: null,
    connectors: [{ type: "Unknown", kw: 15, total: 2, free: null }]
  },
  {
    id: "bpcl-bhadson",
    name: "BPCL Charging Station",
    address: "9989+M5H, Bhadson Rd",
    lat: 30.36669, lng: 76.36798,
    open24: true, phone: "1800224344",
    connectors: [{ type: "CCS", kw: 60, total: 2, free: 0 }]
  },
  {
    id: "hp-nabha-patiala",
    name: "HP e-Charge Charging Station",
    address: "88XQ+4F5, Nabha-Patiala Rd",
    lat: 30.34776, lng: 76.33873,
    open24: true, phone: null,
    connectors: [{ type: "CCS", kw: 30, total: 1, free: null }]
  },
  {
    id: "hp-9cj2",
    name: "HP e-Charge Charging Station",
    address: "9CJ2+6M7",
    lat: 30.38054, lng: 76.40167,
    open24: true, phone: null,
    connectors: [{ type: "CCS", kw: 30, total: 2, free: null }]
  },
  {
    id: "adani-outlet-walk",
    name: "Adani Charging Station",
    address: "The Outlet Walk, Sangrur Road",
    lat: null, lng: null,
    open24: true, phone: null,
    connectors: [
      { type: "CCS", kw: 60, total: 2, free: 2 },
      { type: "Wall socket", kw: 3, total: 1, free: 1 }
    ]
  },
  {
    id: "chargezone-dpg",
    name: "ChargeZone Charging Station",
    address: "DPG Hyundai, Rajpura - Patiala Rd",
    lat: null, lng: null,
    open24: true, phone: "18001212025",
    connectors: [{ type: "CCS", kw: 60, total: 2, free: 2 }]
  },
  {
    id: "bpcl-78wg",
    name: "BPCL Charging Station",
    address: "78WG+HQP",
    lat: 30.29646, lng: 76.32695,
    open24: true, phone: "1800224344",
    connectors: [{ type: "CCS", kw: 60, total: 2, free: 2 }]
  }
];

// Google Maps directions link. Uses exact coordinates when we have them,
// otherwise a name + address search (always scoped to Patiala).
function directionsUrl(st) {
  const dest = (st.lat != null && st.lng != null)
    ? `${st.lat},${st.lng}`
    : `${st.name}, ${st.address}, Patiala, Punjab`;
  return "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(dest);
}

function stationMaxKw(st) {
  return st.connectors.reduce((m, c) => Math.max(m, c.kw), 0);
}

// Total free across connectors: a number if at least one connector reported
// availability, otherwise null (unknown).
function stationFree(st) {
  const known = st.connectors.filter((c) => c.free != null);
  if (known.length === 0) return null;
  return known.reduce((s, c) => s + c.free, 0);
}

// Order: has free chargers → unknown → none free; then fastest first; then name.
function stationRank(st) {
  const f = stationFree(st);
  return f == null ? 1 : f > 0 ? 0 : 2;
}
function sortStations(list) {
  return list.slice().sort((a, b) =>
    stationRank(a) - stationRank(b) ||
    stationMaxKw(b) - stationMaxKw(a) ||
    a.name.localeCompare(b.name)
  );
}

function filterStations(list, { type, freeOnly }) {
  return list.filter((st) => {
    if (type === "ccs" && !st.connectors.some((c) => c.type === "CCS")) return false;
    if (type === "type2" && !st.connectors.some((c) => c.type === "Type 2")) return false;
    if (type === "fast" && stationMaxKw(st) < 50) return false;
    if (freeOnly && !(stationFree(st) > 0)) return false;
    return true;
  });
}

module.exports = { STATIONS, STATIONS_AS_OF, directionsUrl, stationMaxKw, stationFree, sortStations, filterStations };
