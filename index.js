import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);

// اسمح للواجهة على www + بدون www
const ALLOWED_ORIGINS = [
  "https://www.gamehub4u.com",
  "https://gamehub4u.com",
];

// health للتأكد بسرعة
app.get("/", (req, res) => res.status(200).send("Gamehub server is running ✅"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"],
  },
});

// ====== State (غرف بسيطة) ======
const rooms = new Map();

function normalizeRoom(x) {
  return String(x || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

function ensureRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      roomCode: code,
      hostClientId: null,
      players: new Map(), // clientId -> {clientId,name,ready,socketId}
      devMode: false,
      mafia: {
        started: false,
        phase: "role",
        round: 0,
        winnerTeam: null,
        assignments: {}, // clientId -> role
        alive: {},       // clientId -> boolean
        lastResult: null,
        investigationResult: null,
      },
    });
  }
  return rooms.get(code);
}

function roomState(room) {
  return {
    roomCode: room.roomCode,
    hostClientId: room.hostClientId || null,
    devMode: !!room.devMode,
    players: Array.from(room.players.values()).map((p) => ({
      clientId: p.clientId,
      name: p.name,
      ready: !!p.ready,
    })),
  };
}

function mafiaPublicState(room, viewerClientId) {
  const m = room.mafia;

  const aliveList = Array.from(room.players.values()).map((p) => ({
    clientId: p.clientId,
    name: p.name,
    alive: !!m.alive[p.clientId],
  }));

  const viewerIsHost = viewerClientId && viewerClientId === room.hostClientId;

  return {
    roomCode: room.roomCode,
    started: !!m.started,
    phase: m.phase,
    round: m.round,
    winnerTeam: m.winnerTeam || null,
    canAdvance: !!viewerIsHost,
    myRole: m.assignments[viewerClientId] || null,
    alive: aliveList,
    lastResult: m.lastResult || null,
    investigationResult: m.investigationResult || null,
    devMode: !!room.devMode,
  };
}

function broadcastRoom(room) {
  io.to(room.roomCode).emit("room:state", roomState(room));
}

function broadcastMafia(room) {
  for (const p of room.players.values()) {
    io.to(p.socketId).emit("mafia:state", mafiaPublicState(room, p.clientId));
  }
}

