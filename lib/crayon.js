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
const PRESENCE_SWEEP_MS = 2_000;
const MAX_SHARED_USERS = 10;
const MAX_STROKES = 5000;
const MAX_STROKES_PER_SESSION = 300;
const MAX_POINTS_PER_STROKE = 2_000;
const MAX_POINTS_PER_SESSION = 5_000;
const OPEN = 1;

function send(ws, data) {
  if (ws.readyState === OPEN) {
    try { ws.send(JSON.stringify(data)); } catch (_) {}
  }
}
function broadcast(data, except) {
  for (const ws of hub.sockets.keys()) if (ws !== except) send(ws, data);
}
function broadcastAudience(ids, data) {
  const audience = new Set(ids || []);
  if (!audience.size) return;
  for (const [ws, client] of hub.sockets) if (audience.has(client.id)) send(ws, data);
}
function applyAssignments(assignments) {
  for (const [ws, client] of hub.sockets) {
    if (!client.id || client.solo) continue;
    client.partnerId = assignments[client.id] || null;
    send(ws, { type: 'visibility', partnerId: client.partnerId, solo: false });
  }
}
async function sendLocalPairStates(assignments) {
  let strokes = hub.strokes;
  if (redis) {
    try {
      const ids = await redis.lrange(ORDER, 0, -1);
      const values = ids.length ? await redis.hmget(STROKES, ...ids) : [];
      strokes = ids.map((id, i) => { try { return JSON.parse(values[i]); } catch (_) { return null; } }).filter(Boolean);
    } catch (error) { console.error('[crayon] pair state load failed', error); }
  }
  for (const [ws, client] of hub.sockets) {
    if (!client.id || client.solo) continue;
    const partnerId = assignments[client.id] || null;
    client.partnerId = partnerId;
    const visible = strokes.filter((stroke) => stroke.owner === client.id || stroke.owner === partnerId);
    send(ws, { type: 'state', strokes: visible, peers: partnerId ? [partnerId] : [], partnerId, solo: false });
  }
}
async function sharedIds() {
  if (redis) return redis.zrange(ONLINE, 0, MAX_SHARED_USERS - 1);
  return [...hub.sockets.values()].filter((client) => client.id && !client.solo).map((client) => client.id);
}
async function updateAssignments() {
  const ids = await sharedIds();
  const assignments = {};
  for (let i = 0; i + 1 < ids.length; i += 2) {
    assignments[ids[i]] = ids[i + 1];
    assignments[ids[i + 1]] = ids[i];
  }
  applyAssignments(assignments);
  await sendLocalPairStates(assignments);
  if (redis) {
    try { await redis.publish(EVENTS, JSON.stringify({ origin: hub.instanceId, data: { type: 'assignments', assignments } })); }
    catch (error) { console.error('[crayon] assignment publish failed', error); }
  }
  return assignments;
}
async function publish(data, except) {
  if (data.audience) broadcastAudience(data.audience, data);
  else broadcast(data, except);
  if (!redis) return;
  try { await redis.publish(EVENTS, JSON.stringify({ origin: hub.instanceId, data, audience: data.audience || null })); }
  catch (error) { console.error('[crayon] event publish failed', error); }
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
        if (event.data.type === 'assignments') {
          applyAssignments(event.data.assignments || {});
          void sendLocalPairStates(event.data.assignments || {});
        }
        else if (event.audience) broadcastAudience(event.audience, event.data);
        else broadcast(event.data);
      }
    } catch (_) {}
  });
}

export function registerCanvasSocket(ws) {
  hub.sockets.set(ws, { id: null });
  if (!hub.presenceTimer) hub.presenceTimer = setInterval(() => void refreshPresence(), PRESENCE_SWEEP_MS);
  void startSubscriber().catch((error) => console.error('[crayon] Redis subscription failed', error));
}

