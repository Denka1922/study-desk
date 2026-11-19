# Sync between the PC and the phone

This file explains how Study Desk keeps the PC app and the phone app in step, and it is the exact contract the code follows.
Nothing here needs an account of ours: your data goes from your PC to your phone, or through a relay that **you** run, and it is
encrypted with a key that only your two devices hold.

## What the user sees

On the PC: **Sync** button → "Connect a phone" → pick how the devices find each other → a QR code appears.
On the phone: **Sync** button → "Scan the code from your PC" → done. After that the two apps keep each other up to date.

| Choice | Needs | Good for | Does not work when |
|---|---|---|---|
| **Same Wi-Fi** | Nothing else. Both apps open, both on the same Wi-Fi. | Home, dorm, school with normal Wi-Fi | Phone is on mobile data, or the Wi-Fi blocks devices from seeing each other (some school and guest networks) |
| **Over the internet** | A free relay address (one-time setup, see `relay/README.md`) | Anywhere, mobile data, different networks | Relay is not set up |
| **Both** | The relay address | Fastest when at home, still works away from home | |

Bluetooth was considered and rejected: a Windows/Electron app and an Android Capacitor app can only be the *client* side of
Bluetooth LE, so neither can offer a service to the other without custom native code on both. Wi-Fi and the relay need none.

## What syncs

Calendar events (exams, grades), to-dos and deadlines, shortcuts, and the AI Tutor's saved courses (outline, lessons, quiz
scores, exams). **Never synced:** the AI key, AI settings (provider, model, power level, local model), theme, sample data.

## Data model: the sync document

Built by the page. Items are keyed by id and carry the time they last changed. Deleted ids are remembered as "tombstones".

```json
{ "v": 1, "dev": "<deviceId>", "at": 1760000000000,
  "items": { "<id>": { "k": "event|task|link|course", "u": 1760000000000, "d": { } } },
  "gone":  { "<id>": 1760000000000 } }
```

* `u` = milliseconds when that item last changed on any device. `d` = the item as the app stores it.
* **Merge rule (per id):** take the newest of {item on A, item on B, tombstone on A, tombstone on B}. If the newest is a
  tombstone the item is deleted; otherwise the newest item wins. Equal times: the item whose JSON text is larger wins
  (any fixed rule works, it only has to be the same on both sides). Tombstones older than 90 days are dropped.
* **rev** = lowercase hex SHA-256 of the canonical text of `items` and `gone` (keys sorted, no `dev`/`at`). Two devices holding
  the same data have the same rev, so "same rev" means "nothing to do".
* Items the page has never stamped have `u = 0`. Sample items are not sent, and are removed on a device when real items arrive.
* Newest-change-wins uses the devices' clocks. If a phone clock is minutes off, a near-simultaneous edit may pick the wrong side.

## Pairing code (what the QR holds)

Text `SDSYNC1.` + base64url (no padding) of this UTF-8 JSON:

```json
{ "s": "<32 random bytes, base64url>", "m": "wifi|net|both",
  "p": 47821, "a": ["192.168.1.20"], "r": "https://sd-relay.example.workers.dev", "n": "My PC" }
```