function safeRoleName(x) {
  const r = String(x || "").trim().toLowerCase();
  const allowed = new Set(["mafia", "detective", "doctor", "villager"]);
  return allowed.has(r) ? r : null;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function aliveIds(room) {
  return Object.keys(room.mafia.alive).filter((cid) => room.mafia.alive[cid]);
}

// ====== Socket Events ======
io.on("connection", (socket) => {
  const clientId = String(socket.handshake?.auth?.clientId || "").trim();

  // Host creates room
  socket.on("host:createRoom", () => {
    const code = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(2, 6);
    const roomCode = normalizeRoom(code);
    const room = ensureRoom(roomCode);

    room.hostClientId = clientId || room.hostClientId;
    socket.join(roomCode);
    socket.emit("room:created", { roomCode });
    socket.emit("host:attached", { roomCode });

    broadcastRoom(room);
    broadcastMafia(room);
  });

  // Host attach existing room
  socket.on("host:attach", ({ roomCode }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room) return socket.emit("host:attach:error", { message: "ROOM_NOT_FOUND" });

    room.hostClientId = clientId || room.hostClientId;
    socket.join(code);
    socket.emit("host:attached", { roomCode: code });

    broadcastRoom(room);
    broadcastMafia(room);
  });

  // Host set dev mode
  socket.on("host:setDevMode", ({ roomCode, enabled }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room) return;
    if (room.hostClientId !== clientId) return;

    room.devMode = !!enabled;
    broadcastRoom(room);
    broadcastMafia(room);
  });

  // Host joins as player
  socket.on("host:joinAsPlayer", ({ roomCode, name }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room) return;
    const nm = String(name || "Host").trim().slice(0, 20);

    room.players.set(clientId, { clientId, name: nm, ready: true, socketId: socket.id });
    socket.join(code);

    broadcastRoom(room);
    broadcastMafia(room);
  });

  // Player join
  socket.on("player:join", ({ roomCode, name, clientId: cid }) => {
    const code = normalizeRoom(roomCode);
    const room = ensureRoom(code);
    const playerId = String(cid || clientId || "").trim();
    if (!playerId) return socket.emit("join:error", { message: "NO_CLIENT_ID" });

    const nm = String(name || "Player").trim().slice(0, 20);
    room.players.set(playerId, { clientId: playerId, name: nm, ready: false, socketId: socket.id });

    socket.join(code);
    socket.emit("player:joined", { roomCode: code });

    broadcastRoom(room);
    broadcastMafia(room);
  });

  // Player attach (for lobby/mafia pages refresh)
  socket.on("player:attach", ({ roomCode, clientId: cid }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room) return socket.emit("room:error", { message: "ROOM_NOT_FOUND" });

    const playerId = String(cid || clientId || "").trim();
    const p = room.players.get(playerId);
    if (p) {
      p.socketId = socket.id;
      room.players.set(playerId, p);
    }
    socket.join(code);
    broadcastRoom(room);
    broadcastMafia(room);
  });

  // Ready toggle
  socket.on("player:ready", ({ roomCode, ready, clientId: cid }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room) return;

    const playerId = String(cid || clientId || "").trim();
    const p = room.players.get(playerId);
    if (!p) return;

    p.ready = !!ready;
    room.players.set(playerId, p);

    broadcastRoom(room);
  });

  socket.on("room:getState", ({ roomCode }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room) return socket.emit("room:error", { message: "ROOM_NOT_FOUND" });
    socket.emit("room:state", roomState(room));
  });

  socket.on("mafia:getState", ({ roomCode, clientId: cid }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room) return;
    const viewerId = String(cid || clientId || "").trim();
    socket.emit("mafia:state", mafiaPublicState(room, viewerId));
  });

  // Start Mafia
  socket.on("mafia:start", ({ roomCode }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room) return;
    if (room.hostClientId !== clientId) return;

    const players = Array.from(room.players.values());
    const n = players.length;
    const minPlayers = room.devMode ? 2 : 5;
    if (n < minPlayers) {
      return socket.emit("start:error", { message: "NEED_MIN_PLAYERS", minPlayers });
    }

    const mafiaCount = n <= 3 ? 1 : Math.max(1, Math.floor((n - 1) / 3));
    const roles = [];

    for (let i = 0; i < mafiaCount; i++) roles.push("mafia");
    if (n >= 3) roles.push("detective");
    if (n >= 3) roles.push("doctor");
    while (roles.length < n) roles.push("villager");

    shuffle(roles);

    const m = room.mafia;
    m.started = true;
    m.phase = "night";
    m.round = 1;
    m.winnerTeam = null;
    m.lastResult = null;
    m.investigationResult = null;
    m.assignments = {};
    m.alive = {};

    players.forEach((p, i) => {
      m.assignments[p.clientId] = roles[i];
      m.alive[p.clientId] = true;
      io.to(p.socketId).emit("mafia:role", { roomCode: code, role: roles[i] });
    });

    broadcastMafia(room);
  });

  // Next phase (host)
  socket.on("mafia:next", ({ roomCode }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room) return;
    if (room.hostClientId !== clientId) return;

    const m = room.mafia;
    if (!m.started) return;

    // cycle: night -> day -> night ...
    if (m.phase === "night") m.phase = "day";
    else {
      m.phase = "night";
      m.round += 1;
    }

    broadcastMafia(room);
  });

  // Night action
  socket.on("mafia:nightAction", ({ roomCode, clientId: cid, action, targetId }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room) return;

    const m = room.mafia;
    if (!m.started || m.phase !== "night") return;

    const actor = String(cid || clientId || "").trim();
    const tgt = String(targetId || "").trim();
    if (!m.alive[actor] || !m.alive[tgt]) return;

    const myRole = m.assignments[actor];
    if (!myRole) return;

    // For demo: store lastResult
    if (action === "kill" && myRole === "mafia") {
      m.alive[tgt] = false;
      m.lastResult = { nightKill: tgt };
    }
    if (action === "save" && myRole === "doctor") {
      m.alive[tgt] = true;
      m.lastResult = { doctorSaved: tgt };
    }
    if (action === "check" && myRole === "detective") {
      m.investigationResult = { targetId: tgt, isMafia: m.assignments[tgt] === "mafia" };
      m.lastResult = { detectiveChecked: tgt };
    }

    broadcastMafia(room);
  });

  // Day vote (simple)
  socket.on("mafia:vote", ({ roomCode, clientId: cid, targetId }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room) return;

    const m = room.mafia;
    if (!m.started || m.phase !== "day") return;

    const actor = String(cid || clientId || "").trim();
    const tgt = String(targetId || "").trim();
    if (!m.alive[actor] || !m.alive[tgt]) return;

    m.alive[tgt] = false;
    m.lastResult = { dayVotedOut: tgt };

    broadcastMafia(room);
  });

  // Dev: reveal all
  socket.on("mafia:revealAll", ({ roomCode }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room || !room.mafia?.started) return;
    if (room.hostClientId !== clientId) return;
    if (!room.devMode) return;

    const m = room.mafia;
    const list = Object.keys(m.assignments).map((cid) => ({
      clientId: cid,
      name: room.players.get(cid)?.name || "Player",
      role: m.assignments[cid],
      alive: !!m.alive[cid],
    }));

    socket.emit("mafia:reveal", { roomCode: code, list });
  });

  // Dev: set role
  socket.on("mafia:setRole", ({ roomCode, targetId, role }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room || !room.mafia?.started) return;
    if (room.hostClientId !== clientId) return;
    if (!room.devMode) return;

    const m = room.mafia;
    const tgt = String(targetId || "").trim();
    const r = safeRoleName(role);
    if (!tgt || !m.assignments[tgt] || !r) return;

    m.assignments[tgt] = r;
    const psid = room.players.get(tgt)?.socketId;
    if (psid) io.to(psid).emit("mafia:role", { roomCode: code, role: r });

    broadcastMafia(room);
  });

  // Dev: toggle alive
  socket.on("mafia:toggleAlive", ({ roomCode, targetId }) => {
    const code = normalizeRoom(roomCode);
    const room = rooms.get(code);
    if (!room || !room.mafia?.started) return;
    if (room.hostClientId !== clientId) return;
    if (!room.devMode) return;

    const m = room.mafia;
    const tgt = String(targetId || "").trim();
    if (!tgt || typeof m.alive[tgt] !== "boolean") return;

    m.alive[tgt] = !m.alive[tgt];
    broadcastMafia(room);
  });
});

// ====== Start ======
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server listening on", PORT));
