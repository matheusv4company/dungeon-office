// Servidor: Colyseus (multiplayer) + HTTP /token (LiveKit) + cliente estatico.
import path from "path";
import { createServer } from "http";
import express from "express";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { AccessToken } from "livekit-server-sdk";
import { OfficeRoom } from "./rooms/OfficeRoom";
import { loadBoard } from "./board/store";
import { login, normId } from "./progress/store";
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

// Rate-limit por membro contra brute-force de PIN (espaco pequeno, 4-8 digitos). Em memoria
// (some no restart). Backoff PROGRESSIVO: a cada bloqueio o cooldown dobra (30s,1m,2m,...,1h) e
// o contador de bloqueios NAO zera — entao tentar de novo so endurece a trava (forca bruta vira
// inviavel). Limpa o Map quando ele cresce (spray de nomes).
const loginGate = new Map<string, { fails: number; lockouts: number; until: number }>();
const LOGIN_MAX_FAILS = 5;
const LOGIN_COOLDOWN_MS = 30_000;
const LOGIN_COOLDOWN_MAX = 60 * 60_000; // teto de 1h por bloqueio

function pruneLoginGate(now: number) {
  if (loginGate.size < 500) return; // so poda quando cresce demais
  for (const [k, v] of loginGate) if (v.until <= now && v.fails === 0) loginGate.delete(k);
}

// Login por nome + PIN (1o acesso define o PIN; depois confere). Nunca expoe o hash.
app.post("/login", (req, res) => {
  const body = (req.body ?? {}) as { member?: unknown; pin?: unknown };
  const key = normId(String(body.member ?? ""));
  const now = Date.now();
  pruneLoginGate(now);
  const rec = loginGate.get(key);
  if (rec && rec.until > now) {
    // em cooldown: responde como "wrong" (sem revelar a trava) e nao gasta scrypt
    res.status(429).json({ ok: false, status: "wrong" });
    return;
  }
  const result = login(String(body.member ?? ""), String(body.pin ?? ""));
  if (result.ok) {
    loginGate.delete(key); // sucesso zera tudo
  } else if (result.status === "wrong") {
    const prev = rec ?? { fails: 0, lockouts: 0, until: 0 };
    const fails = prev.fails + 1;
    if (fails >= LOGIN_MAX_FAILS) {
      const lockouts = prev.lockouts + 1;
      const cooldown = Math.min(LOGIN_COOLDOWN_MS * 2 ** (lockouts - 1), LOGIN_COOLDOWN_MAX);
      loginGate.set(key, { fails: 0, lockouts, until: now + cooldown });
    } else {
      loginGate.set(key, { fails, lockouts: prev.lockouts, until: 0 });
    }
  }
  res.json(result);
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
