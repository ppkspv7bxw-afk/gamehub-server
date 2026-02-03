import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);

// ✅ خليها في Render ENV: SITE_ORIGIN
// مثال: https://www.gamehub4u.com,https://gamehub4u.com
const SITE_ORIGIN = process.env.SITE_ORIGIN || "https://www.gamehub4u.com,https://gamehub4u.com";
const ALLOWED = SITE_ORIGIN.split(",").map(s => s.trim()).filter(Boolean);

app.get("/", (req, res) => res.status(200).send("Gamehub server is running ✅"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

const io = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      return cb(null, ALLOWED.includes(origin));
    },
    methods: ["GET", "POST"]
  }
});

// ====== مثال بسيط (إذا عندك كود غرف/مافيا سابق، اتركه كما هو بعد هذا) ======
io.on("connection", (socket) => {
  socket.emit("hello", { ok: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server listening on", PORT));
