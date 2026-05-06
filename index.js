const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const QRCode = require('qrcode');
const { WebSocketServer, WebSocket } = require('ws');

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
  } else if (gameId === 'out-of-loop') {
    if (!outloopStart(room, data)) return socket.emit('game:error', { message: 'Out of the Loop تحتاج 3 لاعبين أو فعّل Dev Mode للتجربة' });
  } else if (gameId === 'conqueror') {
    if (!conqStart(room)) return socket.emit('game:error', { message: 'Conqueror تحتاج لاعبين أو فعّل Dev Mode للتجربة' });
  }

  io.to(code).emit('game:started', { roomCode: code, gameId });
  emitRoom(room);
  if (gameId === 'mafia') emitMafiaState(room);
  if (gameId === 'out-of-loop') emitOutloop(room);
  if (gameId === 'conqueror') emitConq(room);
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
  if (room.outloop?.timer) clearInterval(room.outloop.timer);
  room.outloop = null;
  if (room.conqueror?.resourceTimer) clearInterval(room.conqueror.resourceTimer);
  room.conqueror = null;
  emitRoom(room);
  io.to(code).emit('lobby:reset', { roomCode: code });
}



// =============================
// Mafia G WebSocket engine (new Mafia)
// =============================
const mafiaGRooms = new Map();
const mafiaGHistory = [];
const MAFIA_G_BOT_NAMES = ['بوت_سريع', 'بوت_ذكي', 'بوت_غامض', 'بوت_شجاع', 'بوت_مراقب', 'بوت_خفي'];

function mafiaGRoom(roomId) {
  const id = normRoomCode(roomId) || 'CITY1';
  if (!mafiaGRooms.has(id)) {
    const hubRoom = rooms.get(id);
    mafiaGRooms.set(id, {
      id,
      hostId: hubRoom?.hostClientId || null,
      phase: 'LOBBY',
      players: [],
      logs: [],
      votes: {},
      actions: {},
      settings: {
        mafiaCount: 1,
        doctorCount: 1,
        detectiveCount: 1,
        jesterCount: 0,
        bodyguardCount: 0,
        autoBalance: true,
        phaseDuration: 60,
      },
      timeLeft: 0,
      timer: null,
    });
  }
  return mafiaGRooms.get(id);
}

function mafiaGSend(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function mafiaGCleanRoom(room, forPlayerId) {
  const requestingPlayer = room.players.find((p) => p.id === forPlayerId);
  const isMafia = requestingPlayer?.role === 'MAFIA';
  return {
    id: room.id,
    phase: room.phase,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      isAlive: p.isAlive,
      isBot: !!p.isBot,
      isHost: p.id === room.hostId,
      role: (room.phase === 'GAME_OVER' || p.id === forPlayerId || (isMafia && p.role === 'MAFIA')) ? p.role : null,
    })),
    logs: room.logs,
    votes: room.votes,
    actionsCount: Object.keys(room.actions).length,
    mafiaActions: isMafia ? room.players.filter((p) => p.role === 'MAFIA' && room.actions[p.id]).reduce((acc, p) => { acc[p.id] = room.actions[p.id]; return acc; }, {}) : null,
    settings: room.settings,
    timeLeft: room.timeLeft,
  };
}

function mafiaGBroadcast(room, message) {
  room.players.forEach((p) => {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      const payload = message.type === 'ROOM_UPDATED' ? mafiaGCleanRoom(room, p.id) : message.payload;
      mafiaGSend(p.ws, { ...message, payload });
    }
  });
}

function mafiaGStartTimer(room) {
  if (room.timer) clearInterval(room.timer);
  room.timeLeft = Number(room.settings.phaseDuration || 60);
  room.timer = setInterval(() => {
    room.timeLeft -= 1;
    if (room.timeLeft <= 0) {
      clearInterval(room.timer);
      room.timer = null;
      if (room.phase === 'NIGHT') mafiaGProcessNight(room);
      else if (room.phase === 'DAY') mafiaGProcessDayVote(room);
    } else {
      mafiaGBroadcast(room, { type: 'ROOM_UPDATED' });
    }
  }, 1000);
}

