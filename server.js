'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 500;
const rooms = new Map();
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

const wss = new WebSocketServer({ server, maxPayload: 4096, perMessageDeflate: false });

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
    players: new Map([[ws, player]])
  };
  rooms.set(roomCode, room);
  clients.set(ws, { room: roomCode, playerId: player.id, name: player.name, role: 'host' });
  send(ws, { type: 'room-created', room: roomCode, playerId: player.id, role: 'host', seed: room.seed, worldName: room.worldName });
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
  send(ws, { type: 'room-joined', room: roomCode, playerId: player.id, role: 'guest', seed: room.seed, worldName: room.worldName, hostName: room.host.name, hostState: room.host.lastState });
  send(room.host.ws, { type: 'player-joined', playerId: player.id, name: player.name });
  if (room.host.lastState) send(ws, { type: 'player-state', ...room.host.lastState, playerId: room.host.id, name: room.host.name });
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
  const state = {
    x, y,
    dir: ['left', 'right', 'up', 'down'].includes(message.dir) ? message.dir : 'down',
    walking: !!message.walking,
    hidden: !!message.hidden
  };
  player.lastState = state;
  player.lastStateAt = now;
  for (const [peer, other] of room.players) {
    if (peer !== ws) send(peer, { type: 'player-state', ...state, playerId: player.id, name: player.name });
  }
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
    if (isBinary || raw.length > 4096) return fail(ws, 'Mensaje demasiado grande.');
    let message;
    try { message = JSON.parse(raw.toString()); } catch (_) { return fail(ws, 'Mensaje no válido.'); }
    if (!message || typeof message !== 'object') return fail(ws, 'Mensaje no válido.');
    if (message.type === 'host') return handleHost(ws, message);
    if (message.type === 'join') return handleJoin(ws, message);
    if (message.type === 'state') return relayState(ws, message);
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
