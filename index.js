const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const QRCode = require('qrcode');

const app = express();
const httpServer = createServer(app);

const allowedOrigins = (process.env.SITE_ORIGIN || '*')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, cb) {
    if (allowedOrigins.includes('*') || !origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  methods: ['GET', 'POST'],
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());

const io = new Server(httpServer, {
  cors: corsOptions,
  transports: ['websocket', 'polling'],
});

const rooms = new Map();
const sockets = new Map();
const disconnectTimers = new Map();
const DISCONNECT_GRACE_MS = 60_000;
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 10);

function normRoomCode(code) {
  return String(code || '').trim().toUpperCase();
}

function safeName(name, fallback = 'Player') {
  const n = String(name || '').trim().slice(0, 24);
  return n || fallback;
}

function getClientId(socket, data = {}) {
  const auth = socket.handshake?.auth || {};
  return String(data.gh_clientId || data.clientId || auth.gh_clientId || auth.clientId || socket.id);
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 4; i += 1) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function isHost(room, socket, data = {}) {
  const cid = getClientId(socket, data);
  return (room.hostClientId && cid === room.hostClientId) || room.hostSocketId === socket.id;
}

function getPlayer(room, socket, data = {}) {
  const cid = getClientId(socket, data);
  return room.players.find((p) => p.clientId === cid || p.socketId === socket.id);
}

function roomInfo(room) {
  return {
    code: room.code,
    roomCode: room.code,
    hostClientId: room.hostClientId,
    playerCount: room.players.length,
    players: room.players.map((p) => ({
      id: p.socketId,
      socketId: p.socketId,
      clientId: p.clientId,
      name: p.name,
      isHost: p.clientId === room.hostClientId,
      isReady: !!p.isReady,
      ready: !!p.isReady,
      connected: p.connected !== false,
      score: Number(p.score || 0),
    })),
    status: room.status,
    selectedGame: room.selectedGame || 'mafia',
    currentGame: room.selectedGame || 'mafia',
    devMode: !!room.devMode,
    createdAt: room.createdAt,
  };
}

function emitRoom(room) {
  const info = roomInfo(room);
  io.to(room.code).emit('room:update', info);
  io.to(room.code).emit('players:update', info);
  io.to(room.code).emit('room:state', info);
  io.to(room.code).emit('hub:state', { roomCode: room.code, currentGame: info.currentGame, selectedGame: info.selectedGame, scores: info.players });
}

function cleanupRoomIfEmpty(code) {
  const room = rooms.get(code);
  if (room && room.players.length === 0) rooms.delete(code);
}

function findRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    if (room.players.some((p) => p.socketId === socketId)) return room;
  }
  return null;
}

function transferHostIfNeeded(room) {
  const host = room.players.find((p) => p.clientId === room.hostClientId);
  if (host) {
    room.hostSocketId = host.socketId;
    return;
  }
  const next = room.players.find((p) => p.connected !== false) || room.players[0];
  if (next) {
    room.hostClientId = next.clientId;
    room.hostSocketId = next.socketId;
  }
}

// =============================
// Mafia engine
// =============================
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function mafiaRolePlan(n) {
  const mafiaCount = Math.max(1, Math.floor(n / 3));
  const roles = [];
  for (let i = 0; i < mafiaCount; i += 1) roles.push('mafia');
  if (n >= 5) roles.push('doctor', 'detective');
  while (roles.length < n) roles.push('villager');
  return shuffle(roles);
}

function ensureMafia(room) {
  if (!room.mafia) {
    room.mafia = {
      started: false,
      phase: 'lobby',
      round: 0,
      p: {},
      night: { kills: {}, saves: {}, checks: {} },
      votes: {},
      lastResult: null,
      winnerTeam: null,
    };
  }
  return room.mafia;
}

function publicMafiaState(room) {
  const m = ensureMafia(room);
  return {
    roomCode: room.code,
    started: m.started,
    phase: m.phase,
    round: m.round,
    alive: Object.values(m.p).map((x) => ({ clientId: x.clientId, name: x.name, alive: x.alive })),
    lastResult: m.lastResult,
    winnerTeam: m.winnerTeam,
  };
}