function mafiaGAssignRoles(room) {
  const playerCount = room.players.length;
  let { mafiaCount, doctorCount, detectiveCount, jesterCount, bodyguardCount, autoBalance } = room.settings;
  if (autoBalance) {
    mafiaCount = Math.max(1, Math.floor(playerCount / 3.5));
    doctorCount = playerCount >= 5 ? (playerCount >= 10 ? 2 : 1) : 0;
    detectiveCount = playerCount >= 6 ? (playerCount >= 12 ? 2 : 1) : 0;
    bodyguardCount = playerCount >= 8 ? 1 : 0;
    jesterCount = playerCount >= 7 ? 1 : 0;
  }
  const roles = [];
  for (let i = 0; i < mafiaCount; i += 1) roles.push('MAFIA');
  for (let i = 0; i < doctorCount; i += 1) roles.push('DOCTOR');
  for (let i = 0; i < detectiveCount; i += 1) roles.push('DETECTIVE');
  for (let i = 0; i < (jesterCount || 0); i += 1) roles.push('JESTER');
  for (let i = 0; i < (bodyguardCount || 0); i += 1) roles.push('BODYGUARD');
  while (roles.length < playerCount) roles.push('VILLAGER');
  const finalRoles = shuffle(roles.slice(0, playerCount));
  room.players.forEach((p, i) => {
    p.role = finalRoles[i];
    p.isAlive = true;
    mafiaGSend(p.ws, { type: 'ASSIGN_ROLE', payload: p.role });
  });
}

function mafiaGTriggerBotActions(room) {
  if (room.phase === 'NIGHT') {
    const aliveBots = room.players.filter((p) => p.isBot && p.isAlive && p.role !== 'VILLAGER');
    const mafiaTarget = room.players.find((p) => p.isAlive && p.role !== 'MAFIA')?.id;
    aliveBots.forEach((bot) => {
      if (bot.role === 'MAFIA') room.actions[bot.id] = mafiaTarget || 'none';
      else if (bot.role === 'JESTER') room.actions[bot.id] = 'none';
      else {
        const choices = room.players.filter((p) => p.id !== bot.id && p.isAlive);
        if (choices.length) room.actions[bot.id] = choices[Math.floor(Math.random() * choices.length)].id;
      }
    });
    const aliveSpecial = room.players.filter((p) => p.isAlive && p.role !== 'VILLAGER');
    if (Object.keys(room.actions).length >= aliveSpecial.length) {
      if (room.timer) clearInterval(room.timer);
      mafiaGProcessNight(room);
    }
  } else if (room.phase === 'DAY') {
    const bots = room.players.filter((p) => p.isBot && p.isAlive);
    bots.forEach((bot) => {
      const choices = room.players.filter((p) => p.id !== bot.id && p.isAlive);
      if (choices.length) room.votes[bot.id] = choices[Math.floor(Math.random() * choices.length)].id;
    });
    const alive = room.players.filter((p) => p.isAlive);
    if (Object.keys(room.votes).length >= alive.length) {
      if (room.timer) clearInterval(room.timer);
      mafiaGProcessDayVote(room);
    }
  }
}

function mafiaGCheckWin(room) {
  const mafiaAlive = room.players.filter((p) => p.role === 'MAFIA' && p.isAlive).length;
  const townAlive = room.players.filter((p) => p.role !== 'MAFIA' && p.isAlive).length;
  let winner = null;
  if (mafiaAlive === 0) winner = 'الأبرياء';
  else if (mafiaAlive >= townAlive) winner = 'المافيا';
  if (!winner) return false;

  room.phase = 'GAME_OVER';
  if (room.timer) clearInterval(room.timer);
  room.timer = null;
  room.logs.push({ id: Math.random().toString(36).slice(2), text: winner === 'المافيا' ? 'انتصرت المافيا! سيطروا على المدينة.' : 'انتصر الأبرياء! تم القضاء على المافيا.', type: 'win' });
  mafiaGSaveResult(room, winner);
  mafiaGApplyLobbyScore(room, winner);
  mafiaGBroadcast(room, { type: 'ROOM_UPDATED' });
  return true;
}

function mafiaGApplyLobbyScore(room, winner) {
  const hubRoom = rooms.get(room.id);
  if (!hubRoom) return;
  const winners = room.players.filter((p) => winner === 'المافيا' ? p.role === 'MAFIA' : p.role !== 'MAFIA');
  winners.forEach((winnerPlayer) => {
    const lobbyPlayer = hubRoom.players.find((p) => p.clientId === winnerPlayer.id);
    if (lobbyPlayer) lobbyPlayer.score = Number(lobbyPlayer.score || 0) + 1;
  });
  hubRoom.status = 'finished';
  emitRoom(hubRoom);
}

function mafiaGSaveResult(room, winner) {
  mafiaGHistory.unshift({
    id: Math.random().toString(36).slice(2),
    roomId: room.id,
    winner,
    players: room.players.map((p) => ({ id: p.id, name: p.name, role: p.role, isAlive: p.isAlive, isBot: !!p.isBot })),
    logs: room.logs.slice(-10),
    completedAt: new Date().toISOString(),
  });
  mafiaGHistory.splice(50);
}

