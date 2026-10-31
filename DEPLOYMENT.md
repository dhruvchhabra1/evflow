# EVFlow deployment layout

This repository keeps the static frontend at the repository root and the API in `backend/`.

## Netlify (frontend)
- Base directory: `/` (repository root)
- Publish directory: `.`
- Build command: leave blank (static HTML/CSS/JS)

## Render (backend)
- Root Directory: `backend`
- Build Command: `npm install`
- Start Command: `npm start`

Set these Render environment variables:
- `JWT_SECRET`: a long, random secret
- `CORS_ORIGIN`: `https://evflow1.netlify.app`
- `NODE_ENV`: `production`
- `DEMO_MODE`: `true` only if you intentionally want demo data

The backend entrypoint is `backend/src/server.js`; its Express app is `backend/src/app.js`.
Do not move backend files into the frontend root: both projects contain files named
`app.js`, `scheduler.js`, and `stations.js`.

## Important frontend limitation
The frontend currently loads its local `scheduler.js`; it does not yet call the
backend API. This corrected layout fixes the backend file collision and allows
Render to start the API, but cross-device synchronization requires a separate
frontend API integration step.
