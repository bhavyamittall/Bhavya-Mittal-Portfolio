import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';

const globalHub = globalThis;
const hub = globalHub.__crayonHub || (globalHub.__crayonHub = {
  instanceId: randomUUID(), sockets: new Map(), subscriber: null,
  strokes: [], peers: new Set(), presenceTimer: null, expiryTimers: new Map(),
});
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null, enableReadyCheck: true,
}) : null;
const EVENTS = 'crayon:v1:events';
const ORDER = 'crayon:v1:order';
const STROKES = 'crayon:v1:strokes';
const ONLINE = 'crayon:v1:online';
const DEPARTED = 'crayon:v1:departed';
const PRESENCE_TTL_MS = 40_000;
const DRAWING_EXPIRY_MS = 135_000;
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
  await refreshPresence();
  client.id = String(id || randomUUID()).slice(0, 80);
  client.lastSeen = Date.now();
  clearTimeout(hub.expiryTimers.get(client.id));
  hub.expiryTimers.delete(client.id);
  if (redis) {
    try { await redis.zrem(DEPARTED, client.id); await redis.zadd(ONLINE, Date.now(), client.id); }
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
  if (msg.type === 'heartbeat') {
    client.lastSeen = Date.now();
    clearTimeout(hub.expiryTimers.get(client.id));
    hub.expiryTimers.delete(client.id);
    if (redis) {
      try { await redis.zrem(DEPARTED, client.id); await redis.zadd(ONLINE, client.lastSeen, client.id); }
      catch (error) { console.error('[crayon] heartbeat update failed', error); }
    }
    return;
  }
  if (msg.type === 'begin' && msg.stroke && typeof msg.stroke.id === 'string' && Array.isArray(msg.stroke.points) && /^#[0-9a-f]{6}$/i.test(msg.stroke.color || '')) {
    const stroke = { id: msg.stroke.id.slice(0, 140), owner: client.id, color: msg.stroke.color, width: Math.max(2, Math.min(48, Number(msg.stroke.width) || 19)), points: msg.stroke.points.slice(0, 1).map(point) };
    if (redis) {
      try {
        if (await redis.hexists(STROKES, stroke.id)) return;
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
    } else {
      if (hub.strokes.some((item) => item.id === stroke.id)) return;
      hub.strokes.push(stroke); if (hub.strokes.length > MAX_STROKES) hub.strokes.shift();
    }
    await publish({ type: 'begin', stroke }, ws);
  } else if (msg.type === 'points' && typeof msg.id === 'string' && Array.isArray(msg.points)) {
    const points = msg.points.slice(0, 80).map(point);
    if (!points.length) return;
    if (redis) {
      try {
        const raw = await redis.hget(STROKES, msg.id);
        if (raw) { const stroke = JSON.parse(raw); if (stroke.owner !== client.id) return; stroke.points.push(...points); await redis.hset(STROKES, msg.id, JSON.stringify(stroke)); }
      } catch (error) { console.error('[crayon] point save failed', error); }
    } else {
      const stroke = hub.strokes.find((item) => item.id === msg.id);
      if (stroke?.owner === client.id) stroke.points.push(...points);
    }
    await publish({ type: 'points', id: msg.id, points }, ws);
  } else if (msg.type === 'undo') {
    let id;
    if (redis) {
      try {
        id = await redis.eval(`
          local ids = redis.call('LRANGE', KEYS[1], 0, -1)
          for i = #ids, 1, -1 do
            local raw = redis.call('HGET', KEYS[2], ids[i])
            if raw and cjson.decode(raw).owner == ARGV[1] then
              redis.call('LREM', KEYS[1], 1, ids[i])
              redis.call('HDEL', KEYS[2], ids[i])
              return ids[i]
            end
          end
          return ''
        `, 2, ORDER, STROKES, client.id);
      }
      catch (error) { console.error('[crayon] undo failed', error); }
    } else {
      for (let i = hub.strokes.length - 1; i >= 0; i--) {
        if (hub.strokes[i].owner === client.id) { id = hub.strokes[i].id; hub.strokes.splice(i, 1); break; }
      }
    }
    if (id) await publish({ type: 'undo', id });
  } else if (msg.type === 'clear') {
    let ids = [];
    if (redis) {
      try {
        ids = await redis.eval(`
          local ids = redis.call('LRANGE', KEYS[1], 0, -1)
          local removed = {}
          for i = #ids, 1, -1 do
            local raw = redis.call('HGET', KEYS[2], ids[i])
            if raw and cjson.decode(raw).owner == ARGV[1] then
              redis.call('LREM', KEYS[1], 1, ids[i])
              redis.call('HDEL', KEYS[2], ids[i])
              table.insert(removed, ids[i])
            end
          end
          return removed
        `, 2, ORDER, STROKES, client.id);
      }
      catch (error) { console.error('[crayon] clear failed', error); }
    } else {
      ids = hub.strokes.filter((stroke) => stroke.owner === client.id).map((stroke) => stroke.id);
      hub.strokes = hub.strokes.filter((stroke) => stroke.owner !== client.id);
    }
    if (ids.length) await publish({ type: 'remove', ids });
  }
}

export async function unregisterCanvasSocket(ws) {
  const client = hub.sockets.get(ws);
  hub.sockets.delete(ws);
  if (!client?.id) return;
  if (redis) {
    try {
      await redis.zadd(DEPARTED, client.lastSeen + DRAWING_EXPIRY_MS, client.id);
    } catch (error) { console.error('[crayon] disconnect expiry schedule failed', error); }
  }
  clearTimeout(hub.expiryTimers.get(client.id));
  hub.expiryTimers.set(client.id, setTimeout(() => {
    hub.expiryTimers.delete(client.id);
    if (redis) void cleanupExpiredDrawings();
    else void removeOwnerStrokes(client.id);
  }, Math.max(0, client.lastSeen + DRAWING_EXPIRY_MS - Date.now())));
  if (redis) {
    try { await redis.zrem(ONLINE, client.id); }
    catch (error) { console.error('[crayon] presence remove failed', error); }
  } else hub.peers.delete(client.id);
  await announcePeers();
  if (hub.sockets.size === 0 && hub.presenceTimer) { clearInterval(hub.presenceTimer); hub.presenceTimer = null; }
}

export async function cleanupExpiredDrawings() {
  const now = Date.now();
  if (!redis) return;
  try {
    const ids = await redis.eval(`
      local owners = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', ARGV[1])
      local removed = {}
      local all = redis.call('LRANGE', KEYS[1], 0, -1)
      for _, owner in ipairs(owners) do
        for i = #all, 1, -1 do
          local raw = redis.call('HGET', KEYS[2], all[i])
          if raw and cjson.decode(raw).owner == owner then
            redis.call('LREM', KEYS[1], 1, all[i])
            redis.call('HDEL', KEYS[2], all[i])
            table.insert(removed, all[i])
          end
        end
        redis.call('ZREM', KEYS[3], owner)
      end
      return removed
    `, 3, ORDER, STROKES, DEPARTED, now);
    if (ids.length) await publish({ type: 'remove', ids });
  } catch (error) { console.error('[crayon] expired drawing cleanup failed', error); }
}

async function removeOwnerStrokes(owner) {
  const ids = hub.strokes.filter((stroke) => stroke.owner === owner).map((stroke) => stroke.id);
  if (!ids.length) return;
  const removed = new Set(ids);
  hub.strokes = hub.strokes.filter((stroke) => !removed.has(stroke.id));
  await publish({ type: 'remove', ids });
}

async function refreshPresence() {
  const now = Date.now();
  if (!redis) {
    for (const [ws, client] of hub.sockets) {
      if (client.id && now - client.lastSeen > PRESENCE_TTL_MS) {
        try { ws.close(); } catch (_) {}
        await unregisterCanvasSocket(ws);
      }
    }
    return;
  }
  try {
    const expired = await redis.eval(`
      local stale = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
      local removed = {}
      for _, id in ipairs(stale) do
        local seen = redis.call('ZSCORE', KEYS[1], id)
        if seen and tonumber(seen) <= tonumber(ARGV[1]) then
          redis.call('ZADD', KEYS[2], tonumber(seen) + tonumber(ARGV[2]), id)
          redis.call('ZREM', KEYS[1], id)
          table.insert(removed, id)
        end
      end
      return removed
    `, 2, ONLINE, DEPARTED, now - PRESENCE_TTL_MS, DRAWING_EXPIRY_MS);
    await cleanupExpiredDrawings();
    if (expired.length) await announcePeers();
  } catch (error) { console.error('[crayon] presence refresh failed', error); }
}
async function getOnlinePeers() {
  return redis.zrange(ONLINE, 0, -1);
}

function point(p) {
  return { x: clamp(p?.x), y: clamp(p?.y) };
}
function clamp(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

