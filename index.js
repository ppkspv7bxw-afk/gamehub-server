const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const httpServer = createServer(app);

// CORS Configuration
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST']
}));

// Serve static files
app.use(express.static('public'));
app.use(express.json());

// Socket.IO Configuration
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling']
});

// Data Storage (في الإنتاج، استخدم Database)
const rooms = new Map();
// Graceful disconnect timers (roomCode -> clientId -> timeout)
const disconnectTimers = new Map();
const DISCONNECT_GRACE_MS = 60_000;

// --- client identity helpers (supports legacy "clientId" + new "gh_clientId") ---
function getClientIdFrom(socket, data){
  const a = (socket && socket.handshake && socket.handshake.auth) ? socket.handshake.auth : {};
  const cid =
    (data && (data.gh_clientId || data.clientId)) ||
    (a && (a.gh_clientId || a.clientId)) ||
    (socket ? socket.id : undefined);
  return String(cid || '');
}
function normRoomCode(code){
  return String(code || '').trim().toUpperCase();
}

const players = new Map();

// =============================
// Mafia Engine (minimal v1)
// =============================
function shuffle(arr){
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function mafiaRolePlan(n){
  // Simple & scalable:
  // - mafia ≈ 1 per 3 players (min 1)
  // - doctor + detective when n >= 5
  const mafiaCount = Math.max(1, Math.floor(n / 3));
  const hasSpecials = n >= 5;
  const roles = [];
  for (let i = 0; i < mafiaCount; i++) roles.push('mafia');
  if (hasSpecials) roles.push('doctor', 'detective');
  while (roles.length < n) roles.push('villager');
  return shuffle(roles);
}

function ensureMafia(room){
  if (!room.mafia) {
    room.mafia = {
      started: false,
      phase: 'role',
      round: 1,
      // keyed by clientId
      p: {},
      // per-round buffers
      night: { kills: {}, saves: {}, checks: {} },
      votes: {},
      lastResult: null,
      winnerTeam: null
    };
  }
  return room.mafia;
}

function publicMafiaState(room){
  const m = ensureMafia(room);
  const aliveArr = Object.values(m.p).map(x => ({
    clientId: x.clientId,
    name: x.name,
    alive: x.alive
  }));
  return {
    roomCode: room.code,
    started: m.started,
    phase: m.phase,
    round: m.round,
    alive: aliveArr,
    lastResult: m.lastResult,
    winnerTeam: m.winnerTeam
  };
}

function stateForClient(room, clientId){
  const m = ensureMafia(room);
  const base = publicMafiaState(room);
  const me = m.p[String(clientId || '')];
  return {
    ...base,
    myRole: me ? me.role : null,
    investigationResult: me ? me.investigationResult : null,
    canAdvance: room.host === (room.clientToSocket?.get(room.hostClientId || '') || room.host)
  };
}

function computeWinner(room){
  const m = ensureMafia(room);
  const alive = Object.values(m.p).filter(x => x.alive);
  const mafiaAlive = alive.filter(x => x.role === 'mafia').length;
  const townAlive = alive.filter(x => x.role !== 'mafia').length;
  if (mafiaAlive === 0) return 'town';
  if (mafiaAlive >= townAlive) return 'mafia';
  return null;
}

function emitMafiaStateToRoom(io, room){
  // Send personalized state per socket (so role is only seen by its owner)
  const m = ensureMafia(room);
  for (const pl of room.players) {
    const sid = pl.id;
    const cid = pl.clientId;
    io.to(sid).emit('mafia:state', stateForClient(room, cid));
    // Also re-send role privately if started
    const me = m.p[cid];
    if (m.started && me) io.to(sid).emit('mafia:role', { role: me.role });
  }
}

// Helper Functions
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));
  return code;
}

function getRoomInfo(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return null;
  
  return {
    code: room.code,
    host: room.host,
    playerCount: room.players.length,
    players: room.players.map(p => ({
      id: p.id,
      clientId: p.clientId,
      name: p.name,
      isHost: (room.hostClientId ? p.clientId === room.hostClientId : p.id === room.host),
      isReady: !!p.isReady,
      connected: p.connected !== false
    })),
    status: room.status,
    selectedGame: room.selectedGame || null,
    createdAt: room.createdAt
  };
}