export async function joinCanvas(ws, id, sharedOptIn = false) {
  const client = hub.sockets.get(ws);
  if (!client) return;
  await refreshPresence();
  client.id = String(id || randomUUID()).slice(0, 80);
  client.lastSeen = Date.now();
  if (sharedOptIn !== true) {
    client.solo = true;
    send(ws, { type: 'state', strokes: [], peers: [], partnerId: null, solo: true, reason: 'private' });
    try { ws.close(); } catch (_) {}
    return;
  }
  let slot = -1;
  if (redis) {
    try {
      slot = await redis.eval(`
        local rank = redis.call('ZRANK', KEYS[1], ARGV[1])
        if rank then return rank end
        if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return -1 end
        redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
        return redis.call('ZRANK', KEYS[1], ARGV[1])
      `, 1, ONLINE, client.id, client.lastSeen, MAX_SHARED_USERS);
    }
    catch (error) { console.error('[crayon] presence add failed', error); }
  } else {
    slot = [...hub.sockets.values()].filter((peer) => peer !== client && peer.id && !peer.solo).length;
    if (slot < MAX_SHARED_USERS) hub.peers.add(client.id);
  }
  client.solo = slot < 0 || slot >= MAX_SHARED_USERS;
  if (client.solo) {
    send(ws, { type: 'state', strokes: [], peers: [], partnerId: null, solo: true, reason: 'full' });
    try { ws.close(); } catch (_) {}
    return;
  }
  await updateAssignments();
  const partnerId = client.partnerId;
  let strokes = hub.strokes;
  if (redis) {
    try {
      const ids = await redis.lrange(ORDER, 0, -1);
      const values = ids.length ? await redis.hmget(STROKES, ...ids) : [];
      strokes = ids.map((id, i) => { try { return JSON.parse(values[i]); } catch (_) { return null; } })
        .filter((stroke) => stroke && (stroke.owner === client.id || stroke.owner === partnerId));
    } catch (error) { console.error('[crayon] state load failed', error); }
  } else {
    strokes = hub.strokes.filter((stroke) => stroke.owner === client.id || stroke.owner === partnerId);
  }
  const ownStrokes = strokes.filter((stroke) => stroke.owner === client.id);
  client.ownPointCounts = new Map(ownStrokes.map((stroke) => [stroke.id, stroke.points?.length || 0]));
  client.strokeCount = client.ownPointCounts.size;
  client.pointCount = [...client.ownPointCounts.values()].reduce((total, count) => total + count, 0);
  send(ws, { type: 'state', strokes, peers: partnerId ? [partnerId] : [], partnerId, solo: false });
}

async function publishPartner(data, client, except) {
  const audience = client.partnerId ? [client.partnerId] : [];
  if (audience.length) await publish({ ...data, audience }, except);
}

export async function handleCanvasMessage(ws, msg) {
  const client = hub.sockets.get(ws);
  if (!client?.id) return;
  if (msg.type === 'heartbeat') {
    client.lastSeen = Date.now();
    if (redis && !client.solo) {
      try { await redis.zadd(ONLINE, client.lastSeen, client.id); }
      catch (error) { console.error('[crayon] heartbeat update failed', error); }
    }
    return;
  }
  if (client.solo) return;
  if (msg.type === 'begin' && msg.stroke && typeof msg.stroke.id === 'string' && Array.isArray(msg.stroke.points) && /^#[0-9a-f]{6}$/i.test(msg.stroke.color || '')) {
    const stroke = { id: msg.stroke.id.slice(0, 140), owner: client.id, color: msg.stroke.color, width: Math.max(2, Math.min(48, Number(msg.stroke.width) || 19)), points: msg.stroke.points.slice(0, 1).map(point) };
    if (client.strokeCount >= MAX_STROKES_PER_SESSION || client.pointCount >= MAX_POINTS_PER_SESSION) {
      send(ws, { type: 'limit', id: stroke.id }); return;
    }
    if (redis) {
      try {
        const inserted = await redis.eval(`
          if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 1 then return 0 end
          while redis.call('LLEN', KEYS[1]) >= tonumber(ARGV[4]) do
            local oldest = redis.call('LPOP', KEYS[1])
            redis.call('HDEL', KEYS[2], oldest)
          end
          redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
          redis.call('RPUSH', KEYS[1], ARGV[1])
          return 1
        `, 2, ORDER, STROKES, stroke.id, JSON.stringify(stroke), client.id, MAX_STROKES);
        if (!inserted) return;
      } catch (error) { console.error('[crayon] stroke save failed', error); return; }
    } else {
      if (hub.strokes.some((item) => item.id === stroke.id)) return;
      hub.strokes.push(stroke); if (hub.strokes.length > MAX_STROKES) hub.strokes.shift();
    }
    client.strokeCount++;
    client.pointCount++;
    client.ownPointCounts.set(stroke.id, 1);
    await publishPartner({ type: 'begin', stroke }, client, ws);
  } else if (msg.type === 'points' && typeof msg.id === 'string' && Array.isArray(msg.points)) {
    let points = msg.points.slice(0, 80).map(point);
    if (!points.length) return;
    const requestedPoints = points.length;
    if (redis) {
      try {
        const raw = await redis.hget(STROKES, msg.id);
        if (!raw) return;
        const stroke = JSON.parse(raw);
        if (stroke.owner !== client.id) return;
        const accepted = Math.max(0, Math.min(points.length, MAX_POINTS_PER_STROKE - stroke.points.length, MAX_POINTS_PER_SESSION - client.pointCount));
        if (!accepted) { send(ws, { type: 'limit', id: stroke.id, stroke }); return; }
        points = points.slice(0, accepted);
        stroke.points.push(...points);
        await redis.hset(STROKES, msg.id, JSON.stringify(stroke));
        if (accepted < requestedPoints) send(ws, { type: 'limit', id: stroke.id, stroke });
      } catch (error) { console.error('[crayon] point save failed', error); return; }
    } else {
      const stroke = hub.strokes.find((item) => item.id === msg.id);
      if (stroke?.owner !== client.id) return;
      const accepted = Math.max(0, Math.min(points.length, MAX_POINTS_PER_STROKE - stroke.points.length, MAX_POINTS_PER_SESSION - client.pointCount));
      if (!accepted) { send(ws, { type: 'limit', id: stroke.id, stroke }); return; }
      points = points.slice(0, accepted);
      stroke.points.push(...points);
      if (accepted < requestedPoints) send(ws, { type: 'limit', id: stroke.id, stroke });
    }
    client.pointCount += points.length;
    client.ownPointCounts.set(msg.id, (client.ownPointCounts.get(msg.id) || 0) + points.length);
    await publishPartner({ type: 'points', id: msg.id, points }, client, ws);
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
    if (id) {
      client.pointCount = Math.max(0, client.pointCount - (client.ownPointCounts.get(id) || 0));
      client.strokeCount = Math.max(0, client.strokeCount - 1);
      client.ownPointCounts.delete(id);
    }
    if (id) await publishPartner({ type: 'undo', id }, client, ws);
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
    if (ids.length) {
      client.pointCount = 0;
      client.strokeCount = 0;
      client.ownPointCounts.clear();
    }
    if (ids.length) await publishPartner({ type: 'remove', ids }, client, ws);
  }
}