function mafiaGProcessNight(room) {
  const aliveMafia = room.players.filter((p) => p.role === 'MAFIA' && p.isAlive);
  const mafiaActions = aliveMafia.map((m) => room.actions[m.id]).filter(Boolean).filter((x) => x !== 'none');
  let mafiaTargetId = null;
  if (mafiaActions.length === aliveMafia.length && mafiaActions.length > 0) {
    const first = mafiaActions[0];
    if (mafiaActions.every((id) => id === first)) mafiaTargetId = first;
  }
  const doctor = room.players.find((p) => p.role === 'DOCTOR' && p.isAlive);
  const doctorTargetId = doctor ? room.actions[doctor.id] : null;
  const bodyguard = room.players.find((p) => p.role === 'BODYGUARD' && p.isAlive);
  const bodyguardTargetId = bodyguard ? room.actions[bodyguard.id] : null;
  let killed = null;
  if (mafiaTargetId && mafiaTargetId !== doctorTargetId) {
    if (mafiaTargetId === bodyguardTargetId && bodyguard) {
      bodyguard.isAlive = false;
      room.logs.push({ id: Math.random().toString(36).slice(2), text: `ضحى الحارس الشخصي ${bodyguard.name} بنفسه لحماية هدفه!`, type: 'system' });
    } else {
      const target = room.players.find((p) => p.id === mafiaTargetId);
      if (target) { target.isAlive = false; killed = target; }
    }
  }
  room.phase = 'DAY';
  room.actions = {};
  room.votes = {};
  const text = killed ? `استيقظت المدينة على خبر مفجع... تم العثور على جثة ${killed.name}.` : 'استيقظت المدينة... كانت ليلة هادئة ولم يمت أحد.';
  room.logs.push({ id: Math.random().toString(36).slice(2), text, type: 'system' });
  if (!mafiaGCheckWin(room)) {
    mafiaGStartTimer(room);
    mafiaGTriggerBotActions(room);
    mafiaGBroadcast(room, { type: 'ROOM_UPDATED' });
    mafiaGBroadcast(room, { type: 'NARRATOR_MESSAGE', payload: text });
  }
}

function mafiaGProcessDayVote(room) {
  const counts = {};
  Object.values(room.votes).forEach((targetId) => { counts[targetId] = (counts[targetId] || 0) + 1; });
  let maxVotes = 0;
  let eliminatedId = null;
  for (const [id, count] of Object.entries(counts)) {
    if (count > maxVotes) { maxVotes = count; eliminatedId = id; }
    else if (count === maxVotes) eliminatedId = null;
  }
  if (eliminatedId) {
    const target = room.players.find((p) => p.id === eliminatedId);
    if (target) {
      target.isAlive = false;
      room.logs.push({ id: Math.random().toString(36).slice(2), text: `قررت المدينة إعدام ${target.name}. كان دوره: ${target.role}`, type: 'system' });
      if (target.role === 'JESTER') {
        room.phase = 'GAME_OVER';
        if (room.timer) clearInterval(room.timer);
        room.logs.push({ id: Math.random().toString(36).slice(2), text: 'فاز المهرج! لقد تم إعدامه كما أراد.', type: 'win' });
        mafiaGSaveResult(room, 'المهرج');
        mafiaGBroadcast(room, { type: 'ROOM_UPDATED' });
        return;
      }
    }
  } else {
    room.logs.push({ id: Math.random().toString(36).slice(2), text: 'لم تتفق المدينة على أحد، لم يتم إعدام أحد اليوم.', type: 'system' });
  }
  if (!mafiaGCheckWin(room)) {
    room.phase = 'NIGHT';
    room.votes = {};
    room.actions = {};
    room.logs.push({ id: Math.random().toString(36).slice(2), text: 'حل الليل مرة أخرى...', type: 'system' });
    mafiaGStartTimer(room);
    mafiaGTriggerBotActions(room);
    mafiaGBroadcast(room, { type: 'ROOM_UPDATED' });
  }
}

