// Servidor: Colyseus (multiplayer) + HTTP /token (LiveKit) + cliente estatico.
import path from "path";
import { createServer } from "http";
import express from "express";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { AccessToken } from "livekit-server-sdk";
import { OfficeRoom } from "./rooms/OfficeRoom";
import { loadBoard } from "./board/store";
import { login, normId, listMemberNames, issueToken, applyLevelGrants } from "./progress/store";
import { getFlags } from "./gamification/flags";
import { vaultReady } from "./vault/store";

// Carrega server/.env (chaves do LiveKit), se existir. Node 20.12+/26.
try {
  process.loadEnvFile();
} catch {
  /* sem .env — voz fica desativada ate configurar */
}

// Concede nível a membros via GAMIF_LEVELS="Nome=10" (piso; nunca reduz). No boot.
applyLevelGrants();

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
  // `ai` diz se o processo enxerga a ANTHROPIC_API_KEY (booleano — nunca a chave em si)
  // e se o flag da avaliacao esta ligado. Serve pra diagnosticar o "IA indisponivel".
  res.json({
    ok: true,
    voice: voiceReady,
    ai: !!process.env.ANTHROPIC_API_KEY,
    aiReview: getFlags().aiReview,
    vault: vaultReady(), // booleano — VAULT_KEY presente e valida (nunca a chave)
  });
});

// Feature flags da gamificacao — o cliente le isto no boot e so liga cada feature
// se o flag estiver on. O dono desliga qualquer coisa setando GAMIF_X=0 no Coolify.
app.get("/config", (_req, res) => {
  // approver = memberId (nome de login normalizado) de quem aprova entregas "sem comprovacao".
  // O cliente usa pra mostrar o botao "Aprovar" só pra ele; vazio = qualquer um aprova.
  res.json({ flags: getFlags(), approver: normId(process.env.GAMIF_APPROVER || ""), vault: vaultReady() });
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

// Sugestões de membros pro autocomplete do login — nomes do board + de quem já logou (dedup).
app.get("/members", async (_req, res) => {
  try {
    const board = await loadBoard();
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const n of [...board.members.map((m) => m.name), ...listMemberNames()]) {
      const k = (n || "").trim().toLowerCase();
      if (k && !seen.has(k)) {
        seen.add(k);
        merged.push(n);
      }
    }
    res.json({ members: merged });
  } catch {
    res.json({ members: [] });
  }
});

// Rate-limit por membro contra brute-force de PIN (espaco pequeno, 4-8 digitos). Em memoria
// (some no restart). Backoff PROGRESSIVO: a cada bloqueio o cooldown dobra (30s,1m,2m,...,1h) e
// o contador de bloqueios NAO zera — entao tentar de novo so endurece a trava (forca bruta vira
// inviavel). Limpa o Map quando ele cresce (spray de nomes).
const loginGate = new Map<string, { fails: number; lockouts: number; until: number; ts: number }>();
const LOGIN_MAX_FAILS = 5;
const LOGIN_COOLDOWN_MS = 30_000;
const LOGIN_COOLDOWN_MAX = 60 * 60_000; // teto de 1h por bloqueio
const LOGIN_ENTRY_TTL = 60 * 60_000; // 1h sem atividade -> pode podar (reset natural do backoff)

function pruneLoginGate(now: number) {
  if (loginGate.size < 500) return; // so poda quando cresce demais
  // Poda por IDADE (ts), preservando quem esta em cooldown ATIVO. Assim: (a) entradas
  // parcialmente falhas (fails 1..4) tambem saem quando ficam velhas (nao vazam memoria); e
  // (b) o contador de bloqueios (lockouts) de quem esta sob ataque NAO zera — quem martela
  // renova o ts a cada tentativa, entao nunca e podado e o backoff so endurece.
  for (const [k, v] of loginGate) {
    if (v.until <= now && now - v.ts > LOGIN_ENTRY_TTL) loginGate.delete(k);
  }
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
    // emite o token de sessão (atado ao memberId) — o cliente guarda e manda no join;
    // o onAuth da sala valida. É o que impede se passar por outro membro sem o PIN.
    res.json({ ...result, token: issueToken(result.member.memberId) });
    return;
  } else if (result.status === "wrong") {
    const prev = rec ?? { fails: 0, lockouts: 0, until: 0, ts: now };
    const fails = prev.fails + 1;
    if (fails >= LOGIN_MAX_FAILS) {
      const lockouts = prev.lockouts + 1;
      const cooldown = Math.min(LOGIN_COOLDOWN_MS * 2 ** (lockouts - 1), LOGIN_COOLDOWN_MAX);
      loginGate.set(key, { fails: 0, lockouts, until: now + cooldown, ts: now });
    } else {
      loginGate.set(key, { fails, lockouts: prev.lockouts, until: 0, ts: now });
    }
  }
  res.json(result);
});

// Cliente estatico (build do Vite). __dirname = server/dist -> ../../client/dist
const clientDist = path.join(__dirname, "..", "..", "client", "dist");
app.use(express.static(clientDist));

const httpServer = createServer(app);
// maxPayload: o DEFAULT do @colyseus/ws-transport é 4KB (!) — qualquer mensagem maior
// (ex.: print de entrega em base64, ~150-300KB) era DERRUBADA no transporte sem nenhum
// erro visível ("entregar com print não funciona"). 10MB cobre o print (guarda de 8MB
// no handler) com folga pra mensagens futuras.
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer, maxPayload: 10 * 1024 * 1024 }),
});
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
