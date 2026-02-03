import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);

app.get("/health", (req, res) => res.status(200).json({ ok: true }));

const io = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      // بعض الطلبات تجي بدون Origin
      if (!origin) return cb(null, true);

      // اسمح لأي دومين ينتهي بـ gamehub4u.com (يشمل www وأي subdomain مستقبلاً)
      try {
        const host = new URL(origin).hostname.toLowerCase();
        if (host === "gamehub4u.com" || host.endsWith(".gamehub4u.com")) {
          return cb(null, true);
        }
      } catch (_) {}

      return cb(null, false);
    },
    methods: ["GET", "POST"],
  },
});

io.on("connection", (socket) => {
  // هنا الصق أحداث لعبتك (اللي كانت عندك) إذا كانت موجودة بملف ثاني لا تلمسه
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server listening on", PORT));