const mafiaGWss = new WebSocketServer({ server: httpServer, path: '/mafia-ws' });
mafiaGWss.on('connection', (ws) => {
  let currentRoom = null;
  let playerId = null;

  ws.on('message', (data) => {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    const { type, payload = {} } = message;

    if (type === 'JOIN_ROOM') {
      currentRoom = normRoomCode(payload.roomId);
      playerId = String(payload.playerId || '').trim() || Math.random().toString(36).slice(2);
      const room = mafiaGRoom(currentRoom);
      const hubRoom = rooms.get(room.id);
      if (!room.hostId) room.hostId = hubRoom?.hostClientId || playerId;
      let player = room.players.find((p) => p.id === playerId);
      if (!player) {
        player = { id: playerId, name: safeName(payload.playerName, 'لاعب'), role: null, isAlive: true, ws };
        room.players.push(player);
      } else {
        player.name = safeName(payload.playerName, player.name);
        player.ws = ws;
      }
      if (hubRoom?.hostClientId === playerId) room.hostId = playerId;
      mafiaGBroadcast(room, { type: 'ROOM_UPDATED' });
      return;
    }

    if (!currentRoom) return;
    const room = mafiaGRoom(currentRoom);
    const isHostPlayer = room.hostId === playerId;

    if (type === 'UPDATE_SETTINGS') {
      if (isHostPlayer && room.phase === 'LOBBY') {
        room.settings = { ...room.settings, ...payload };
        mafiaGBroadcast(room, { type: 'ROOM_UPDATED' });
      }
      return;
    }

    if (type === 'ADD_BOT') {
      if (room.phase === 'LOBBY' && room.players.length < 12) {
        const botId = 'bot-' + Math.random().toString(36).slice(2);
        const name = MAFIA_G_BOT_NAMES[Math.floor(Math.random() * MAFIA_G_BOT_NAMES.length)] + '-' + (room.players.length + 1);
        room.players.push({ id: botId, name, role: null, isAlive: true, isBot: true, ws: null });
        mafiaGBroadcast(room, { type: 'ROOM_UPDATED' });
      }
      return;
    }

    if (type === 'START_GAME') {
      if ((isHostPlayer || room.players[0]?.id === playerId) && room.players.length >= 4) {
        mafiaGAssignRoles(room);
        room.phase = 'NIGHT';
        room.logs = [{ id: Math.random().toString(36).slice(2), text: 'بدأت اللعبة! حل الليل على المدينة...', type: 'system' }];
        room.votes = {};
        room.actions = {};
        mafiaGStartTimer(room);
        mafiaGTriggerBotActions(room);
        mafiaGBroadcast(room, { type: 'ROOM_UPDATED' });
        mafiaGBroadcast(room, { type: 'NARRATOR_MESSAGE', payload: 'بدأت اللعبة... حل الليل على المدينة. احذروا من الظلام.' });
      }
      return;
    }

    if (type === 'NIGHT_ACTION') {
      const player = room.players.find((p) => p.id === playerId);
      if (player && player.isAlive && room.phase === 'NIGHT') {
        if (player.role === 'BODYGUARD' && payload.targetId === playerId) return;
        room.actions[player.id] = payload.targetId;
        const aliveSpecial = room.players.filter((p) => p.isAlive && p.role !== 'VILLAGER');
        if (Object.keys(room.actions).length >= aliveSpecial.length) {
          if (room.timer) clearInterval(room.timer);
          mafiaGProcessNight(room);
        } else mafiaGBroadcast(room, { type: 'ROOM_UPDATED' });
      }
      return;
    }

    if (type === 'VOTE') {
      if (room.phase === 'DAY') {
        const voter = room.players.find((p) => p.id === playerId);
        if (!voter?.isAlive) return;
        room.votes[playerId] = payload.targetId;
        const alive = room.players.filter((p) => p.isAlive);
        if (Object.keys(room.votes).length >= alive.length) {
          if (room.timer) clearInterval(room.timer);
          mafiaGProcessDayVote(room);
        } else mafiaGBroadcast(room, { type: 'ROOM_UPDATED' });
      }
      return;
    }

    if (type === 'CHAT') {
      mafiaGBroadcast(room, { type: 'CHAT_MESSAGE', payload: { id: Math.random().toString(36).slice(2), playerId, playerName: safeName(payload.playerName, 'لاعب'), text: String(payload.text || '').slice(0, 240), timestamp: Date.now() } });
    }
  });

  ws.on('close', () => {
    if (!currentRoom || !playerId) return;
    const room = mafiaGRooms.get(currentRoom);
    if (!room) return;
    const p = room.players.find((x) => x.id === playerId);
    if (p) p.ws = null;
    if (room.phase === 'LOBBY') room.players = room.players.filter((x) => x.id !== playerId || x.isBot);
    if (room.players.filter((x) => !x.isBot).length === 0) {
      if (room.timer) clearInterval(room.timer);
      mafiaGRooms.delete(currentRoom);
    } else mafiaGBroadcast(room, { type: 'ROOM_UPDATED' });
  });
});