`p` and `a` (port and the PC's private IPv4 addresses) appear for `wifi`/`both`; `r` (relay base URL, https only) for `net`/`both`.
`n` is a name to show on the phone, at most 40 characters. The same text is shown under the QR so it can be typed or pasted.
Anyone who sees the code can read and change the planner data, so the dialog says to keep it private; "Forget this
connection" creates a new secret and the old code stops working.

## Keys and encryption (identical on the PC side in Node and the phone side in the page)

* `S` = the 32-byte secret. `salt` = UTF-8 `study-desk-sync-v1`.
* `K_enc` = HKDF-SHA256(ikm `S`, salt, info UTF-8 `enc`, 32 bytes) → AES-256-GCM key.
* `room` = lowercase hex of HKDF-SHA256(S, salt, info `room`, 16 bytes) (32 hex characters).
* `token` = base64url of HKDF-SHA256(S, salt, info `relay-token`, 32 bytes).
* Envelope: `{"v":1,"i":"<base64url 12-byte random IV>","c":"<base64url ciphertext followed by the 16-byte GCM tag>"}`.
  Additional authenticated data = UTF-8 `study-desk-sync-v1`. Plaintext = UTF-8 JSON. A fresh IV for every message.
* Anything that fails to decrypt is rejected; the tag is the only authentication.

## Same Wi-Fi protocol

The **PC app is the server** (Electron main process). It listens only while a pairing with `wifi` or `both` is on,
on `0.0.0.0` port `47821` (if busy, the next free port up to `47830`; the real port is put in the QR).
The **phone is the client** and starts everything.

`POST /v1/x`, `Content-Type: application/json`, body = envelope of a request message. Reply 200 with an envelope of a reply message.
Every other path or method: 404 with an empty body. Rules: body larger than 8 MB → 413; JSON or envelope malformed → 400;
fails to decrypt → 401 (empty body); no answer from the app window within 15 s → 503; remote address not private
(10/8, 172.16/12, 192.168/16, 169.254/16, loopback, fc00::/7, fe80::/10) → 403; more than 20 failed decryptions from one
address within 60 s → 429 for the next 60 s.

Messages (plaintext JSON; `t` = sender's time in ms, `from` = sender's device id):

| Request | Reply |
|---|---|
| `{"op":"hello","t":..,"from":"..","nonce":"<random>"}` | `{"ok":true,"nonce":"<same>","name":"<PC name>","rev":"<rev>"}` |
| `{"op":"peek","t":..,"from":".."}` | `{"ok":true,"rev":"<rev of the PC's data now>"}` |
| `{"op":"sync","t":..,"from":"..","rev":"<phone rev>","doc":{..}}` | `{"ok":true,"rev":"<merged rev>","doc":{..merged..}}` |

`hello` proves the server holds the secret (the phone checks that the nonce comes back), so the phone can search the
network without trusting whoever answers. The phone remembers the address that worked. If it stops working it tries the
addresses from the QR, then sweeps the same /24 (`x.y.z.1`–`254`, 32 at a time, 700 ms each) with `hello`.
The phone polls `peek` every 5 s while the app is open and visible. When `rev` differs from its own, or it has local changes,
it sends `sync`. After a successful `sync` both sides hold the merged data.

The page merges (it owns the data). The main process only decrypts, checks, and hands `sync` to the page; for `peek` and
`hello` it answers from the last `publish` (below), so a phone polling every 5 s never wakes the page.

## Internet relay protocol

A tiny Cloudflare Worker (`relay/worker.js`) the user deploys to their own free account. It stores one encrypted blob per room.
It never sees the key, the data, or the planner.

* `GET /v1/health` → `{"ok":true,"app":"study-desk-relay"}`
* `GET /v1/room/<room>` + `Authorization: Bearer <token>` → 200 `{"rev":"<n>","body":"<string>"}` | 404 (no data yet) | 401
* `PUT /v1/room/<room>` + `Authorization: Bearer <token>`, JSON `{"body":"<string>","prev":"<n>"}` → 200 `{"rev":"<n+1>"}` | 409 `{"rev":".."}` (prev given and stale) | 401 | 413
* `DELETE /v1/room/<room>` + bearer → 204 (used by "Forget this connection")
* `room` must match `^[0-9a-f]{32}$`; the first PUT stores SHA-256 of the token; later requests must present the same token.
  Body at most 2 MB; a room expires 90 days after its last PUT. Responses carry `cache-control: no-store`. No cookies, no logs of bodies.
* `body` = a string holding the envelope of `{"rev":"<rev>","doc":{..}}`.

A device runs one **cycle** every 20 s and right after each local change: GET the room; if there is a body and its rev differs
from the device's own rev → decrypt, merge with the local data, apply; if the merged rev differs from the remote rev → PUT the
merge (`prev` = the rev we read). A 409 means someone wrote in between: run the cycle again. Because every writer
merges before writing, no change is lost; at worst one extra cycle repairs a race.
Free-tier limits (Cloudflare Workers KV) are about 1,000 writes and 100,000 reads a day, far more than two devices need.

## Where each part lives

| Part | Place |
|---|---|
| Sync document, merge, rev, stamps, envelope (WebCrypto), pairing code, phone engine, dialog | page (`planner/p13*`, built into `app/index.html`) |
| QR drawing and QR reading | `qrcode-generator` (MIT) and `jsQR` (Apache-2.0), inlined in the page |
| Server, relay client, Node-side crypto, IPC | `desktop/sync/`, `desktop/main.js`, `desktop/preload.js` (`window.studyDesk.sync`) |
| Phone network calls | `Capacitor.Plugins.CapacitorHttp` (native, so the page's own network rules are not loosened) |
| Relay | `relay/` |

The Android app asks for the camera (only to read the QR code; pasting the code works without it) and allows plain-HTTP traffic (`usesCleartextTraffic`, needed to reach `http://192.168.x.x`). That is safe here because every body is
AES-GCM encrypted and authenticated; it is used only through the native HTTP call, never by the page's own requests.

## Known limits (honest list)

* Both apps must be open for Wi-Fi sync; the PC program must be running. The phone checks every 5 seconds while its screen is on and the app is in front (every 20 seconds through the relay).
* The phone looks for the PC at its last address, at the addresses in the code (and the next 9 ports), then on the rest of the same /24 network. If the router puts the devices on different networks, or isolates Wi-Fi clients (school and guest networks), Wi-Fi mode cannot work: use the relay.
* If the Android app is ever built for Android 17 (`targetSdkVersion` 37) it must declare and request the `ACCESS_LOCAL_NETWORK` permission, or local traffic is blocked. At the current target (36) it is not needed.
* Newest change wins by device clocks; a deleted item is forgotten after 90 days (a device that was offline longer can bring it back).
* The AI courses are merged whole: if two devices change the same course, the newer one replaces the other.
* Anyone who has the pairing code can read and change the planner; "Forget this connection" invalidates it.
* The relay only sees encrypted blobs, the room name (derived from the secret), IP addresses of the devices (Cloudflare logs), and sizes and times.
