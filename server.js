'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 500;
const rooms = new Map();
const MAX_MESSAGE_BYTES = 262144;
const MAX_WORLD_STATE_BYTES = 240000;
const MAX_VOICE_SIGNAL_BYTES = 16000;
const clients = new Map();
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    const body = JSON.stringify({ ok: true, service: 'Harvest Valley room relay', rooms: rooms.size });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
    res.end(body);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end('Harvest Valley room relay is running.');
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });

function send(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}
function code() {
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}
function newRoomCode() {
  for (let i = 0; i < 100; i++) {
    const value = code();
    if (!rooms.has(value)) return value;
  }
  throw new Error('No hay códigos de sala disponibles.');
}
function safeName(value) {
  return String(value || 'Granjero').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 16) || 'Granjero';
}
function fail(ws, message) { send(ws, { type: 'error', message }); }
function validClock(dayValue, timeValue) {
  const day = Number(dayValue), dayTime = Number(timeValue);
  return Number.isSafeInteger(day) && day >= 1 && day <= 1000000000 && Number.isFinite(dayTime) && dayTime >= 0 && dayTime < 1 ? { day, dayTime } : null;
}
function removeClient(ws) {
  const client = clients.get(ws);
  if (!client) return;
  clients.delete(ws);
  const room = rooms.get(client.room);
  if (!room) return;
  room.players.delete(ws);
  if (client.role === 'host') {
    for (const peer of room.players.keys()) {
      send(peer, { type: 'error', message: 'El anfitrión cerró la sala.' });
      try { peer.close(4001, 'host left'); } catch (_) {}
      clients.delete(peer);
    }
    rooms.delete(client.room);
    return;
  }
  for (const peer of room.players.keys()) send(peer, { type: 'player-left', playerId: client.playerId });
  if (room.players.size === 0) rooms.delete(client.room);
}
function handleHost(ws, message) {
  if (clients.has(ws)) return fail(ws, 'Esta conexión ya está asociada a una sala.');
  if (rooms.size >= MAX_ROOMS) return fail(ws, 'El servidor está lleno por ahora.');
  const roomCode = newRoomCode();
  const player = {
    id: crypto.randomBytes(6).toString('hex'),
    name: safeName(message.name),
    role: 'host',
    lastState: null,
    lastStateAt: 0,
    ws
  };
  const seed = Number(message.seed);
  const room = {
    code: roomCode,
    seed: Number.isSafeInteger(seed) && seed > 0 ? seed : 777,
    worldName: safeName(message.worldName || 'Harvest Valley'),
    host: player,
    clock: validClock(message.day, message.dayTime) || { day: 1, dayTime: 0.3 },
    worldState: null,
    worldStateAt: 0,
    players: new Map([[ws, player]])
  };
  rooms.set(roomCode, room);
  clients.set(ws, { room: roomCode, playerId: player.id, name: player.name, role: 'host' });
  send(ws, { type: 'room-created', room: roomCode, playerId: player.id, role: 'host', seed: room.seed, worldName: room.worldName, clock: room.clock });
}
function handleJoin(ws, message) {
  if (clients.has(ws)) return fail(ws, 'Esta conexión ya está asociada a una sala.');
  const roomCode = String(message.room || '').trim().toUpperCase();
  const room = rooms.get(roomCode);
  if (!room) return fail(ws, 'No encontré esa sala. Revisa el código o pide al anfitrión que la cree de nuevo.');
  if (room.players.size >= 2) return fail(ws, 'La sala ya tiene dos jugadores.');
  const player = {
    id: crypto.randomBytes(6).toString('hex'),
    name: safeName(message.name),
    role: 'guest',
    lastState: null,
    lastStateAt: 0,
    ws
  };
  room.players.set(ws, player);
  clients.set(ws, { room: roomCode, playerId: player.id, name: player.name, role: 'guest' });
  send(ws, { type: 'room-joined', room: roomCode, playerId: player.id, role: 'guest', seed: room.seed, worldName: room.worldName, hostName: room.host.name, hostState: room.host.lastState, clock: room.clock, worldState: room.worldState });
  send(room.host.ws, { type: 'player-joined', playerId: player.id, name: player.name });
  if (room.host.lastState) send(ws, { type: 'player-state', ...room.host.lastState, playerId: room.host.id, name: room.host.name });
  if (room.worldState) send(ws, { type: 'world-state', state: room.worldState });
}
function relayState(ws, message) {
  const client = clients.get(ws);
  if (!client) return;
  const room = rooms.get(client.room);
  const player = room && room.players.get(ws);
  if (!player) return;
  const now = Date.now();
  if (now - player.lastStateAt < 45) return;
  const x = Number(message.x), y = Number(message.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 3200 || y < -3408 || y > 4600) return;
  const cosmetics = new Set(['', 'strawHat', 'witchHat', 'pumpkinMask', 'purpleHat']);
  const state = {
    x, y,
    dir: ['left', 'right', 'up', 'down'].includes(message.dir) ? message.dir : 'down',
    walking: message.walking === true,
    hidden: message.hidden === true,
    role: client.role,
    cosmeticId: cosmetics.has(message.cosmeticId) ? message.cosmeticId : '',
    ironHelmet: message.ironHelmet === true,
    ironChestplate: message.ironChestplate === true,
    ironBoots: message.ironBoots === true
  };
  if (client.role === 'host') {
    const nextClock = validClock(message.day, message.dayTime);
    if (nextClock) room.clock = nextClock;
  }
  // The host alone advances room time; both players receive the same authoritative clock.
  if (room.clock) Object.assign(state, room.clock);
  player.lastState = state;
  player.lastStateAt = now;
  for (const [peer] of room.players) {
    if (peer !== ws) send(peer, { type: 'player-state', ...state, playerId: player.id, name: player.name });
  }
  if (client.role === 'host' && room.clock) {
    for (const [peer] of room.players) send(peer, { type: 'room-clock', ...room.clock });
  }
}
function relayWorldState(ws, message) {
  const client = clients.get(ws);
  if (!client || client.role !== 'host') return;
  const room = rooms.get(client.room);
  if (!room || !message.state || typeof message.state !== 'object' || Array.isArray(message.state)) return;
  const now = Date.now();
  if (now - (room.worldStateAt || 0) < 220) return;
  let encoded;
  try { encoded = JSON.stringify(message.state); } catch (_) { return fail(ws, 'El estado del mundo no se pudo serializar.'); }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_WORLD_STATE_BYTES) return fail(ws, 'El estado compartido superó el límite permitido.');
  try { room.worldState = JSON.parse(encoded); } catch (_) { return fail(ws, 'El estado compartido no es válido.'); }
  room.worldStateAt = now;
  for (const [peer, player] of room.players) if (peer !== ws && player.role === 'guest') send(peer, { type: 'world-state', state: room.worldState });
}
function relayWorldAction(ws, message) {
  const client = clients.get(ws);
  if (!client || client.role !== 'guest') return;
  const room = rooms.get(client.room);
  if (!room || !room.host || !room.host.ws) return;
  const action = String(message.action || '');
  const allowed = new Set(['collect-loot','pick-berry','collect-animal','harvest-crop','plant-crop','cut-tree','add-animal']);
  if (!allowed.has(action)) return;
  const now = Date.now();
  if (now - (client.lastWorldActionAt || 0) < 80) return;
  client.lastWorldActionAt = now;
  const payload = { type: 'world-action', action, playerId: client.playerId, name: client.name };
  if (['collect-loot','pick-berry','collect-animal','harvest-crop'].includes(action)) {
    const entityId = String(message.entityId || '').slice(0, 80);
    if (!entityId) return;
    payload.entityId = entityId;
  } else {
    const x = Number(message.x), y = Number(message.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 3200 || y < -3408 || y > 4600) return;
    payload.x = x; payload.y = y;
    if (action === 'plant-crop') {
      if (!['strawberry','carrot','grape','rose'].includes(message.cropType)) return;
      payload.cropType = message.cropType;
    }
    if (action === 'add-animal') {
      if (!['cow','chicken'].includes(message.animalType)) return;
      payload.animalType = message.animalType;
    }
  }
  send(room.host.ws, payload);
}

