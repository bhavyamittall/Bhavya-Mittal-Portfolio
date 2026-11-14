import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';

const globalHub = globalThis;
const hub = globalHub.__crayonHub || (globalHub.__crayonHub = {
  instanceId: randomUUID(), sockets: new Map(), subscriber: null,
  strokes: [], peers: new Set(), presenceTimer: null,
});
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null, enableReadyCheck: true,
}) : null;
const EVENTS = 'crayon:v1:events';
const ORDER = 'crayon:v1:order';
const STROKES = 'crayon:v1:strokes';
const ONLINE = 'crayon:v1:online';
const PRESENCE_TTL_MS = 40_000;
const MAX_STROKES = 5000;
const OPEN = 1;

function send(ws, data) {
  if (ws.readyState === OPEN) {
    try { ws.send(JSON.stringify(data)); } catch (_) {}
  }
}
function visiblePeers(id, everyone) {
  return everyone.filter((peer) => peer !== id).slice(0, 3);
}
function broadcast(data, except) {
  for (const ws of hub.sockets.keys()) if (ws !== except) send(ws, data);
}
function broadcastPeers(peers) {
  for (const [ws, client] of hub.sockets) send(ws, { type: 'peers', peers: visiblePeers(client.id, peers) });
}
async function publish(data, except) {
  if (data.type === 'peers') broadcastPeers(data.peers);
  else broadcast(data, except);
  if (!redis) return;
  try { await redis.publish(EVENTS, JSON.stringify({ origin: hub.instanceId, data })); }
  catch (error) { console.error('[crayon] event publish failed', error); }
}
async function announcePeers() {
  let peers = [...hub.peers];
  if (redis) {
    try {
      peers = await getOnlinePeers();
      hub.peers = new Set(peers);
    } catch (error) { console.error('[crayon] presence lookup failed', error); }
  }
  await publish({ type: 'peers', peers });
}
async function startSubscriber() {
  if (!redis || hub.subscriber) return;
  const sub = redis.duplicate();
  hub.subscriber = sub;
  await sub.subscribe(EVENTS);
  sub.on('message', (_channel, raw) => {
    try {
      const event = JSON.parse(raw);
      if (event.origin !== hub.instanceId) {
        if (event.data.type === 'peers') broadcastPeers(event.data.peers);
        else broadcast(event.data);
      }
    } catch (_) {}
  });
}

export function registerCanvasSocket(ws) {
  hub.sockets.set(ws, { id: null });
  if (!hub.presenceTimer) hub.presenceTimer = setInterval(() => void refreshPresence(), 12_000);
  void startSubscriber().catch((error) => console.error('[crayon] Redis subscription failed', error));
}

export async function joinCanvas(ws, id) {
  const client = hub.sockets.get(ws);
  if (!client) return;
  client.id = String(id || randomUUID()).slice(0, 80);
  if (redis) {
    try { await redis.zadd(ONLINE, Date.now(), client.id); }
    catch (error) { console.error('[crayon] presence add failed', error); }
  } else hub.peers.add(client.id);
  let strokes = hub.strokes;
  let peers = [...hub.peers];
  if (redis) {
    try {
      const ids = await redis.lrange(ORDER, 0, -1);
      const values = ids.length ? await redis.hmget(STROKES, ...ids) : [];
      strokes = ids.map((id, i) => { try { return JSON.parse(values[i]); } catch (_) { return null; } }).filter(Boolean);
      peers = await getOnlinePeers();
      hub.peers = new Set(peers);
    } catch (error) { console.error('[crayon] state load failed', error); }
  }
  send(ws, { type: 'state', strokes, peers: visiblePeers(client.id, peers) });
  await publish({ type: 'peers', peers });
}

export async function handleCanvasMessage(ws, msg) {
  const client = hub.sockets.get(ws);
  if (!client?.id) return;
  if (msg.type === 'begin' && msg.stroke && typeof msg.stroke.id === 'string' && Array.isArray(msg.stroke.points) && /^#[0-9a-f]{6}$/i.test(msg.stroke.color || '')) {
    const stroke = { id: msg.stroke.id.slice(0, 140), color: msg.stroke.color, width: Math.max(2, Math.min(48, Number(msg.stroke.width) || 19)), points: msg.stroke.points.slice(0, 1).map(point) };
    if (redis) {
      try {
        const tx = redis.multi();
        tx.hset(STROKES, stroke.id, JSON.stringify(stroke));
        tx.rpush(ORDER, stroke.id);
        tx.ltrim(ORDER, -MAX_STROKES, -1);
        await tx.exec();
        const ids = await redis.lrange(ORDER, 0, -1);
        const keep = new Set(ids);
        const all = await redis.hkeys(STROKES);
        const stale = all.filter((key) => !keep.has(key));
        if (stale.length) await redis.hdel(STROKES, ...stale);
      } catch (error) { console.error('[crayon] stroke save failed', error); }
    } else { hub.strokes.push(stroke); if (hub.strokes.length > MAX_STROKES) hub.strokes.shift(); }
    await publish({ type: 'begin', stroke }, ws);
  } else if (msg.type === 'points' && typeof msg.id === 'string' && Array.isArray(msg.points)) {
    const points = msg.points.slice(0, 80).map(point);
    if (!points.length) return;
    if (redis) {
      try {
        const raw = await redis.hget(STROKES, msg.id);
        if (raw) { const stroke = JSON.parse(raw); stroke.points.push(...points); await redis.hset(STROKES, msg.id, JSON.stringify(stroke)); }
      } catch (error) { console.error('[crayon] point save failed', error); }
    } else {
      const stroke = hub.strokes.find((item) => item.id === msg.id);
      if (stroke) stroke.points.push(...points);
    }
    await publish({ type: 'points', id: msg.id, points }, ws);
  } else if (msg.type === 'undo') {
    let id;
    if (redis) {
      try { id = await redis.rpop(ORDER); if (id) await redis.hdel(STROKES, id); }
      catch (error) { console.error('[crayon] undo failed', error); }
    } else { const stroke = hub.strokes.pop(); id = stroke?.id; }
    if (id) await publish({ type: 'undo', id });
  } else if (msg.type === 'clear') {
    if (redis) {
      try { await redis.del(ORDER, STROKES); }
      catch (error) { console.error('[crayon] clear failed', error); }
    } else hub.strokes = [];
    await publish({ type: 'clear' });
  }
}

export async function unregisterCanvasSocket(ws) {
  const client = hub.sockets.get(ws);
  hub.sockets.delete(ws);
  if (!client?.id) return;
  if (redis) {
    try { await redis.zrem(ONLINE, client.id); }
    catch (error) { console.error('[crayon] presence remove failed', error); }
  } else hub.peers.delete(client.id);
  await announcePeers();
  if (hub.sockets.size === 0 && hub.presenceTimer) { clearInterval(hub.presenceTimer); hub.presenceTimer = null; }
}

async function refreshPresence() {
  if (!redis) return;
  const now = Date.now();
  try {
    for (const client of hub.sockets.values()) if (client.id) await redis.zadd(ONLINE, now, client.id);
    await redis.zremrangebyscore(ONLINE, '-inf', now - PRESENCE_TTL_MS);
  } catch (error) { console.error('[crayon] presence refresh failed', error); }
}
async function getOnlinePeers() {
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  await redis.zremrangebyscore(ONLINE, '-inf', cutoff);
  return redis.zrange(ONLINE, 0, -1);
}

function point(p) {
  return { x: clamp(p?.x), y: clamp(p?.y) };
}
function clamp(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

