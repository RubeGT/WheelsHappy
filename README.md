# Wheels Happy

Wheels Happy is a browser-playable game whose featured level catalogue comes from `public/get_level.hw`. The backend serves that catalogue to the game's Browse Levels flow and forwards selected catalogue IDs to the original game level service.

## Run locally

Install Node.js 22 or newer and PostgreSQL. Create a database, copy `.env.example` to `.env`, set `DATABASE_URL`, and set `TOKEN_SECRET` to a random value of at least 32 characters. Then run:

```sh
npm ci
npm start
```

Open `http://localhost:3000`. The service creates its database tables on startup. `npm test` runs the HTTP integration suite against an isolated in-memory PostgreSQL engine; tests do not need a database server or production credentials.

## Deploy on Render

Create a Blueprint from this repository using `render.yaml`. It provisions the Node web service and PostgreSQL database, generates `TOKEN_SECRET`, and serves the website (including the game HTML, scripts, and assets) and API at the service URL. Open the deployed service URL to play in the browser; the game is loaded into the page's embedded game frame and its game requests use the same website host. Configure `ADMIN_EMAILS` as a comma-separated list of account emails if administrator access is needed.

The browser resolves the API URL from the current website origin, so no API URL or secret needs to be embedded in the client. Set `CORS_ORIGINS` only for additional cross-origin clients; the default includes local origins and `null` for the optional Electron wrapper.

## Browse and play levels

1. Click **Play** or **Browse Levels** in the game.
2. The service returns the entries in `public/get_level.hw`; the browser catalogue also paginates all entries in that file.
3. Select a level to open it in the embedded game.
4. The game requests the selected level document from `/get_level.hw`; the service validates the ID against the local catalogue and forwards the request to the original game level service.

`get_level.hw` contains 139 catalogue records with level IDs, titles, authors, ratings, and descriptions. It does **not** contain the playable level documents themselves. A live check of the original service returned catalogue metadata rather than the playable document, so gameplay of these featured IDs is not yet verified. To make a Discord server's own levels playable, the server must receive each actual exported level document and serve it for its level ID; changing only the catalogue XML can list levels but cannot supply missing game data.

`GET /get_level.hw` and requests with `action=get_featured` return the local catalogue. `GET /api/levels` provides a searchable, paginated JSON view of the same file. `POST /get_level.hw` with `action=get_level` and a catalogue `level_id` requests the corresponding playable document; the service returns an explicit error if the upstream responds with catalogue metadata instead. Account registration/login/session validation/logout and `GET /api/health` remain available.

Passwords are stored as salted scrypt hashes. Bearer tokens are signed server-side, expire after seven days, and are revocable on sign-out. Never put `TOKEN_SECRET` or database credentials in `public/`.

## Imported files

The browser game, bundled assets, and source catalogue are in `public/`; the API and account database setup are in `src/`. Dependency folders, Git metadata, the Electron-only wrapper, packaged installers, and generated release/build outputs from the source folder are intentionally excluded.