function relayVoiceSignal(ws, message) {
  const client = clients.get(ws);
  if (!client) return;
  const room = rooms.get(client.room);
  if (!room) return;
  const signal = message.signal;
  if (!signal || typeof signal !== 'object' || Array.isArray(signal)) return;
  const allowed = new Set(['ready','offer','answer','candidate','hangup']);
  if (!allowed.has(String(signal.type || ''))) return;
  const now = Date.now();
  if (signal.type === 'candidate' && now - (client.lastVoiceSignalAt || 0) < 10) return;
  if (signal.type === 'candidate') client.lastVoiceSignalAt = now;
  let encoded;
  try { encoded = JSON.stringify(signal); } catch (_) { return fail(ws, 'La señal de voz no es válida.'); }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_VOICE_SIGNAL_BYTES) return fail(ws, 'La señal de voz es demasiado grande.');
  let clean;
  try { clean = JSON.parse(encoded); } catch (_) { return fail(ws, 'La señal de voz no es válida.'); }
  for (const [peer] of room.players) if (peer !== ws) send(peer, { type: 'voice-signal', role: client.role, signal: clean });
}

function relayAction(ws, message) {
  const client = clients.get(ws);
  if (!client) return;
  const room = rooms.get(client.room);
  if (!room) return;
  const action = message.action === 'B' ? 'B' : message.action === 'A' ? 'A' : '';
  if (!action) return;
  for (const [peer] of room.players) {
    if (peer !== ws) send(peer, { type: 'player-action', playerId: client.playerId, name: client.name, action });
  }
}

wss.on('connection', ws => {
  ws.on('message', (raw, isBinary) => {
    if (isBinary || raw.length > MAX_MESSAGE_BYTES) return fail(ws, 'Mensaje demasiado grande.');
    let message;
    try { message = JSON.parse(raw.toString()); } catch (_) { return fail(ws, 'Mensaje no válido.'); }
    if (!message || typeof message !== 'object') return fail(ws, 'Mensaje no válido.');
    if (message.type === 'host') return handleHost(ws, message);
    if (message.type === 'join') return handleJoin(ws, message);
    if (message.type === 'state') return relayState(ws, message);
    if (message.type === 'world-state') return relayWorldState(ws, message);
    if (message.type === 'world-action') return relayWorldAction(ws, message);
    if (message.type === 'voice-signal') return relayVoiceSignal(ws, message);
    if (message.type === 'action') return relayAction(ws, message);
    if (message.type === 'leave') { try { ws.close(); } catch (_) {} return; }
    fail(ws, 'Tipo de mensaje no reconocido.');
  });
  ws.on('close', () => removeClient(ws));
  ws.on('error', () => removeClient(ws));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Harvest Valley room relay listening on port ${PORT}`);
});

function shutdown() {
  for (const ws of wss.clients) { try { ws.close(1001, 'server shutdown'); } catch (_) {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
