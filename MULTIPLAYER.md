# Multiplayer drawing deployment

The drawing lives at **https://bhavyamittal.com/play**. Vercel redirects `/play.html` to `/play` and internally rewrites `/play` to the supplied page. The homepage remains unchanged.

## One-time Vercel setup

1. In Vercel, open the portfolio project and select **Storage** or **Integrations**.
2. Add and connect **Upstash Redis** to this Vercel project.
3. Confirm the Production environment has `REDIS_URL`. The websocket relay uses it to share drawing strokes and online presence across Vercel Function instances.
4. Redeploy the project after connecting Redis.

Undo removes the current user's most recent stroke. Clear removes only that user's strokes. Other participants' marks remain on the shared canvas.

The GitHub repository contains `api/draw.js` (Vercel WebSocket endpoint), `lib/crayon.js` (shared board, per-user stroke ownership, presence, Redis relay), `package.json` (runtime dependencies), `play.html` (the supplied page with multiplayer enabled), and the `/play` routes in `vercel.json`.

Without `REDIS_URL`, the function falls back to per-instance memory; participants connected to different instances will not share a board. Drawing state is retained in Redis, and online presence expires after 40 seconds without a heartbeat.
