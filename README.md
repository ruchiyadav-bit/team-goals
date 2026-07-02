# Team Goals & Performance CRM

Internal web app for performance-marketing / affiliate teams: monthly goals with a 2-step approval
chain, weekly actuals with reason codes, pacing & forecasting, overview boards, reports,
feedback/ratings, admin-only appraisals, coupons, month locking, and an append-only audit log.

Stack: **Node.js + Express + better-sqlite3** (single-file DB), vanilla-JS SPA + Chart.js,
bcrypt password hashing, JWT http-only cookie sessions.

## Quick start

```bash
npm install
npm start
# → http://localhost:3000
```

First run seeds the admin account and default verticals (CPS, iGaming, Nutra, Coupon, Pay Per Call, MetAds).

**Admin credentials (change immediately in Settings → Change password):**

- username: `admin`
- password: `admin123` (or set `ADMIN_PASSWORD` env var before first run)

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | Where `app.db` and the JWT secret live |
| `JWT_SECRET` | auto-generated, persisted in `DATA_DIR/secret.key` | Session signing key |
| `ADMIN_PASSWORD` | `admin123` | First-run admin password |
| `NODE_ENV` | — | Set `production` to mark cookies `Secure` (HTTPS required) |

## Roles

Admin › Manager › Leader › Member. All authorization is enforced **server-side** per endpoint
(scoping via `subtreeIds` in `src/helpers.js`); a member cannot read another member's data even
with direct API calls (403).

- **Member** — own dashboard, submits goals (→ leader → admin), fills weekly actuals, sees own-vertical leaderboard peers.
- **Leader** — creates members (auto-assigned), distributes targets (→ pending admin), first-step approvals, team data.
- **Manager** — creates leaders (auto-assigned) + members under their leaders, views their whole sub-tree.
- **Admin** — everything: final approvals, company view, appraisals, month lock/unlock, instant verticals, full audit.

## Key workflows

1. Month start: goals set/submitted → approval chain (reject requires a remark; edit & resubmit).
2. Weekly: actuals + reason code if missed. Pacing, ROAS, achievement %, forecast update live.
3. Weekly meeting: overview board + feedback thread + meeting notes.
4. Month end: admin checks Company report, ratings + self-reviews recorded, month **locked**.
5. Appraisal: admin-only printable scorecard per person.

## Backups

Everything lives in `DATA_DIR` (default `./data`): copy `app.db` (plus `app.db-wal`/`app.db-shm`
if present, or run `sqlite3 app.db ".backup backup.db"`). That's the whole dataset.

## Deploying on a VPS (nginx + HTTPS)

```bash
# on the server
git clone <this repo> /opt/team-goals-crm && cd /opt/team-goals-crm
npm install --omit=dev
NODE_ENV=production PORT=3000 node server.js   # or use pm2/systemd (below)
```

systemd unit (`/etc/systemd/system/team-goals.service`):

```ini
[Unit]
Description=Team Goals CRM
After=network.target

[Service]
WorkingDirectory=/opt/team-goals-crm
Environment=NODE_ENV=production
Environment=PORT=3000
ExecStart=/usr/bin/node server.js
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

nginx (subdomain):

```nginx
server {
  server_name goals.example.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Subpath deploy (`example.com/monthlygoals`) works too — strip the prefix at the proxy:

```nginx
location /monthlygoals/ { proxy_pass http://127.0.0.1:3000/; ... }
```

Add HTTPS with `certbot --nginx`. Set `NODE_ENV=production` so session cookies are Secure.

## Project layout

```
server.js          entry point (express, static, error handling)
src/db.js          schema, admin + vertical seeding, JWT secret
src/auth.js        login/logout, JWT cookie middleware
src/helpers.js     scoping (data isolation), month math, audit writer
src/routes.js      all authenticated API endpoints
public/            SPA (index.html, app.js, style.css)
data/              created at runtime: app.db + secret.key  (back this up)
```

## Acceptance criteria mapping

1. Cross-member isolation → `subtreeIds`/`canView` guard every `/month`, `/comments`, `/reviews`, `/reports/trend` route (403).
2. Approval chain member → leader → admin with reject+remark & resubmit → `/month/.../submit|approve|reject`.
3. Delegated creation with auto-assignment → `POST /api/users`.
4. Appraisal admin-only → `GET /api/appraisal/:userId` returns 403 for non-admins.
5. Company view (admin-only) → `GET /api/reports/company` incl. profit-by-vertical + "All verticals" total.
6. Month lock blocks edits except admin; action audited → `/month/.../lock`, checks in goal/week/self-review routes.
7. Leader-proposed vertical usable only after admin approval → `verticals.status`, dropdowns read approved only.
8. Calculations (pacing, ROAS, achievement, forecast) → `computeMonth` in `src/helpers.js`.
