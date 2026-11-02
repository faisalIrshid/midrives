# MiDrives server

The MiDrives app works on its own and keeps rides on each iPhone. Two features need a small server that every phone talks to:

- **Carpool groups:** shared rides and the price split.
- **Reminders:** the 7:00 AM and 4:00 PM notifications. iPhone web apps can't schedule notifications themselves, so the server sends them.

This folder is that server: one file, Node 18 or newer. Carpool needs no packages. Reminders need one, `web-push`.

## What you need to do

1. **Run `server.js` somewhere that's always on and reachable over HTTPS.** Run `npm install` in this folder first so reminders work. The app is served over HTTPS, so iPhones refuse to talk to a plain `http://` server.
2. **Put its address in [`config.js`](../config.js)** at the root of the repo, for example:
   ```js
   window.MIDRIVES_CONFIG = { carpoolServer: 'https://midrives-carpool.example.com' };
   ```
3. **Commit and push.** GitHub Pages updates the app. The next time people open MiDrives, **Settings › Carpool** works and **Settings › Schedule › Reminders** can be turned on.

To test locally first:

```bash
cd server
npm install
PORT=8080 node server.js
curl http://localhost:8080/health   # {"ok":true,"app":"midrives","api":1,"reminders":true}
```

Add `PUSH_DRY_RUN=1` to print reminders in the log instead of sending them.

### Settings (environment variables)

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8080` | Port to listen on |
| `DATA_FILE` | `./data.json` | Where groups, members and rides are saved |
| `ALLOWED_ORIGIN` | `*` | Set to `https://faisalirshid.github.io` so only the app can call it |
| `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` | generated | Keys that sign reminders. If unset, the server makes a pair on first run and saves it in `DATA_FILE`. Don't lose them, or everyone has to turn reminders on again |
| `VAPID_SUBJECT` | the repo URL | A `mailto:` or `https://` contact that Apple and Google can reach you on |
| `PUSH_DRY_RUN` | off | `1` logs reminders instead of sending them |

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

### Reminders

| Method and path | Body | Returns |
|---|---|---|
| `GET /push/key` | | `{ publicKey }`, the VAPID key the phone subscribes with |
| `POST /push/subscribe` | `{ subscription, schedule: { m, e, days, tz }, driverName, carpool: { groupId, memberId } or null }` | `201 { id, token }`. One entry per phone, so subscribing again replaces it |
| `PUT /push/:id` | any of `schedule`, `driverName`, `carpool`, `answered: { date, m?, e? }` | `{ ok: true }`. Send with `Authorization: Bearer <token>` |
| `DELETE /push/:id` | | `204`. Turns reminders off |

`m` and `e` are minutes after midnight (420 = 7:00 AM). `days` uses 0 = Sunday. `tz` is an IANA zone such as `Asia/Amman`.

Every 30 seconds the server sends `{ title, body, leg: "m" or "e", date }` to each phone that is on a work day at or just past its time. It sends each reminder at most once, and up to 15 minutes late if the server was down. It skips a reminder when the phone already answered that day, or when someone in the phone's carpool already logged that ride. Subscriptions that Apple reports as gone are deleted.

**How the split works (in the app):** each ride costs the price for that day. It's split evenly between the riders in that ride, and each person's monthly total is the sum of their shares.
