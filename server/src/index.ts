// Servidor: Colyseus (multiplayer) + HTTP /token (LiveKit) + cliente estatico.
import path from "path";
import { createServer } from "http";
import express from "express";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { AccessToken } from "livekit-server-sdk";
import { OfficeRoom } from "./rooms/OfficeRoom";
import { loadBoard } from "./board/store";
import { login } from "./progress/store";
import { getFlags } from "./gamification/flags";

// Carrega server/.env (chaves do LiveKit), se existir. Node 20.12+/26.
try {
  process.loadEnvFile();
} catch {
  /* sem .env — voz fica desativada ate configurar */
}

const port = Number(process.env.PORT ?? 2567);
const LK_URL = process.env.LIVEKIT_URL;
const LK_KEY = process.env.LIVEKIT_API_KEY;
const LK_SECRET = process.env.LIVEKIT_API_SECRET;
const voiceReady = !!(LK_URL && LK_KEY && LK_SECRET);

const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, voice: voiceReady });
});

// Feature flags da gamificacao — o cliente le isto no boot e so liga cada feature
// se o flag estiver on. O dono desliga qualquer coisa setando GAMIF_X=0 no Coolify.
app.get("/config", (_req, res) => {
  res.json({ flags: getFlags() });
});

// Token do LiveKit (assinado com a Secret — nunca exposta ao cliente).
app.get("/token", async (req, res) => {
  if (!voiceReady) {
    res.status(503).json({ error: "voz não configurada (faltam chaves LiveKit)" });
    return;
  }
  const identity = String(req.query.identity ?? "guest");
  const name = String(req.query.name ?? "Convidado");
  const at = new AccessToken(LK_KEY, LK_SECRET, { identity, name, ttl: "12h" });
  at.addGrant({ roomJoin: true, room: "office", canPublish: true, canSubscribe: true });
  res.json({ token: await at.toJwt(), url: LK_URL });
});

// Lista de membros (pro dropdown de login) — nomes do registro de membros do board.
app.get("/members", async (_req, res) => {
  try {
    const board = await loadBoard();
    res.json({ members: board.members.map((m) => m.name).filter(Boolean) });
  } catch {
    res.json({ members: [] });
  }
});

// Login por nome + PIN (1o acesso define o PIN; depois confere). Nunca expoe o hash.
app.post("/login", (req, res) => {
  const body = (req.body ?? {}) as { member?: unknown; pin?: unknown };
  res.json(login(String(body.member ?? ""), String(body.pin ?? "")));
});

// Cliente estatico (build do Vite). __dirname = server/dist -> ../../client/dist
const clientDist = path.join(__dirname, "..", "..", "client", "dist");
app.use(express.static(clientDist));

const httpServer = createServer(app);
const gameServer = new Server({ transport: new WebSocketTransport({ server: httpServer }) });
gameServer.define("office", OfficeRoom);

gameServer
  .listen(port)
  .then(() =>
    console.log(
      `[server] Colyseus + HTTP em :${port} — voz: ${voiceReady ? "configurada ✓" : "OFF (sem chaves)"}`,
    ),
  )
  .catch((err) => {
    console.error("[server] erro:", err);
    process.exit(1);
  });
