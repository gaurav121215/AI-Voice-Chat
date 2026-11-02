import "dotenv/config";
import http from "http";
import { WebSocketServer } from "ws";
import { Session } from "./session.js";

for (const k of ["DEEPGRAM_API_KEY", "LLM_API_KEY"]) {
  if (!process.env[k])
    console.warn(
      `[warn] ${k} is not set - copy server/.env.example to server/.env`,
    );
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.end("ok");
    return;
  }
  res.statusCode = 404;
  res.end();
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 1 << 20 });

wss.on("connection", (ws) => {
  const session = new Session(ws);
  ws.on("message", (data, isBinary) => {
    if (isBinary) session.audio(data as Buffer);
    else session.control(data.toString());
  });
  ws.on("close", () => session.stop(true));
  ws.on("error", () => session.stop(true));
});

const port = Number(process.env.PORT || 8000);
server.listen(port, () =>
  console.log(`server listening on :${port} (ws path /ws)`),
);
