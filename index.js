import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);

const SITE_ORIGIN = process.env.SITE_ORIGIN || "https://www.gamehub4u.com";

const io = new Server(server, {
  cors: { origin: SITE_ORIGIN, methods: ["GET", "POST"] },
});

app.get("/", (req, res) => res.send("Gamehub server is running ✅"));

io.on("connection", (socket) => {
  socket.emit("hello", { ok: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server listening on", PORT));