function stateForClient(room, clientId) {
  const m = ensureMafia(room);
  const me = m.p[String(clientId || '')];
  return {
    ...publicMafiaState(room),
    myRole: me ? me.role : null,
    investigationResult: me ? me.investigationResult : null,
    canAdvance: String(clientId || '') === String(room.hostClientId || ''),
  };
}

function emitMafiaState(room) {
  const m = ensureMafia(room);
  for (const p of room.players) {
    io.to(p.socketId).emit('mafia:state', stateForClient(room, p.clientId));
    if (m.started && m.p[p.clientId]) io.to(p.socketId).emit('mafia:role', { role: m.p[p.clientId].role });
  }
  io.to(room.code).emit('mafia:publicState', publicMafiaState(room));
}

function computeWinner(room) {
  const alive = Object.values(ensureMafia(room).p).filter((x) => x.alive);
  const mafiaAlive = alive.filter((x) => x.role === 'mafia').length;
  const townAlive = alive.filter((x) => x.role !== 'mafia').length;
  if (mafiaAlive === 0) return 'town';
  if (mafiaAlive >= townAlive) return 'mafia';
  return null;
}

function startGame(socket, data = {}) {
  const code = normRoomCode(data.roomCode);
  const room = rooms.get(code);
  if (!room) return socket.emit('game:error', { message: 'الغرفة غير موجودة' });
  if (!isHost(room, socket, data)) return socket.emit('game:error', { message: 'فقط المستضيف يمكنه بدء اللعبة' });
  if (room.players.length < 2 && !room.devMode) return socket.emit('game:error', { message: 'تحتاج لاعبين على الأقل' });

  const gameId = String(data.gameId || room.selectedGame || 'mafia');
  room.status = 'playing';
  room.selectedGame = gameId;

  if (gameId === 'mafia') {
    const m = ensureMafia(room);
    m.started = true;
    m.phase = 'role';
    m.round = 1;
    m.p = {};
    m.night = { kills: {}, saves: {}, checks: {} };
    m.votes = {};
    m.lastResult = null;
    m.winnerTeam = null;

    const roles = mafiaRolePlan(room.players.length);
    room.players.forEach((pl, idx) => {
      m.p[pl.clientId] = { clientId: pl.clientId, name: pl.name, alive: true, role: roles[idx], investigationResult: null };
    });
  }

  io.to(code).emit('game:started', { roomCode: code, gameId });
  emitRoom(room);
  if (gameId === 'mafia') emitMafiaState(room);
}

function resolveMafiaNext(socket, data = {}) {
  const code = normRoomCode(data.roomCode);
  const room = rooms.get(code);
  if (!room || !isHost(room, socket, data)) return;
  const m = ensureMafia(room);
  if (!m.started || m.winnerTeam) return;

  if (m.phase === 'role') {
    m.phase = 'night';
    m.lastResult = { phase: 'nightStart', round: m.round };
  } else if (m.phase === 'night') {
    const killTargets = Object.values(m.night.kills);
    const saveTargets = new Set(Object.values(m.night.saves));
    let killed = null;
    if (killTargets.length) {
      const counts = {};
      killTargets.forEach((t) => { counts[t] = (counts[t] || 0) + 1; });
      killed = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
      if (saveTargets.has(killed)) killed = null;
    }
    if (killed && m.p[killed]) m.p[killed].alive = false;
    m.lastResult = { phase: 'nightEnd', killed, saved: [...saveTargets] };
    m.night = { kills: {}, saves: {}, checks: {} };
    m.phase = 'day';
  } else if (m.phase === 'day') {
    const votes = Object.values(m.votes);
    let executed = null;
    if (votes.length) {
      const counts = {};
      votes.forEach((t) => { counts[t] = (counts[t] || 0) + 1; });
      executed = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    }
    if (executed && m.p[executed]) m.p[executed].alive = false;
    m.lastResult = { phase: 'dayEnd', executed, votesCount: votes.length };
    m.votes = {};
    m.round += 1;
    m.phase = 'night';
  }

  m.winnerTeam = computeWinner(room);
  if (m.winnerTeam) {
    room.status = 'finished';
    const winningPlayers = Object.values(m.p).filter((p) => (m.winnerTeam === 'mafia' ? p.role === 'mafia' : p.role !== 'mafia'));
    winningPlayers.forEach((winner) => {
      const player = room.players.find((p) => p.clientId === winner.clientId);
      if (player) player.score = Number(player.score || 0) + 1;
    });
  }

  emitRoom(room);
  emitMafiaState(room);
}

