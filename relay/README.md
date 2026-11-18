# Study Desk relay (optional, for syncing over the internet)

You only need this if you want your phone and PC to sync when they are **not on the same Wi-Fi** (for example the phone is on
mobile data). If both are on the same Wi-Fi, choose "Same Wi-Fi" in Study Desk and skip this page.

## What it is

A tiny program that runs on your own free Cloudflare account. It keeps one **encrypted** package of your planner and hands it
to your other device. It cannot read the package: the key only exists on your PC and your phone (it is in the QR code).
Nobody else, including us, ever sees your data. If you stop using it, delete it (last section) and nothing is left.

## Set it up (about 10 minutes, once)

You need a free account at cloudflare.com. No card is needed for the free plan.

### The no-coding way (dashboard)

1. In Cloudflare, open **Workers & Pages** → **Create** → **Create Worker**. Name it `study-desk-relay` and click **Deploy**.
2. Open **Storage & Databases** → **KV** → **Create a namespace**. Name it `study-desk-rooms`.
3. Go back to your Worker → **Edit code**. Delete what is there, paste the whole of `worker.js` from this folder, click **Deploy**.
4. Worker → **Settings** → **Bindings** → **Add** → **KV namespace**. Variable name must be exactly `ROOMS`. Choose `study-desk-rooms`. Save and deploy.
5. Your relay address is shown on the Worker page. It looks like `https://study-desk-relay.<your-subdomain>.workers.dev`.

### The command way

```
npm install -g wrangler
wrangler login
wrangler kv namespace create ROOMS     # prints an id; paste it into wrangler.toml
wrangler deploy
```

## Check that it works

Open `<your relay address>/v1/health` in a browser. You should see `{"ok":true,"app":"study-desk-relay"}`.

## Use it in Study Desk

On the PC: **Sync** → choose **Over the internet** (or **Both**) → paste your relay address → a QR code appears → scan it with
the phone. The address travels inside the QR code, so you only type it once.

## Limits (free plan)

About 1,000 writes and 100,000 reads a day. Two devices use a few hundred. Each room can hold 2 MB, and a room that nobody
writes to for 90 days is deleted automatically.

## Delete everything

In Study Desk press **Forget this connection** (it deletes your room from the relay). To remove the relay itself, delete the
Worker and the `study-desk-rooms` namespace in the Cloudflare dashboard.
