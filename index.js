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
const players = new Map();

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
      name: p.name,
      isHost: p.id === room.host
    })),
    status: room.status,
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
  
  const clientId = socket.handshake.auth.clientId || socket.id;
  players.set(socket.id, { clientId, socket });

  // ==========================================
  // HOST: Create Room
  // ==========================================
  socket.on('host:createRoom', (data) => {
    console.log(`🎮 Host creating room:`, data);
    
    const roomCode = generateRoomCode();
    const room = {
      code: roomCode,
      host: socket.id,
      players: [],
      status: 'waiting',
      createdAt: Date.now(),
      gameData: null
    };
    
    rooms.set(roomCode, room);
    socket.join(roomCode);
    
    console.log(`✅ Room created: ${roomCode} by ${socket.id}`);
    
    // إرسال الكود للـ Host
    socket.emit('host:roomCreated', { roomCode });
    socket.emit('room:created', { roomCode });
  });

  // ==========================================
  // ROOM: Check if exists
  // ==========================================
  socket.on('room:check', (data, callback) => {
    const { roomCode } = data;
    const exists = rooms.has(roomCode);
    
    console.log(`🔍 Checking room ${roomCode}: ${exists ? 'EXISTS' : 'NOT FOUND'}`);
    
    if (callback && typeof callback === 'function') {
      callback({ exists, roomCode });
    }
  });

  // ==========================================
  // PLAYER: Join Room
  // ==========================================
  socket.on('player:join', (data) => {
    const { roomCode, name, clientId } = data;
    
    console.log(`👤 Player trying to join:`, { roomCode, name, socketId: socket.id });
    
    const room = rooms.get(roomCode);
    
    if (!room) {
      console.log(`❌ Room not found: ${roomCode}`);
      socket.emit('join:error', { 
        message: 'الغرفة غير موجودة - تحقق من الكود' 
      });
      return;
    }
    
    // Check if player already in room
    const existingPlayer = room.players.find(p => p.id === socket.id || p.clientId === clientId);
    
    if (existingPlayer) {
      console.log(`⚠️  Player already in room: ${name}`);
      socket.join(roomCode);
      socket.emit('player:joined', { roomCode, player: existingPlayer });
      return;
    }
    
    // Add player to room
    const player = {
      id: socket.id,
      clientId: clientId || socket.id,
      name: name || 'لاعب',
      joinedAt: Date.now(),
      isReady: false
    };
    
    room.players.push(player);
    socket.join(roomCode);
    
    console.log(`✅ Player joined: ${name} → ${roomCode} (${room.players.length} players)`);
    
    // Notify player
    socket.emit('player:joined', { roomCode, player });
    
    // Notify everyone in room
    const roomInfo = getRoomInfo(roomCode);
    io.to(roomCode).emit('players:update', roomInfo);
    io.to(roomCode).emit('room:update', roomInfo);
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
  // GAME: Start
  // ==========================================
  socket.on('game:start', (data) => {
    const { roomCode } = data;
    const room = rooms.get(roomCode);
    
    if (!room) {
      socket.emit('game:error', { message: 'الغرفة غير موجودة' });
      return;
    }
    
    if (room.host !== socket.id) {
      socket.emit('game:error', { message: 'فقط المستضيف يمكنه بدء اللعبة' });
      return;
    }
    
    room.status = 'playing';
    console.log(`🎮 Game started in room: ${roomCode}`);
    
    io.to(roomCode).emit('game:started', { roomCode });
  });

  // ==========================================
  // DISCONNECT
  // ==========================================
  socket.on('disconnect', () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
    
    // Find and remove player from all rooms
    for (const [roomCode, room] of rooms.entries()) {
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      
      if (playerIndex !== -1) {
        const player = room.players[playerIndex];
        room.players.splice(playerIndex, 1);
        
        console.log(`👋 ${player.name} left room ${roomCode}`);
        
        // If host left, assign new host or delete room
        if (room.host === socket.id) {
          if (room.players.length > 0) {
            room.host = room.players[0].id;
            console.log(`👑 New host assigned: ${room.players[0].name}`);
          } else {
            rooms.delete(roomCode);
            console.log(`🗑️  Room deleted: ${roomCode} (empty)`);
            continue;
          }
        }
        
        // Notify remaining players
        const roomInfo = getRoomInfo(roomCode);
        io.to(roomCode).emit('players:update', roomInfo);
        io.to(roomCode).emit('player:left', { 
          playerId: socket.id,
          playerName: player.name 
        });
      }
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