function cleanupOldRooms() {
  const now = Date.now();
  const maxAge = 4 * 60 * 60 * 1000; // 4 hours
  
  for (const [code, room] of rooms.entries()) {
    if (now - room.createdAt > maxAge) {
      console.log(`🗑️  Cleaning up old room: ${code}`);
      rooms.delete(code);
    }
  }
}

// Clean up old rooms every 30 minutes
setInterval(cleanupOldRooms, 30 * 60 * 1000);

// Socket.IO Events
io.on('connection', (socket) => {
  console.log(`✅ Client connected: ${socket.id}`);
  
  const clientId = getClientIdFrom(socket);
  players.set(socket.id, { clientId, socket });

  // ==========================================
  // HOST: Create Room
  // ==========================================
  socket.on('host:createRoom', (data) => {
    console.log(`🎮 Host creating room:`, data);
    
    const roomCode = generateRoomCode();
    const hostName = (data && data.name) ? String(data.name).trim() : 'Host';
    const hostClientId = getClientIdFrom(socket, data);

    const room = {
      code: roomCode,
      host: socket.id,
      hostClientId: hostClientId,
      clientToSocket: new Map([[hostClientId, socket.id]]),
      players: [
        {
          id: socket.id,
          clientId: hostClientId,
          name: hostName || 'Host',
          joinedAt: Date.now(),
          isReady: false,
          connected: true
        }
      ],
      status: 'waiting',
      createdAt: Date.now(),
      gameData: null,
      selectedGame: 'mafia'
    };
    
    rooms.set(roomCode, room);
    socket.join(code);
    
    console.log(`✅ Room created: ${roomCode} by ${socket.id}`);
    
    // إرسال الكود للـ Host
    socket.emit('host:roomCreated', { roomCode });
    socket.emit('room:created', { roomCode });

    // Update room info for host UI immediately
    const roomInfo = getRoomInfo(roomCode);
    io.to(roomCode).emit('players:update', roomInfo);
    io.to(roomCode).emit('room:update', roomInfo);
  });

  // ==========================================
  // ROOM: Check if exists
  // ==========================================
  socket.on('room:check', (data, callback) => {
    const { roomCode } = data || {};
    const code = normRoomCode(roomCode);
    const exists = rooms.has(code);
    
    console.log(`🔍 Checking room ${code}: ${exists ? 'EXISTS' : 'NOT FOUND'}`);
    
    if (callback && typeof callback === 'function') {
      callback({ exists, roomCode: code });
    }
  });

  // ==========================================
  // PLAYER: Join Room
  // ==========================================
  socket.on('player:join', (data) => {
    const { roomCode, name, clientId, gh_clientId } = data || {};
    const code = normRoomCode(roomCode);
    const cid = String(gh_clientId || clientId || getClientIdFrom(socket, data) || '');
    const playerName = String(name || '').trim().slice(0, 24);
    
    console.log(`👤 Player trying to join:`, { roomCode: code, name: playerName, socketId: socket.id, clientId: cid });
    
    const room = rooms.get(code);
    
    if (!room) {
      console.log(`❌ Room not found: ${code}`);
      socket.emit('join:error', { 
        message: 'الغرفة غير موجودة - تحقق من الكود' 
      });
      return;
    }
    
    // Ensure mapping exists
    if (!room.clientToSocket) room.clientToSocket = new Map();

    // Check if player already in room (by socket id or client id)
        const existingPlayer = room.players.find(p => p.id === socket.id || (cid && p.clientId === cid));
    
    if (existingPlayer) {
      console.log(`⚠️  Player already in room: ${name}`);
      socket.join(code);
      // Refresh socket id on reconnect
            if (cid && existingPlayer.clientId === cid && existingPlayer.id !== socket.id) {
                room.clientToSocket.set(cid, socket.id);
        // If host was the old socket, migrate host to new socket
        if (room.host === existingPlayer.id) room.host = socket.id;
        existingPlayer.id = socket.id;
      }
      socket.emit('player:joined', { roomCode, player: existingPlayer });
      return;
    }
    
    // Add player to room
    const player = {
      id: socket.id,
      clientId: cid || socket.id,
      name: name || 'لاعب',
      connected: true,
      joinedAt: Date.now(),
      isReady: false
    };
    
    room.players.push(player);
    room.clientToSocket.set(player.clientId, socket.id);
    socket.join(code);
    
    console.log(`✅ Player joined: ${name} → ${roomCode} (${room.players.length} players)`);
    
    // Notify player
    socket.emit('player:joined', { roomCode, player });
    
    // Notify everyone in room
    const roomInfo = getRoomInfo(roomCode);
    io.to(roomCode).emit('players:update', roomInfo);
    io.to(roomCode).emit('room:update', roomInfo);
  });

  // ==========================================
  // PLAYER: Ready / Unready
  // ==========================================
  socket.on('player:ready', (data) => {
    const { roomCode, isReady } = data || {};
    const code = String(roomCode || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    player.isReady = !!isReady;
    console.log(`✅ Ready update: ${player.name} -> ${player.isReady} (${code})`);

    const roomInfo = getRoomInfo(code);
    io.to(code).emit('players:update', roomInfo);
    io.to(code).emit('room:update', roomInfo);

    // Optional convenience event
    const allReady = room.players.length > 0 && room.players.every(p => p.isReady);
    if (allReady) {
      io.to(code).emit('room:allReady', { roomCode: code });
    }
  });

  // ==========================================
  // PLAYER: Attach (reconnect helper)
  // ==========================================
  socket.on('player:attach', (data) => {
    const { roomCode, clientId } = data || {};
    const code = String(roomCode || '').toUpperCase();
    const cid = String(clientId || '');
    const room = rooms.get(code);
    if (!room || !cid) return;
    if (!room.clientToSocket) room.clientToSocket = new Map();

    const pl = room.players.find(p => p.clientId === cid);
    if (pl) {
      const oldSid = pl.id;
      pl.id = socket.id;
      pl.connected = true;
      const tmap = disconnectTimers.get(code);
      if (tmap && tmap.has(cid)) { clearTimeout(tmap.get(cid)); tmap.delete(cid); }
      if (room.hostClientId && room.hostClientId === cid) room.host = socket.id;
      room.clientToSocket.set(cid, socket.id);
      if (room.host === oldSid) room.host = socket.id;
      socket.join(code);
      const roomInfo = getRoomInfo(code);
      io.to(code).emit('players:update', roomInfo);
      io.to(code).emit('room:update', roomInfo);
      // If a mafia game is running, re-send private role + state
      if (room.mafia && room.mafia.started) {
        emitMafiaStateToRoom(io, room);
      }
    }
  });

  // ==========================================
  // Alternative join events (للتوافق)
  // ==========================================
  socket.on('join:room', (data) => {
    socket.emit('player:join', data);
  });
  
  socket.on('room:join', (data) => {
    socket.emit('player:join', data);
  });

  socket.on('join', (data) => {
    socket.emit('player:join', data);
  });

  // ==========================================
  // PLAYER: Leave Room
  // ==========================================
  socket.on('player:leave', (data) => {
    const { roomCode } = data;
    handlePlayerLeave(socket, roomCode);
  });

  // ==========================================
  // ROOM: Set Selected Game (Host only)
  // ==========================================
  socket.on('room:setGame', (data) => {
    const { roomCode, gameId } = data || {};
    const code = String(roomCode || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) return;

    if (room.host !== socket.id) {
      socket.emit('room:error', { message: 'فقط المستضيف يمكنه اختيار اللعبة' });
      return;
    }

    room.selectedGame = String(gameId || '').trim() || 'mafia';
    console.log("🎯 Selected game for " + code + ": " + room.selectedGame);

    const roomInfo = getRoomInfo(code);
    io.to(code).emit('room:update', roomInfo);
  });


// ==========================================
  // GAME: Start
  // ==========================================
  socket.on('game:start', (data) => {
    const { roomCode } = data;
    const code = String(roomCode || '').toUpperCase();
    const room = rooms.get(code);
    
    if (!room) {
      socket.emit('game:error', { message: 'الغرفة غير موجودة' });
      return;
    }
    
    const callerCid = getClientIdFrom(socket, data);
    if (room.hostClientId && callerCid !== room.hostClientId) {
      socket.emit('game:error', { message: 'فقط المستضيف يمكنه بدء اللعبة' });
      return;
    }
    if (!room.hostClientId && room.host !== socket.id) {
      socket.emit('game:error', { message: 'فقط المستضيف يمكنه بدء اللعبة' });
      return;
    }
    
    room.status = 'playing';
    console.log(`🎮 Game started in room: ${code}`);

    const gameId = room.selectedGame || 'mafia';
    // Initialize mafia engine when selected
    if (gameId === 'mafia') {
      const m = ensureMafia(room);
      m.started = true;
      m.phase = 'role';
      m.round = 1;
      m.lastResult = null;
      m.winnerTeam = null;
      m.night = { kills: {}, saves: {}, checks: {} };
      m.votes = {};

      // Create player table by clientId
      const roles = mafiaRolePlan(room.players.length);
      room.players.forEach((pl, idx) => {
        m.p[pl.clientId] = {
          clientId: pl.clientId,
          name: pl.name,
          alive: true,
          role: roles[idx],
          investigationResult: null
        };
        // PRIVATE: send role only to that player's socket
        io.to(pl.id).emit('mafia:role', { role: roles[idx] });
      });
    }

    io.to(code).emit('game:started', { roomCode: code, gameId });
    // Also push mafia state to everyone (personalized per socket)
    if ((room.selectedGame || 'mafia') === 'mafia') {
      emitMafiaStateToRoom(io, room);
    }
  });

  // ==========================================
  // MAFIA: Get State (personalized)
  // ==========================================
  socket.on('mafia:getState', (data) => {
    const { roomCode, clientId } = data || {};
    const code = String(roomCode || '').toUpperCase();
    const cid = String(clientId || '');
    const room = rooms.get(code);
    if (!room) return;
    ensureMafia(room);
    socket.emit('mafia:state', stateForClient(room, cid));
  });

  // ==========================================
  // MAFIA: Night Action
  // ==========================================
  socket.on('mafia:nightAction', (data) => {
    const { roomCode, clientId, action, targetId } = data || {};
    const code = String(roomCode || '').toUpperCase();
    const cid = String(clientId || '');
    const tid = String(targetId || '');
    const room = rooms.get(code);
    if (!room) return;
    const m = ensureMafia(room);
    if (!m.started || m.winnerTeam) return;
    if (m.phase !== 'night') return;
    const me = m.p[cid];
    if (!me || !me.alive) return;
    const target = m.p[tid];
    if (!target || !target.alive) return;

    if (action === 'kill' && me.role === 'mafia') {
      m.night.kills[cid] = tid;
    } else if (action === 'save' && me.role === 'doctor') {
      m.night.saves[cid] = tid;
    } else if (action === 'check' && me.role === 'detective') {
      m.night.checks[cid] = tid;
      me.investigationResult = { targetId: tid, isMafia: target.role === 'mafia' };
    } else {
      return;
    }

    emitMafiaStateToRoom(io, room);
  });

  // ==========================================
  // MAFIA: Vote
  // ==========================================
  socket.on('mafia:vote', (data) => {
    const { roomCode, clientId, targetId } = data || {};
    const code = String(roomCode || '').toUpperCase();
    const cid = String(clientId || '');
    const tid = String(targetId || '');
    const room = rooms.get(code);
    if (!room) return;
    const m = ensureMafia(room);
    if (!m.started || m.winnerTeam) return;
    if (m.phase !== 'day') return;
    const me = m.p[cid];
    const target = m.p[tid];
    if (!me || !me.alive || !target || !target.alive) return;
    m.votes[cid] = tid;
    emitMafiaStateToRoom(io, room);
  });

  // ==========================================
  // MAFIA: Next (Host only)
  // ==========================================
  socket.on('mafia:next', (data) => {
    const { roomCode } = data || {};
    const code = String(roomCode || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) return;
    if (room.host !== socket.id) return;
    const m = ensureMafia(room);
    if (!m.started || m.winnerTeam) return;

    // role -> night -> day -> night ...
    if (m.phase === 'role') {
      m.phase = 'night';
      m.lastResult = { phase: 'nightStart', round: m.round };
    } else if (m.phase === 'night') {
      // Resolve night
      const killTargets = Object.values(m.night.kills);
      const saveTargets = new Set(Object.values(m.night.saves));
      let killed = null;
      if (killTargets.length) {
        // pick majority; fallback first
        const counts = {};
        for (const t of killTargets) counts[t] = (counts[t] || 0) + 1;
        killed = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][0];
        if (saveTargets.has(killed)) killed = null;
      }
      if (killed && m.p[killed]) m.p[killed].alive = false;
      m.lastResult = { phase: 'nightEnd', killed, saved: [...saveTargets] };
      m.night = { kills: {}, saves: {}, checks: {} };
      m.phase = 'day';
    } else if (m.phase === 'day') {
      // Resolve votes
      const votes = Object.values(m.votes);
      let executed = null;
      if (votes.length) {
        const counts = {};
        for (const t of votes) counts[t] = (counts[t] || 0) + 1;
        executed = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][0];
      }
      if (executed && m.p[executed]) m.p[executed].alive = false;
      m.lastResult = { phase: 'dayEnd', executed, votesCount: votes.length };
      m.votes = {};
      m.round += 1;
      m.phase = 'night';
    }

    m.winnerTeam = computeWinner(room);
    emitMafiaStateToRoom(io, room);
  });

  // ==========================================
  // DISCONNECT
  // ==========================================
  socket.on('disconnect', () => {
  console.log(`❌ Client disconnected: ${socket.id}`);

  for (const [roomCode, room] of rooms.entries()) {
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) continue;

    const pl = room.players[idx];
    pl.connected = false;
    pl.disconnectedAt = Date.now();

    const cid = String(pl.clientId || '');
    if (!disconnectTimers.has(roomCode)) disconnectTimers.set(roomCode, new Map());
    const tmap = disconnectTimers.get(roomCode);

    if (tmap.has(cid)) clearTimeout(tmap.get(cid));

    const timer = setTimeout(() => {
      const r = rooms.get(roomCode);
      if (!r) return;
      const pIndex = r.players.findIndex(x => x.clientId === cid);
      if (pIndex === -1) return;
      const p = r.players[pIndex];
      if (p.connected !== false) return; // reconnected

      r.players.splice(pIndex, 1);
      if (r.clientToSocket) r.clientToSocket.delete(cid);

      console.log(`👋 ${p.name} removed after grace from ${roomCode}`);

      if (r.players.length === 0) {
        rooms.delete(roomCode);
        disconnectTimers.delete(roomCode);
        console.log(`🗑️  Room deleted: ${roomCode} (empty)`);
        return;
      }

      // keep host by hostClientId if possible
      if (r.hostClientId) {
        const hostPlayer = r.players.find(x => x.clientId === r.hostClientId);
        if (hostPlayer) r.host = hostPlayer.id;
      } else {
        if (!r.players.some(x => x.id === r.host)) r.host = r.players[0].id;
      }

      const roomInfo = getRoomInfo(roomCode);
      io.to(roomCode).emit('players:update', roomInfo);
      io.to(roomCode).emit('room:update', roomInfo);
      io.to(roomCode).emit('player:left', { playerId: socket.id, playerName: p.name });
    }, DISCONNECT_GRACE_MS);

    tmap.set(cid, timer);

    console.log(`⏳ ${pl.name} marked disconnected (grace ${DISCONNECT_GRACE_MS}ms) in ${roomCode}`);

    const roomInfo = getRoomInfo(roomCode);
    io.to(roomCode).emit('players:update', roomInfo);
    io.to(roomCode).emit('room:update', roomInfo);
  }
    players.delete(socket.id);
});
});