function resetToLobby(socket, data = {}) {
  const code = normRoomCode(data.roomCode);
  const room = rooms.get(code);
  if (!room || !isHost(room, socket, data)) return;
  room.status = 'waiting';
  room.players.forEach((p) => { p.isReady = false; });
  room.mafia = null;
  emitRoom(room);
  io.to(code).emit('lobby:reset', { roomCode: code });
}

io.on('connection', (socket) => {
  const baseClientId = getClientId(socket);
  sockets.set(socket.id, { clientId: baseClientId, socket });
  console.log(`✅ connected ${socket.id}`);

  socket.on('host:createRoom', (data = {}) => {
    const code = generateRoomCode();
    const hostClientId = getClientId(socket, data);
    const hostName = safeName(data.name, 'Host');
    const room = {
      code,
      hostSocketId: socket.id,
      hostClientId,
      players: [{ socketId: socket.id, clientId: hostClientId, name: hostName, isReady: true, connected: true, joinedAt: Date.now(), score: 0 }],
      status: 'waiting',
      selectedGame: 'mafia',
      devMode: false,
      createdAt: Date.now(),
      mafia: null,
    };
    rooms.set(code, room);
    socket.join(code);
    socket.emit('host:roomCreated', { roomCode: code });
    socket.emit('room:created', { roomCode: code, code });
    emitRoom(room);
  });

  socket.on('host:attach', (data = {}) => {
    const code = normRoomCode(data.roomCode);
    const room = rooms.get(code);
    if (!room) return socket.emit('room:error', { message: 'الغرفة غير موجودة' });
    socket.join(code);
    if (isHost(room, socket, data)) {
      room.hostSocketId = socket.id;
      const host = room.players.find((p) => p.clientId === room.hostClientId);
      if (host) { host.socketId = socket.id; host.connected = true; }
    }
    emitRoom(room);
  });

  socket.on('host:setDevMode', (data = {}) => {
    const code = normRoomCode(data.roomCode);
    const room = rooms.get(code);
    if (!room || !isHost(room, socket, data)) return;
    room.devMode = !!data.enabled;
    emitRoom(room);
  });

  socket.on('player:join', (data = {}) => {
    const code = normRoomCode(data.roomCode);
    const room = rooms.get(code);
    const clientId = getClientId(socket, data);
    const name = safeName(data.name, 'لاعب');

    if (!room) return socket.emit('join:error', { message: 'الغرفة غير موجودة - تحقق من الكود' });
    if (room.status !== 'waiting') return socket.emit('join:error', { message: 'الغرفة مقفلة بعد بداية اللعبة' });
    if (room.players.length >= MAX_PLAYERS && !room.players.some((p) => p.clientId === clientId)) {
      return socket.emit('join:error', { message: `الغرفة ممتلئة (${MAX_PLAYERS})` });
    }

    let player = room.players.find((p) => p.clientId === clientId || p.socketId === socket.id);
    if (player) {
      player.socketId = socket.id;
      player.clientId = clientId;
      player.name = name || player.name;
      player.connected = true;
    } else {
      player = { socketId: socket.id, clientId, name, isReady: false, connected: true, joinedAt: Date.now(), score: 0 };
      room.players.push(player);
    }

    if (player.clientId === room.hostClientId) room.hostSocketId = socket.id;
    socket.join(code);
    socket.emit('player:joined', { roomCode: code, player });
    emitRoom(room);
  });

  // Backward-compatible aliases: call handler logic by re-emitting through the socket is wrong, so use same public event from client side.
  socket.on('join:room', (data = {}) => socket.listeners('player:join')[0]?.(data));
  socket.on('room:join', (data = {}) => socket.listeners('player:join')[0]?.(data));
  socket.on('join', (data = {}) => socket.listeners('player:join')[0]?.(data));

  socket.on('player:attach', (data = {}) => {
    const code = normRoomCode(data.roomCode);
    const room = rooms.get(code);
    if (!room) return;
    const clientId = getClientId(socket, data);
    const player = room.players.find((p) => p.clientId === clientId);
    if (player) {
      player.socketId = socket.id;
      player.connected = true;
      if (player.clientId === room.hostClientId) room.hostSocketId = socket.id;
      socket.join(code);
      socket.emit('player:joined', { roomCode: code, player });
      emitRoom(room);
      if (room.mafia?.started) emitMafiaState(room);
    }
  });

  socket.on('room:getState', (data = {}) => {
    const room = rooms.get(normRoomCode(data.roomCode));
    if (room) {
      socket.join(room.code);
      socket.emit('room:state', roomInfo(room));
      socket.emit('room:update', roomInfo(room));
    }
  });

  socket.on('hub:getState', (data = {}) => {
    const room = rooms.get(normRoomCode(data.roomCode));
    if (room) socket.emit('hub:state', { roomCode: room.code, currentGame: room.selectedGame, selectedGame: room.selectedGame, scores: roomInfo(room).players });
  });

  socket.on('player:ready', (data = {}) => {
    const room = rooms.get(normRoomCode(data.roomCode));
    if (!room) return;
    const player = getPlayer(room, socket, data);
    if (!player) return;
    player.isReady = !!data.isReady;
    emitRoom(room);
    if (room.players.length > 0 && room.players.every((p) => p.isReady)) io.to(room.code).emit('room:allReady', { roomCode: room.code });
  });

  socket.on('player:leave', (data = {}) => {
    const code = normRoomCode(data.roomCode);
    const room = rooms.get(code);
    if (!room) return;
    const player = getPlayer(room, socket, data);
    if (!player) return;
    room.players = room.players.filter((p) => p.clientId !== player.clientId);
    socket.leave(code);
    transferHostIfNeeded(room);
    socket.emit('player:left', { roomCode: code });
    cleanupRoomIfEmpty(code);
    if (rooms.has(code)) emitRoom(room);
  });

  socket.on('room:setGame', (data = {}) => {
    const room = rooms.get(normRoomCode(data.roomCode));
    if (!room) return;
    if (!isHost(room, socket, data)) return socket.emit('room:error', { message: 'فقط المستضيف يقدر يختار اللعبة' });
    room.selectedGame = String(data.gameId || 'mafia');
    emitRoom(room);
  });

  socket.on('hub:setGame', (data = {}) => socket.listeners('room:setGame')[0]?.(data));
  socket.on('game:start', (data = {}) => startGame(socket, data));
  socket.on('mafia:start', (data = {}) => startGame(socket, { ...data, gameId: 'mafia' }));
  socket.on('lobby:reset', (data = {}) => resetToLobby(socket, data));

  socket.on('mafia:getState', (data = {}) => {
    const room = rooms.get(normRoomCode(data.roomCode));
    if (!room) return;
    socket.emit('mafia:state', stateForClient(room, getClientId(socket, data)));
  });

  socket.on('mafia:nightAction', (data = {}) => {
    const room = rooms.get(normRoomCode(data.roomCode));
    if (!room) return;
    const m = ensureMafia(room);
    const cid = getClientId(socket, data);
    const targetId = String(data.targetId || '');
    const action = String(data.action || '');
    const me = m.p[cid];
    const target = m.p[targetId];
    if (!m.started || m.phase !== 'night' || !me?.alive || !target?.alive || m.winnerTeam) return;
    if (action === 'kill' && me.role === 'mafia') m.night.kills[cid] = targetId;
    if (action === 'save' && me.role === 'doctor') m.night.saves[cid] = targetId;
    if (action === 'check' && me.role === 'detective') {
      m.night.checks[cid] = targetId;
      me.investigationResult = { targetId, isMafia: target.role === 'mafia' };
    }
    emitMafiaState(room);
  });

  socket.on('mafia:vote', (data = {}) => {
    const room = rooms.get(normRoomCode(data.roomCode));
    if (!room) return;
    const m = ensureMafia(room);
    const cid = getClientId(socket, data);
    const targetId = String(data.targetId || '');
    if (!m.started || m.phase !== 'day' || !m.p[cid]?.alive || !m.p[targetId]?.alive || m.winnerTeam) return;
    m.votes[cid] = targetId;
    emitMafiaState(room);
  });

  socket.on('mafia:next', (data = {}) => resolveMafiaNext(socket, data));
  socket.on('mafia:forceResolveNight', (data = {}) => resolveMafiaNext(socket, data));
  socket.on('mafia:forceResolveDay', (data = {}) => resolveMafiaNext(socket, data));

  socket.on('mafia:revealAll', (data = {}) => {
    const room = rooms.get(normRoomCode(data.roomCode));
    if (!room || !isHost(room, socket, data)) return;
    const m = ensureMafia(room);
    socket.emit('mafia:reveal', { roles: Object.values(m.p).map((p) => ({ clientId: p.clientId, name: p.name, role: p.role, alive: p.alive })) });
  });

  socket.on('mafia:setRole', (data = {}) => {
    const room = rooms.get(normRoomCode(data.roomCode));
    if (!room || !isHost(room, socket, data)) return;
    const m = ensureMafia(room);
    const p = m.p[String(data.clientId || '')];
    if (p && ['mafia', 'doctor', 'detective', 'villager'].includes(data.role)) p.role = data.role;
    emitMafiaState(room);
  });

  socket.on('mafia:toggleAlive', (data = {}) => {
    const room = rooms.get(normRoomCode(data.roomCode));
    if (!room || !isHost(room, socket, data)) return;
    const m = ensureMafia(room);
    const p = m.p[String(data.clientId || '')];
    if (p) p.alive = !p.alive;
    emitMafiaState(room);
  });

  socket.on('disconnect', () => {
    console.log(`❌ disconnected ${socket.id}`);
    sockets.delete(socket.id);
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    const player = room.players.find((p) => p.socketId === socket.id);
    if (!player) return;
    player.connected = false;

    if (!disconnectTimers.has(room.code)) disconnectTimers.set(room.code, new Map());
    const timers = disconnectTimers.get(room.code);
    if (timers.has(player.clientId)) clearTimeout(timers.get(player.clientId));

    timers.set(player.clientId, setTimeout(() => {
      const r = rooms.get(room.code);
      if (!r) return;
      const p = r.players.find((x) => x.clientId === player.clientId);
      if (!p || p.connected !== false) return;
      r.players = r.players.filter((x) => x.clientId !== player.clientId);
      transferHostIfNeeded(r);
      cleanupRoomIfEmpty(r.code);
      if (rooms.has(r.code)) emitRoom(r);
    }, DISCONNECT_GRACE_MS));

    emitRoom(room);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.createdAt > 4 * 60 * 60 * 1000) rooms.delete(code);
  }
}, 30 * 60 * 1000);

app.get('/', (req, res) => res.send('Gamehub server is running ✅'));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size, sockets: sockets.size, timestamp: Date.now() }));
app.get('/api/health', (req, res) => res.json({ ok: true, rooms: rooms.size, sockets: sockets.size, timestamp: Date.now() }));
app.get('/api/rooms', (req, res) => res.json({ rooms: Array.from(rooms.values()).map(roomInfo) }));
app.get('/api/room/:code', (req, res) => {
  const room = rooms.get(normRoomCode(req.params.code));
  if (!room) return res.status(404).json({ error: 'Room not found' });
  return res.json({ room: roomInfo(room) });
});
app.get('/qr', async (req, res) => {
  const data = String(req.query.data || '');
  if (!data) return res.status(400).send('Missing data');
  try {
    res.type('png');
    const buffer = await QRCode.toBuffer(data, { type: 'png', margin: 1, width: 320 });
    return res.send(buffer);
  } catch (err) {
    return res.status(500).send('QR error');
  }
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`🎮 Gamehub4u server running on port ${PORT}`);
});

process.on('SIGTERM', () => {
  httpServer.close(() => process.exit(0));
});
