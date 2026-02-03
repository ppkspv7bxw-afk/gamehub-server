import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);

const SITE_ORIGIN =
  process.env.SITE_ORIGIN || "https://gamehub4u.com,https://www.gamehub4u.com";
const ALLOWED = SITE_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);

app.get("/health", (req, res) => res.status(200).json({ ok: true }));

const io = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      cb(null, ALLOWED.includes(origin));
    },
    methods: ["GET", "POST"],
  },
});

io.on("connection", (socket) => {
  // إذا عندك أحداث لعبتك القديمة، الصقها هنا مكان هذا التعليق
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server listening on", PORT));