// =============================
// Out of the Loop engine
// =============================
const OUTLOOP_CATEGORIES = [
  { id: 'food', name: 'أكل ومطاعم', words: ['بيتزا','برجر','كبسة','سوشي','قهوة','شاورما','آيس كريم','باستا'] },
  { id: 'places', name: 'أماكن', words: ['مطار','مدرسة','مستشفى','استراحة','ملعب','مول','فندق','شاطئ'] },
  { id: 'things', name: 'أشياء', words: ['جوال','سيارة','ساعة','مفتاح','شنطة','كرسي','كاميرا','ريموت'] },
  { id: 'animals', name: 'حيوانات', words: ['أسد','قط','كلب','نمر','حصان','جمل','بطريق','دولفين'] },
];

function ensureOutloop(room) {
  if (!room.outloop) {
    room.outloop = {
      phase: 'lobby',
      players: [],
      categoryId: 'food',
      selectedWord: '',
      outsiderId: '',
      revealIndex: 0,
      timeLeft: 120,
      votes: {},
      result: null,
      timer: null,
    };
  }
  return room.outloop;
}

function outloopPlayers(room) {
  const o = ensureOutloop(room);
  const byId = new Map(o.players.map((p) => [p.clientId, p]));
  const live = room.players.map((p) => {
    const old = byId.get(p.clientId);
    return { clientId: p.clientId, name: p.name, isBot: false, connected: p.connected !== false, role: old?.role || 'inside' };
  });
  const bots = o.players.filter((p) => p.isBot);
  o.players = [...live, ...bots];
  return o.players;
}

function publicOutloopState(room, clientId = '') {
  const o = ensureOutloop(room);
  const players = outloopPlayers(room);
  const me = players.find((p) => p.clientId === clientId);
  const revealPlayer = players[o.revealIndex] || null;
  const shouldRevealMine = o.phase === 'reveal' && revealPlayer && revealPlayer.clientId === clientId;
  const result = o.result ? { ...o.result } : null;
  return {
    roomCode: room.code,
    isHost: String(clientId) === String(room.hostClientId),
    phase: o.phase,
    players: players.map((p) => ({ clientId: p.clientId, name: p.name, isBot: !!p.isBot, connected: p.connected !== false })),
    categories: OUTLOOP_CATEGORIES.map(({ id, name }) => ({ id, name })),
    categoryId: o.categoryId,
    revealIndex: o.revealIndex,
    revealPlayerId: revealPlayer?.clientId || null,
    timeLeft: o.timeLeft,
    votes: o.votes,
    myRole: me?.role || null,
    myWord: shouldRevealMine && me?.role === 'inside' ? o.selectedWord : (shouldRevealMine ? 'أنت برا السالفة' : null),
    result,
  };
}

function emitOutloop(room) {
  for (const p of room.players) io.to(p.socketId).emit('outloop:state', publicOutloopState(room, p.clientId));
  const o = ensureOutloop(room);
  for (const bot of o.players.filter((x) => x.isBot)) {}
  io.to(room.code).emit('outloop:publicState', publicOutloopState(room, ''));
}

function outloopStopTimer(o) {
  if (o.timer) clearInterval(o.timer);
  o.timer = null;
}

function outloopStartTimer(room) {
  const o = ensureOutloop(room);
  outloopStopTimer(o);
  o.timer = setInterval(() => {
    const r = rooms.get(room.code);
    if (!r) return outloopStopTimer(o);
    const state = ensureOutloop(r);
    if (state.phase !== 'playing') return outloopStopTimer(state);
    state.timeLeft -= 1;
    if (state.timeLeft <= 0) {
      state.timeLeft = 0;
      state.phase = 'voting';
      outloopStopTimer(state);
      emitOutloop(r);
      return;
    }
    io.to(r.code).emit('outloop:timer', { timeLeft: state.timeLeft });
  }, 1000);
}

function outloopStart(room, data = {}) {
  const o = ensureOutloop(room);
  outloopStopTimer(o);
  o.phase = 'reveal';
  o.players = outloopPlayers(room);
  if (room.devMode && o.players.length < 3) {
    while (o.players.length < 3) o.players.push({ clientId: 'out-bot-' + Math.random().toString(36).slice(2), name: 'بوت ' + (o.players.length + 1), isBot: true, role: 'inside', connected: true });
  }
  if (o.players.length < 3) return false;
  const cat = OUTLOOP_CATEGORIES.find((c) => c.id === (data.categoryId || o.categoryId)) || OUTLOOP_CATEGORIES[0];
  o.categoryId = cat.id;
  o.selectedWord = cat.words[Math.floor(Math.random() * cat.words.length)];
  const outsider = o.players[Math.floor(Math.random() * o.players.length)];
  o.players.forEach((p) => { p.role = p.clientId === outsider.clientId ? 'outside' : 'inside'; });
  o.outsiderId = outsider.clientId;
  o.revealIndex = 0;
  o.timeLeft = Number(data.timeLeft || 120);
  o.votes = {};
  o.result = null;
  return true;
}

