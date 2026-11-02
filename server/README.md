# MiDrives carpool server

The MiDrives app works on its own and keeps rides on each iPhone. Carpool groups need one small server that every phone in the group talks to. This folder is that server: one file, no dependencies, Node 18 or newer.

## What you need to do

1. **Run `server.js` somewhere that's always on and reachable over HTTPS.** The app is served over HTTPS, so iPhones refuse to talk to a plain `http://` server.
2. **Put its address in [`config.js`](../config.js)** at the root of the repo, for example:
   ```js
   window.MIDRIVES_CONFIG = { carpoolServer: 'https://midrives-carpool.example.com' };
   ```
3. **Commit and push.** GitHub Pages updates the app, and **Settings › Carpool** shows up the next time people open MiDrives.

To test locally first:

```bash
cd server
PORT=8080 node server.js
curl http://localhost:8080/health   # {"ok":true,"app":"midrives","api":1}
```

### Settings (environment variables)

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8080` | Port to listen on |
| `DATA_FILE` | `./data.json` | Where groups, members and rides are saved |
| `ALLOWED_ORIGIN` | `*` | Set to `https://faisalirshid.github.io` so only the app can call it |

### Where to host it

Any always-on Node host with HTTPS works. The one thing to watch is that **`DATA_FILE` must be on storage that survives restarts and redeploys**, or the groups disappear.

- **Your own VPS or home server:** run it with `pm2` or a systemd service, and put Caddy or nginx in front for HTTPS.
- **Fly.io or Railway:** attach a volume and point `DATA_FILE` at it, for example `/data/data.json`.
- **Render:** needs a paid persistent disk. Free instances lose files on restart.

Back up `data.json` now and then.

### Using your own backend instead

You don't have to use this file. Any server that implements the API below works with the app without changes. That includes Supabase Edge Functions, Firebase Cloud Functions or your own stack.

## API

JSON in and out. Every response includes the CORS headers, and `OPTIONS` returns `204`. Errors look like `{ "error": "message" }` with a 4xx status.

Each phone stores the `token` it gets when it starts or joins a group, and sends it as `Authorization: Bearer <token>` on every group call. Tokens are random; only their SHA-256 hash is stored.

| Method and path | Body | Returns |
|---|---|---|
| `GET /health` | | `{ ok: true, app: "midrives", api: 1 }` |
| `POST /groups` | `{ name, driverName, price, memberName }` | `201 { group, me: { id, token }, invite: { code, expiresAt } }`. The caller becomes the **organizer** |
| `POST /join` | `{ code, memberName }` | `{ group, me: { id, token } }`. `404` if the code is wrong or expired, `409` if the group is full (8) |
| `GET /groups/:id` | | `{ group, me: { id } }` |
| `PATCH /groups/:id` | `{ name?, driverName?, price? }` | `{ group }`. Organizer only. A new price applies from today |
| `POST /groups/:id/invites` | | `201 { invite: { code, expiresAt } }`. Codes are 6 characters and last 7 days |
| `PUT /groups/:id/rides` | `{ date: "YYYY-MM-DD", leg: "w" or "h", riders: [memberId] }` | `{ ride }`. `riders: []` means nobody rode, `riders: null` deletes the answer |
| `DELETE /groups/:id/members/:memberId` | | `204`. Leave yourself, or the organizer removes someone. If the organizer leaves, the longest-standing member takes over. The group is deleted when the last person leaves |

The `group` object:

```json
{
  "id": "aB3dE5fG7",
  "name": "Riding with Loay",
  "driverName": "Loay",
  "prices": [{ "from": "2026-11-02", "rate": 2.5 }],
  "members": [{ "id": "x1y2z3a4", "name": "Faisal", "role": "organizer", "joinedOn": "2026-11-02" }],
  "rides": { "2026-11-02": { "w": { "riders": ["x1y2z3a4", "q9r8s7t6"], "by": "x1y2z3a4", "at": "2026-11-02T04:41:00Z" } } }
}
```

**How the split works (in the app):** each ride costs the price for that day. It's split evenly between the riders in that ride, and each person's monthly total is the sum of their shares.