function handlePlayerLeave(socket, roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  
  const playerIndex = room.players.findIndex(p => p.id === socket.id);
  if (playerIndex === -1) return;
  
  const player = room.players[playerIndex];
  room.players.splice(playerIndex, 1);
  socket.leave(roomCode);
  
  console.log(`👋 ${player.name} left room ${roomCode}`);
  
  // Notify others
  const roomInfo = getRoomInfo(roomCode);
  io.to(roomCode).emit('players:update', roomInfo);
  io.to(roomCode).emit('player:left', { 
    playerId: socket.id,
    playerName: player.name 
  });
}

// ==========================================
// REST API Endpoints
// ==========================================
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    rooms: rooms.size,
    players: players.size,
    timestamp: Date.now()
  });
});

app.get('/api/rooms', (req, res) => {
  const roomList = Array.from(rooms.values()).map(room => ({
    code: room.code,
    playerCount: room.players.length,
    status: room.status,
    createdAt: room.createdAt
  }));
  
  res.json({ rooms: roomList });
});

app.get('/api/room/:code', (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const roomInfo = getRoomInfo(roomCode);
  
  if (!roomInfo) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  res.json({ room: roomInfo });
});

// ==========================================
// Start Server
// ==========================================
const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════╗
║   🎮 Gamehub4u Server Running    ║
║   📡 Port: ${PORT}                    ║
║   🌐 Socket.IO: Ready             ║
╚═══════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('⚠️  SIGTERM received, shutting down gracefully...');
  httpServer.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});