function outloopFinishVote(room, votedId) {
  const o = ensureOutloop(room);
  const players = outloopPlayers(room);
  const caught = String(votedId) === String(o.outsiderId);
  o.phase = 'result';
  o.result = {
    votedId,
    outsiderId: o.outsiderId,
    outsiderName: players.find((p) => p.clientId === o.outsiderId)?.name || 'Unknown',
    word: o.selectedWord,
    caught,
    winnerTeam: caught ? 'inside' : 'outside',
  };
  if (caught) {
    players.filter((p) => p.role === 'inside' && !p.isBot).forEach((winner) => {
      const hp = room.players.find((p) => p.clientId === winner.clientId);
      if (hp) hp.score = Number(hp.score || 0) + 1;
    });
  } else {
    const hp = room.players.find((p) => p.clientId === o.outsiderId);
    if (hp) hp.score = Number(hp.score || 0) + 1;
  }
  room.status = 'finished';
  emitRoom(room);
}

// =============================
// Conqueror engine
// =============================
const CONQ_COLORS = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316'];
function conqMap() {
  return {
    t1: { id: 't1', name: 'Northlands', ownerId: null, armies: 0, neighbors: ['t2','t4'], type: 'mountain' },
    t2: { id: 't2', name: 'Green Valley', ownerId: null, armies: 0, neighbors: ['t1','t3','t5'], type: 'forest' },
    t3: { id: 't3', name: 'East Coast', ownerId: null, armies: 0, neighbors: ['t2','t6'], type: 'plains' },
    t4: { id: 't4', name: 'West Reach', ownerId: null, armies: 0, neighbors: ['t1','t5','t7'], type: 'plains' },
    t5: { id: 't5', name: 'Central Hub', ownerId: null, armies: 0, neighbors: ['t2','t4','t6','t8'], type: 'plains' },
    t6: { id: 't6', name: 'Shadow Woods', ownerId: null, armies: 0, neighbors: ['t3','t5','t9'], type: 'forest' },
    t7: { id: 't7', name: 'South Peak', ownerId: null, armies: 0, neighbors: ['t4','t8'], type: 'mountain' },
    t8: { id: 't8', name: 'Iron Hills', ownerId: null, armies: 0, neighbors: ['t5','t7','t9'], type: 'mountain' },
    t9: { id: 't9', name: 'Sunken Marsh', ownerId: null, armies: 0, neighbors: ['t6','t8'], type: 'forest' },
  };
}
function ensureConqueror(room) {
  if (!room.conqueror) room.conqueror = { status: 'lobby', players: {}, territories: conqMap(), turn: 0, winnerId: null, resourceTimer: null };
  return room.conqueror;
}
function conqSyncPlayers(room) {
  const c = ensureConqueror(room);
  room.players.forEach((p, idx) => {
    if (!c.players[p.clientId]) c.players[p.clientId] = { id: p.clientId, name: p.name, color: CONQ_COLORS[idx % CONQ_COLORS.length], resources: { gold: 100, wood: 50, iron: 50 }, armies: 10 };
    c.players[p.clientId].name = p.name;
  });
  Object.keys(c.players).forEach((id) => {
    if (!room.players.some((p) => p.clientId === id) && !id.startsWith('conq-bot-')) delete c.players[id];
  });
  return c;
}
function publicConqState(room, clientId = '') {
  const c = conqSyncPlayers(room);
  return { roomCode: room.code, isHost: String(clientId) === String(room.hostClientId), status: c.status, players: c.players, territories: c.territories, turn: c.turn, winnerId: c.winnerId };
}
function emitConq(room) {
  for (const p of room.players) io.to(p.socketId).emit('conqueror:state', publicConqState(room, p.clientId));
  io.to(room.code).emit('conqueror:publicState', publicConqState(room, ''));
}
function conqStart(room) {
  const c = ensureConqueror(room);
  conqSyncPlayers(room);
  if (room.devMode && Object.keys(c.players).length < 2) {
    const id = 'conq-bot-' + Math.random().toString(36).slice(2);
    c.players[id] = { id, name: 'Bot Commander', color: CONQ_COLORS[1], resources: { gold: 100, wood: 50, iron: 50 }, armies: 10 };
  }
  if (Object.keys(c.players).length < 2) return false;
  c.status = 'playing';
  c.territories = conqMap();
  c.turn = 0;
  c.winnerId = null;
  const territoryIds = Object.keys(c.territories);
  Object.keys(c.players).forEach((pid, idx) => {
    const t = c.territories[territoryIds[idx % territoryIds.length]];
    t.ownerId = pid;
    t.armies = 5;
  });
  if (c.resourceTimer) clearInterval(c.resourceTimer);
  c.resourceTimer = setInterval(() => {
    const r = rooms.get(room.code);
    if (!r) return clearInterval(c.resourceTimer);
    const state = ensureConqueror(r);
    if (state.status !== 'playing') return;
    Object.values(state.players).forEach((player) => {
      player.resources.gold += 5;
      const owned = Object.values(state.territories).filter((t) => t.ownerId === player.id);
      player.resources.gold += owned.length * 2;
      owned.forEach((t) => {
        if (t.type === 'forest') player.resources.wood += 2;
        if (t.type === 'mountain') player.resources.iron += 2;
        if (t.type === 'plains') player.resources.gold += 1;
      });
    });
    emitConq(r);
  }, 5000);
  return true;
}
function conqCheckWinner(room) {
  const c = ensureConqueror(room);
  const totals = {};
  Object.values(c.territories).forEach((t) => { if (t.ownerId) totals[t.ownerId] = (totals[t.ownerId] || 0) + 1; });
  const top = Object.entries(totals).sort((a,b)=>b[1]-a[1])[0];
  if (top && top[1] >= Object.keys(c.territories).length) {
    c.status = 'ended'; c.winnerId = top[0]; room.status = 'finished';
    const hp = room.players.find((p) => p.clientId === c.winnerId); if (hp) hp.score = Number(hp.score || 0) + 1;
    emitRoom(room);
  }
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
      if (room.outloop) emitOutloop(room);
      if (room.conqueror) emitConq(room);
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


  socket.on('outloop:getState', (data = {}) => {
    const room = rooms.get(normRoomCode(data.roomCode));
    if (!room) return socket.emit('game:error', { message: 'الغرفة غير موجودة' });
    socket.join(room.code);
    socket.emit('room:state', roomInfo(room));
    socket.emit('outloop:state', publicOutloopState(room, getClientId(socket, data)));
  });

  socket.on('outloop:setCategory', (data = {}) => {
    const room = rooms.get(normRoomCode(data.roomCode));
    if (!room || !isHost(room, socket, data)) return;
    const o = ensureOutloop(room);
    if (OUTLOOP_CATEGORIES.some((c) => c.id === data.categoryId)) o.categoryId = data.categoryId;
    emitOutloop(room);
  });

  socket.on('outloop:start', (data = {}) => {
    const room = rooms.get(normRoomCode(data.roomCode));
    if (!room || !isHost(room, socket, data)) return;
    room.selectedGame = 'out-of-loop';
    const prevStatus = room.status;
    room.status = 'playing';
    if (!outloopStart(room, data)) { room.status = prevStatus; emitRoom(room); return socket.emit('game:error', { message: 'تحتاج 3 لاعبين أو فعّل Dev Mode' }); }
    io.to(room.code).emit('game:started', { roomCode: room.code, gameId: 'out-of-loop' });
    emitRoom(room); emitOutloop(room);
  });

  socket.on('outloop:nextReveal', (data = {}) => {
    const room = rooms.get(normRoomCode(data.roomCode));
    if (!room) return;
    const o = ensureOutloop(room);
    const players = outloopPlayers(room);
    if (o.phase !== 'reveal') return;
    if (o.revealIndex < players.length - 1) o.revealIndex += 1;
    else { o.phase = 'playing'; outloopStartTimer(room); }
    emitOutloop(room);
  });

  socket.on('outloop:voteStart', (data = {}) => {
    const room = rooms.get(normRoomCode(data.roomCode));
    if (!room || !isHost(room, socket, data)) return;
    const o = ensureOutloop(room);
    o.phase = 'voting'; outloopStopTimer(o); emitOutloop(room);
  });

  socket.on('outloop:vote', (data = {}) => {
    const room = rooms.get(normRoomCode(data.roomCode));
    if (!room) return;
    const o = ensureOutloop(room);
    if (o.phase !== 'voting') return;
    const cid = getClientId(socket, data);
    const targetId = String(data.targetId || '');
    o.votes[cid] = targetId;
    const realPlayers = outloopPlayers(room).filter((p) => !p.isBot);
    if (Object.keys(o.votes).length >= Math.max(1, realPlayers.length)) {
      const counts = {};
      Object.values(o.votes).forEach((v) => { counts[v] = (counts[v] || 0) + 1; });
      const votedId = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0]?.[0] || targetId;
      outloopFinishVote(room, votedId);
    }
    emitOutloop(room);
  });

  socket.on('outloop:reset', (data = {}) => {
    const room = rooms.get(normRoomCode(data.roomCode));
    if (!room || !isHost(room, socket, data)) return;
    const o = ensureOutloop(room); outloopStopTimer(o); room.outloop = null; room.status = 'waiting'; emitRoom(room); emitOutloop(room);
  });

  socket.on('conqueror:getState', (data = {}) => {
    const room = rooms.get(normRoomCode(data.roomCode));
    if (!room) return socket.emit('game:error', { message: 'الغرفة غير موجودة' });
    socket.join(room.code);
    socket.emit('room:state', roomInfo(room));
    socket.emit('conqueror:state', publicConqState(room, getClientId(socket, data)));
  });

  socket.on('conqueror:start', (data = {}) => {
    const room = rooms.get(normRoomCode(data.roomCode));
    if (!room || !isHost(room, socket, data)) return;
    room.selectedGame = 'conqueror'; const prevStatus = room.status; room.status = 'playing';
    if (!conqStart(room)) { room.status = prevStatus; emitRoom(room); return socket.emit('game:error', { message: 'Conqueror تحتاج لاعبين أو Dev Mode' }); }
    io.to(room.code).emit('game:started', { roomCode: room.code, gameId: 'conqueror' });
    emitRoom(room); emitConq(room);
  });

  socket.on('conqueror:recruit', (data = {}) => {
    const room = rooms.get(normRoomCode(data.roomCode)); if (!room) return;
    const c = ensureConqueror(room); const cid = getClientId(socket, data); const p = c.players[cid];
    const count = Math.max(1, Math.min(20, Number(data.count || 1))); const cost = count * 10;
    if (p && p.resources.gold >= cost) { p.resources.gold -= cost; p.armies += count; emitConq(room); }
  });

  socket.on('conqueror:capture', (data = {}) => {
    const room = rooms.get(normRoomCode(data.roomCode)); if (!room) return;
    const c = ensureConqueror(room); if (c.status !== 'playing') return;
    const cid = getClientId(socket, data); const p = c.players[cid]; const t = c.territories[String(data.territoryId || '')];
    if (!p || !t) return;
    if (t.ownerId === cid) { if (p.armies > 0) { p.armies -= 1; t.armies += 1; } }
    else if (!t.ownerId && p.armies > 0) { t.ownerId = cid; t.armies = 1; p.armies -= 1; }
    else if (t.ownerId !== cid) {
      const adjacent = Object.values(c.territories).some((x) => x.ownerId === cid && x.neighbors.includes(t.id));
      if (adjacent && p.armies > 1) {
        if (p.armies > t.armies) { p.armies -= (t.armies + 1); t.ownerId = cid; t.armies = 1; }
        else { t.armies = Math.max(1, t.armies - (p.armies - 1)); p.armies = 1; }
      }
    }
    conqCheckWinner(room); emitConq(room);
  });

  socket.on('conqueror:finish', (data = {}) => {
    const room = rooms.get(normRoomCode(data.roomCode)); if (!room || !isHost(room, socket, data)) return;
    const c = ensureConqueror(room); const totals = {};
    Object.values(c.territories).forEach((t) => { if (t.ownerId) totals[t.ownerId] = (totals[t.ownerId] || 0) + 1; });
    const winner = Object.entries(totals).sort((a,b)=>b[1]-a[1])[0]?.[0];
    if (winner) { c.status = 'ended'; c.winnerId = winner; room.status = 'finished'; const hp = room.players.find((p)=>p.clientId===winner); if (hp) hp.score = Number(hp.score||0)+1; emitRoom(room); emitConq(room); }
  });

  socket.on('conqueror:reset', (data = {}) => {
    const room = rooms.get(normRoomCode(data.roomCode)); if (!room || !isHost(room, socket, data)) return;
    const c = ensureConqueror(room); if (c.resourceTimer) clearInterval(c.resourceTimer); room.conqueror = null; room.status = 'waiting'; emitRoom(room); emitConq(room);
  });

  socket.on('mafia:getState', (data = {}) => {
    const room = rooms.get(normRoomCode(data.roomCode));
    if (!room) return socket.emit('game:error', { message: 'الغرفة غير موجودة' });
    socket.join(room.code);
    socket.emit('room:state', roomInfo(room));
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
app.get('/api/history', (req, res) => res.json(mafiaGHistory));
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