export async function unregisterCanvasSocket(ws) {
  const client = hub.sockets.get(ws);
  hub.sockets.delete(ws);
  if (!client?.id) return;
  const sameSessionConnected = [...hub.sockets.values()].some((peer) => peer.id === client.id);
  if (!sameSessionConnected) {
    await removeOwnerStrokes(client.id, client.partnerId ? [client.partnerId] : []);
    if (redis) {
      try { await redis.zrem(ONLINE, client.id); }
      catch (error) { console.error('[crayon] presence remove failed', error); }
    } else hub.peers.delete(client.id);
  }
  await updateAssignments();
  if (hub.sockets.size === 0 && hub.presenceTimer) { clearInterval(hub.presenceTimer); hub.presenceTimer = null; }
}

async function removeOwnerStrokes(owner, audience = []) {
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
      `, 2, ORDER, STROKES, owner);
    } catch (error) { console.error('[crayon] drawing removal failed', error); }
  } else {
    ids = hub.strokes.filter((stroke) => stroke.owner === owner).map((stroke) => stroke.id);
    if (!ids.length) return;
    const removed = new Set(ids);
    hub.strokes = hub.strokes.filter((stroke) => !removed.has(stroke.id));
  }
  if (ids.length && audience.length) await publish({ type: 'remove', ids, audience });
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
    const [result, expiredOwners] = await redis.eval(`
      local stale = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
      local removed = {}
      local expiredOwners = {}
      local all = redis.call('LRANGE', KEYS[2], 0, -1)
      for _, owner in ipairs(stale) do
        local seen = redis.call('ZSCORE', KEYS[1], owner)
        if seen and tonumber(seen) <= tonumber(ARGV[1]) then
          for i = #all, 1, -1 do
            local raw = redis.call('HGET', KEYS[3], all[i])
            if raw and cjson.decode(raw).owner == owner then
              redis.call('LREM', KEYS[2], 1, all[i])
              redis.call('HDEL', KEYS[3], all[i])
              table.insert(removed, all[i])
            end
          end
          redis.call('ZREM', KEYS[1], owner)
          table.insert(expiredOwners, owner)
        end
      end
      return {removed, expiredOwners}
    `, 3, ONLINE, ORDER, STROKES, now - PRESENCE_TTL_MS);
    if (expiredOwners.length) {
      for (const [ws, client] of hub.sockets) {
        if (expiredOwners.includes(client.id)) { try { ws.close(); } catch (_) {} }
      }
      await updateAssignments();
    }
  } catch (error) { console.error('[crayon] presence refresh failed', error); }
}
function point(p) {
  return { x: clamp(p?.x), y: clamp(p?.y) };
}
function clamp(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

