import { Room, Client } from "colyseus";
import { MapSchema } from "@colyseus/schema";
import { OfficeState } from "../schema/OfficeState";
import { Player } from "../schema/Player";
import { Task } from "../schema/Task";
import { loadBoard, saveBoard, flushBoardSync, type TaskData, type ClientColor } from "../board/store";
import {
  flushProgressSync,
  awardPE,
  clawbackPE,
  getProgressView,
  getMember,
  currentWeekKey,
  normId,
  verifyToken,
  type ProgressView,
} from "../progress/store";
import { getFlags } from "../gamification/flags";
import { reviewDelivery, type ProofImage } from "../gamification/aiReview";
import {
  loadVault,
  saveVault,
  flushVaultSync,
  parseVaultMarkdown,
  type VaultEntry,
  type EntryPub,
} from "../vault/store";
import { AudibilityEngine, zoneAt, type AudPoint } from "../voice/audibility";
import { LkSubscriptions, type AudioSids } from "../voice/subscriptions";
import { issueVoiceNonce, revokeVoiceNonce } from "../voice/nonces";
import { MeetingScribe, type MeetingSession } from "../meetings/scribe";
import { summarizeMeeting, appendMeetingLog } from "../meetings/summarize";

type JoinOptions = { name?: string; charId?: number; x?: number; y?: number; authToken?: string };
type MoveMsg = { x?: number; y?: number; dir?: number; moving?: boolean };
type CallMsg = { to?: string };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
// dimensoes do mapa em px (espelham client/OfficeScene: COLS*T x ROWS*T = 30*32 x 57*32)
const MAP_W = 960;
const MAP_H = 1824;
const COLS = new Set(["backlog", "afazer", "fazendo", "travado", "feito"]);
const UNITS = new Set(["", "ia", "mkt"]); // empresa dona da tarefa
const FORMATS = new Set(["drive", "print", "none"]); // formato da entrega
const EMOTES = new Set(["👍", "❤️", "😂", "🎉", "👏", "😮", "🔥", "✅"]); // F7 V2: whitelist de emoji
const IMG_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]); // print aceito pela visao
const SIZES = new Set(["", "PP", "P", "M", "G", "GG"]); // F6 — tamanho (T-shirt)
const WEIGHTS = new Set([70, 100, 150]); // F6 — peso do cliente (×0.7/1.0/1.5)
// F6 — Pontos de Entrega: PE_base = Tamanho × PesoCliente; modulado pelo FatorPrazo.
const SIZE_PE: Record<string, number> = { PP: 1, P: 2, M: 3, G: 5, GG: 8 };

// mesma paleta/hash do cliente (kanban.ts) — cor automatica deterministica por nome,
// usada ao auto-registrar um cliente/membro novo no respectivo registro de cores.
const PALETTE = [
  "#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16", "#22c55e", "#10b981",
  "#14b8a6", "#06b6d4", "#3b82f6", "#6366f1", "#8b5cf6", "#a855f7", "#d946ef",
  "#ec4899", "#f43f5e", "#0ea5e9", "#78716c",
];
function autoHex(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export class OfficeRoom extends Room<OfficeState> {
  maxClients = 50;
  private taskSeq = 0;
  // Cofre de credenciais: array em MEMORIA, FORA do schema Colyseus (o estado vai pra todos,
  // inclusive convidados). As senhas NUNCA entram no schema nem em broadcast — so saem por
  // client.send pro solicitante. Carregado do disco (cifrado) no onCreate; persistido cifrado.
  private vaultEntries: VaultEntry[] = [];
  private vaultSeq = 0;
  // ---- F1: motor de audibilidade (quem RECEBE áudio de quem — decidido AQUI) ----
  private aud = new AudibilityEngine();
  private lkSubs = new LkSubscriptions();
  private lkSids = new Map<string, AudioSids>(); // identity(sessionId) -> sids de áudio no LiveKit
  private appliedSubs = new Map<string, boolean>(); // "listener>speaker" -> último estado APLICADO
  private subFlight = new Map<string, { next?: boolean }>(); // applies em voo (1 por par; guarda a intenção mais nova)
  private lkRefreshing = false; // single-flight do refreshLkSids
  private lkDirty = false; // pedido de refresh chegou durante um refresh em voo
  private voiceReadyAt = new Map<string, number>(); // throttle do voice:ready por sessão
  private emoteAt = new Map<string, number>(); // F7: último emote por cliente (rate limit)
  // ---- F8: transcrição de reuniões ----
  private scribe = new MeetingScribe();
  private scribeSayAt = new Map<string, number>(); // rate limit do meeting:say por cliente

  async onCreate() {
    this.setState(new OfficeState());

    // carrega o board persistido do disco pro estado (sincroniza pra todos)
    const board = await loadBoard();
    for (const d of board.tasks) {
      const t = new Task();
      t.id = d.id;
      t.title = d.title;
      t.desc = d.desc;
      t.assignee = d.assignee;
      t.client = d.client;
      t.due = d.due;
      t.col = COLS.has(d.col) ? d.col : "backlog";
      t.order = Number(d.order) || 0;
      t.archived = !!d.archived;
      t.unit = UNITS.has(String(d.unit)) ? String(d.unit) : "";
      t.createdAt = Number(d.createdAt) || 0;
      t.completedAt = Number(d.completedAt) || 0;
      t.committedDue = Number(d.committedDue) || 0;
      t.dueChanges = Number(d.dueChanges) || 0;
      t.delivered = !!d.delivered;
      t.deliveredAt = Number(d.deliveredAt) || 0;
      t.deliveredBy = String(d.deliveredBy ?? "");
      t.deliveryFormat = String(d.deliveryFormat ?? "");
      t.proof = String(d.proof ?? "");
      t.deliverNote = String(d.deliverNote ?? "");
      t.verified = !!d.verified;
      t.verifiedBy = String(d.verifiedBy ?? "");
      t.verifiedAt = Number(d.verifiedAt) || 0;
      t.aiScore = typeof d.aiScore === "number" ? d.aiScore : -1;
      t.aiNote = String(d.aiNote ?? "");
      t.blockReason = String(d.blockReason ?? "");
      t.blockedMs = Number(d.blockedMs) || 0;
      t.blockedAt = Number(d.blockedAt) || 0;
      t.scoreAwarded = Number(d.scoreAwarded) || 0;
      t.awardedTo = String(d.awardedTo ?? "");
      t.awardedWeek = String(d.awardedWeek ?? "");
      // backfill p/ dados migrados (creditados antes de awardedTo existir): sem isso o estorno
      // não sabe de quem tirar. Deriva do assignee (melhor palpite) quando há crédito sem destino.
      if (t.scoreAwarded > 0 && !t.awardedTo) t.awardedTo = normId(t.assignee);
      t.size = SIZES.has(String(d.size)) ? String(d.size) : "";
      t.clientWeight = WEIGHTS.has(Number(d.clientWeight)) ? Number(d.clientWeight) : 100;
      this.state.tasks.set(t.id, t);
    }
    for (const c of board.clients) {
      if (c?.name && c?.color) this.state.clientColors.set(c.name, c.color);
    }
    for (const c of board.members) {
      if (c?.name && c?.color) this.state.memberColors.set(c.name, c.color);
    }
    // semeia os registros com clientes/membros que ja aparecem nos cards (pra ja
    // virem no dropdown, mesmo que nunca tenham recebido uma cor manual).
    this.state.tasks.forEach((t) => {
      this.register(this.state.clientColors, t.client);
      this.register(this.state.memberColors, t.assignee);
    });

    // Cofre: carrega (decifra) as entradas do disco pra memoria. Fica FORA do schema.
    this.vaultEntries = loadVault();

    // Client-authoritative: cada cliente envia sua posicao; retransmitimos.
    this.onMessage("move", (client, msg: MoveMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      // valida/limita a posicao: ignora nao-finito (NaN/Infinity) e prende dentro do
      // mapa — um cliente bugado nao "teleporta" pra dentro da bolha de audio de outro.
      if (typeof msg.x === "number" && Number.isFinite(msg.x)) p.x = clamp(msg.x, 0, MAP_W);
      if (typeof msg.y === "number" && Number.isFinite(msg.y)) p.y = clamp(msg.y, 0, MAP_H);
      if (typeof msg.dir === "number") p.dir = clamp(msg.dir | 0, 0, 3);
      p.moving = !!msg.moving;
      p.t = Date.now(); // carimbo de frescor: muda a cada move (mesmo parado)
    });

    // "Chamar": avisa o alvo e manda a posicao autoritativa de quem chamou,
    // pra ele poder usar o "Ir ate" e se teletransportar ao lado.
    this.onMessage("call", (client, msg: CallMsg) => {
      const to = String(msg?.to ?? "");
      if (!to || to === client.sessionId) return;
      const caller = this.state.players.get(client.sessionId);
      const target = this.clients.find((c) => c.sessionId === to);
      if (!caller || !target) return;
      target.send("called", {
        from: client.sessionId,
        name: caller.name,
        x: caller.x,
        y: caller.y,
      });
    });

    // "Levantar a mao": marca/desmarca pedido pra falar (visivel a todos).
    this.onMessage("hand", (client, msg: { raised?: boolean }) => {
      const p = this.state.players.get(client.sessionId);
      if (p) p.handRaised = !!msg?.raised;
    });

    // F5: "chamar reforço" — pedido cooperativo pro time inteiro (exceto quem chamou).
    this.onMessage("help:call", (client) => {
      if (!getFlags().climate) return;
      const caller = this.state.players.get(client.sessionId);
      if (!caller) return;
      this.broadcast("help:called", { name: caller.name }, { except: client });
    });

    // "Bola de fogo": efeito efemero — so retransmite pros outros renderizarem.
    this.onMessage("fireball", (client, msg: { x?: number; y?: number; dir?: number }) => {
      this.broadcast(
        "fireball",
        {
          x: Number(msg?.x) || 0,
          y: Number(msg?.y) || 0,
          dir: clamp(Number(msg?.dir ?? 0) | 0, 0, 3),
        },
        { except: client },
      );
    });

    // "Acerto": quem lancou a bola reporta o alvo. Tira 20%; em 0, manda "died".
    this.onMessage("hit", (client, msg: { target?: string }) => {
      const id = String(msg?.target ?? "");
      if (!id || id === client.sessionId) return;
      const target = this.state.players.get(id);
      if (!target || target.hp <= 0) return;
      // F7: dano = poder do ATACANTE (20 baseline; 20..26 por nível com GAMIF_STATS on)
      const attacker = this.state.players.get(client.sessionId);
      const dmg = attacker?.dmg || 20;
      target.hp = Math.max(0, target.hp - dmg);
      if (target.hp <= 0) {
        this.clients.find((c) => c.sessionId === id)?.send("died", {});
      }
    });

    // ---------- gestor de tarefas (kanban) ----------

    this.onMessage(
      "task:create",
      (
        _c,
        msg: {
          col?: string;
          title?: string;
          desc?: string;
          assignee?: string;
          client?: string;
          due?: string;
          unit?: string;
          size?: string;
          clientWeight?: number;
        },
      ) => {
        const col = COLS.has(String(msg?.col)) ? String(msg.col) : "backlog";
        const t = new Task();
        t.id = `t${Date.now().toString(36)}${(this.taskSeq++).toString(36)}`;
        t.title = (String(msg?.title ?? "").trim() || "Nova tarefa").slice(0, 200);
        t.desc = String(msg?.desc ?? "").slice(0, 4000);
        t.assignee = String(msg?.assignee ?? "").slice(0, 60);
        t.client = String(msg?.client ?? "").slice(0, 60);
        t.due = String(msg?.due ?? "").slice(0, 10);
        t.createdAt = Date.now();
        this.markColumn(t, col); // carimba caso ja nasca em "fazendo"/"feito"
        t.col = col;
        t.unit = UNITS.has(String(msg?.unit)) ? String(msg.unit) : "";
        t.size = SIZES.has(String(msg?.size)) ? String(msg.size) : "";
        t.clientWeight = WEIGHTS.has(Number(msg?.clientWeight)) ? Number(msg.clientWeight) : 100;
        let maxOrder = -1; // posiciona no fim da coluna
        this.state.tasks.forEach((x) => {
          if (x.col === col && x.order > maxOrder) maxOrder = x.order;
        });
        t.order = maxOrder + 1;
        this.state.tasks.set(t.id, t);
        this.register(this.state.clientColors, t.client);
        this.register(this.state.memberColors, t.assignee);
        this.persistBoard();
      },
    );

    this.onMessage(
      "task:update",
      (
        _c,
        msg: {
          id?: string;
          title?: string;
          desc?: string;
          assignee?: string;
          client?: string;
          due?: string;
          col?: string;
          archived?: boolean;
          unit?: string;
          size?: string;
          clientWeight?: number;
        },
      ) => {
        const t = this.state.tasks.get(String(msg?.id ?? ""));
        if (!t) return;
        if (typeof msg.title === "string") t.title = msg.title.slice(0, 200);
        if (typeof msg.desc === "string") t.desc = msg.desc.slice(0, 4000);
        if (typeof msg.assignee === "string") t.assignee = msg.assignee.slice(0, 60);
        if (typeof msg.client === "string") t.client = msg.client.slice(0, 60);
        if (typeof msg.due === "string") {
          const newDue = msg.due.slice(0, 10);
          if (newDue !== t.due && t.col !== "backlog") t.dueChanges++; // empurrou prazo apos comecar
          t.due = newDue;
          if (t.col !== "backlog") this.freezeCommittedDue(t); // congela se ainda nao tinha
        }
        if (typeof msg.archived === "boolean") t.archived = msg.archived;
        if (typeof msg.unit === "string" && UNITS.has(msg.unit)) t.unit = msg.unit;
        if (typeof msg.size === "string" && SIZES.has(msg.size)) t.size = msg.size;
        if (typeof msg.clientWeight === "number" && WEIGHTS.has(msg.clientWeight)) t.clientWeight = msg.clientWeight;
        this.register(this.state.clientColors, t.client);
        this.register(this.state.memberColors, t.assignee);
        if (COLS.has(String(msg?.col)) && msg.col !== t.col) {
          // trocou de coluna pelo modal: vai pro fim da coluna nova
          this.markColumn(t, String(msg.col)); // carimba ANTES de sobrescrever
          t.col = String(msg.col);
          let maxOrder = -1;
          this.state.tasks.forEach((x) => {
            if (x.col === t.col && x !== t && x.order > maxOrder) maxOrder = x.order;
          });
          t.order = maxOrder + 1;
        }
        this.persistBoard();
      },
    );

    this.onMessage("task:move", (_c, msg: { id?: string; col?: string; order?: number }) => {
      const t = this.state.tasks.get(String(msg?.id ?? ""));
      if (!t) return;
      if (COLS.has(String(msg?.col))) {
        this.markColumn(t, String(msg.col)); // carimba ANTES de sobrescrever
        t.col = String(msg.col);
      }
      if (typeof msg.order === "number" && Number.isFinite(msg.order)) t.order = msg.order;
      this.persistBoard();
    });

    this.onMessage("task:delete", (_c, msg: { id?: string }) => {
      const id = String(msg?.id ?? "");
      if (this.state.tasks.has(id)) {
        this.state.tasks.delete(id);
        this.persistBoard();
      }
    });

    // F6 (V2): duplicar card — clona o CONTEÚDO e reseta todo o ESTADO (a cópia nunca
    // herda entrega/verificação/PE — senão duplicar viraria jeito de forjar crédito).
    this.onMessage("task:duplicate", (_c, msg: { id?: string }) => {
      const src = this.state.tasks.get(String(msg?.id ?? ""));
      if (!src) return;
      const t = new Task();
      t.id = `t${Date.now().toString(36)}${(this.taskSeq++).toString(36)}`;
      t.title = `${src.title} (cópia)`.slice(0, 200);
      t.desc = src.desc;
      t.assignee = src.assignee;
      t.client = src.client;
      t.due = src.due;
      t.unit = src.unit;
      t.size = src.size;
      t.clientWeight = src.clientWeight;
      t.createdAt = Date.now();
      this.markColumn(t, src.col);
      t.col = src.col;
      t.order = src.order + 0.5; // logo abaixo do original (order fracionário ordena asc)
      this.state.tasks.set(t.id, t);
      this.persistBoard();
    });

    // ---------- F2: gate de entrega (escrow — "Feito" sozinho NAO credita) ----------

    // Entregar ao cliente: exige prova (link). Carimba deliveredAt no SERVIDOR (anti-forja).
    // Fica "aguardando verificacao" — nenhum ponto e creditado aqui (escrow).
    this.onMessage(
      "task:deliver",
      (
        client,
        msg: { id?: string; proof?: string; note?: string; format?: string; image?: string; imageType?: string },
      ) => {
        if (!getFlags().gate) return; // feature desligada -> no-op
        // F4 (V2): NENHUMA rejeicao e mais silenciosa — toda falha responde o MOTIVO
        // pro autor ("clicei e nada aconteceu" nunca mais).
        const fail = (reason: string) => client.send("task:deliverError", { reason });
        const t = this.state.tasks.get(String(msg?.id ?? ""));
        if (!t || t.col !== "feito") return fail("A tarefa precisa estar na coluna Feito pra ser entregue.");
        if (t.delivered) return fail("Essa tarefa já foi entregue. Use Devolver antes de reentregar.");
        // 3 formatos: "drive" (link, IA confia) | "print" (imagem, IA VE) | "none" (sem comprovacao -> Matheus aprova)
        const format = FORMATS.has(String(msg?.format)) ? String(msg.format) : "drive";
        let proof = "";
        let image: ProofImage | undefined;
        if (format === "drive") {
          proof = String(msg?.proof ?? "").trim().slice(0, 300);
          if (!/^https?:\/\/\S+/i.test(proof)) return fail("Link inválido — cole um endereço que começa com http(s)://.");
        } else if (format === "print") {
          const data = String(msg?.image ?? "");
          const mt = String(msg?.imageType ?? "");
          if (!data || !IMG_TYPES.has(mt)) return fail("Imagem inválida — anexe um print PNG/JPG.");
          if (data.length > 8_000_000) return fail("Imagem grande demais (máx ~6MB) — tente um print menor.");
          image = { data, mediaType: mt as ProofImage["mediaType"] };
        }
        // format === "none": sem prova nem imagem (vai pra aprovacao manual do Matheus)
        const p = this.state.players.get(client.sessionId);
        // Sem trava de identidade na entrega (time de confiança): qualquer um marca entregue.
        t.delivered = true;
        t.deliveredAt = Date.now(); // carimbo autoritativo do servidor
        t.deliveredBy = (p?.memberId || p?.name || "").slice(0, 60);
        t.deliveryFormat = format;
        t.proof = proof;
        t.deliverNote = String(msg?.note ?? "").trim().slice(0, 280);
        t.verified = false; // aguarda verificacao (IA em drive/print, aprovacao do Matheus em none)
        t.aiScore = -1;
        t.aiNote = "";
        this.persistBoard();
        // IA so pra drive/print. "none" NAO chama IA — fica aguardando a aprovacao do aprovador.
        if (format !== "none" && getFlags().aiReview) void this.runAiReview(t.id, client.sessionId, image);
      },
    );

    // Verificar (sign-off): libera o selo verde + carimba QUEM verificou (anti-forja simetrico;
    // base pro F6 sinalizar conluio). F2 nao credita ponto (isso e F6). O design permite o dono da
    // conta assinar a propria entrega, entao NAO bloqueio self-verify aqui — o carimbo fica de registro.
    this.onMessage("task:verify", (client, msg: { id?: string }) => {
      if (!getFlags().gate) return;
      const t = this.state.tasks.get(String(msg?.id ?? ""));
      if (!t || !t.delivered) return; // so verifica o que foi entregue
      const p = this.state.players.get(client.sessionId);
      // Entrega "sem comprovacao" (none) SO pode ser aprovada pelo APROVADOR designado (Matheus),
      // configurado via env GAMIF_APPROVER (nome de login normalizado). Sem approver -> qualquer um.
      if (t.deliveryFormat === "none") {
        const approver = normId(process.env.GAMIF_APPROVER || "");
        if (approver && (p?.memberId || "") !== approver) return;
      }
      t.verified = true;
      t.verifiedBy = (p?.memberId || p?.name || "").slice(0, 60);
      t.verifiedAt = Date.now();
      this.creditIfVerified(t); // F6: libera o escrow -> credita PE (idempotente)
      this.persistBoard();
    });

    // Devolver: reverte a entrega (correcao de engano ou retrabalho pedido).
    this.onMessage("task:undeliver", (_c, msg: { id?: string }) => {
      if (!getFlags().gate) return;
      const t = this.state.tasks.get(String(msg?.id ?? ""));
      if (!t) return;
      this.resetDelivery(t);
      this.persistBoard();
    });

    // F4: motivo curto do "Travado" — pausa o relogio de atraso (o chip some). So vale em travado.
    this.onMessage("task:block", (_c, msg: { id?: string; reason?: string }) => {
      if (!getFlags().overdue) return;
      const t = this.state.tasks.get(String(msg?.id ?? ""));
      if (!t || t.col !== "travado") return;
      t.blockReason = String(msg?.reason ?? "").trim().slice(0, 120);
      this.persistBoard();
    });

    // arquiva todos os cards em "Feito" (somem do board, mas ficam no historico)
    this.onMessage("board:archiveDone", () => {
      const gateOn = getFlags().gate;
      let changed = false;
      this.state.tasks.forEach((t) => {
        if (t.col !== "feito" || t.archived) return;
        // entrega em escrow (entregue mas ainda nao verificada) NAO arquiva: ficaria orfa
        // (a UI do gate some no card arquivado), presa sem poder verificar nem devolver.
        if (gateOn && t.delivered && !t.verified) return;
        t.archived = true;
        changed = true;
      });
      if (changed) this.persistBoard();
    });

    // define a cor (hex) de um cliente; cor vazia remove o override (volta pra auto)
    this.onMessage("client:setColor", (_c, msg: { name?: string; color?: string }) => {
      const name = String(msg?.name ?? "").trim().slice(0, 60);
      if (!name) return;
      const color = String(msg?.color ?? "").trim().slice(0, 9);
      if (color) this.state.clientColors.set(name, color);
      else this.state.clientColors.delete(name);
      this.persistBoard();
    });

    // renomeia um cliente em TODOS os cards + no registro de cores
    this.onMessage("client:rename", (_c, msg: { from?: string; to?: string }) => {
      const from = String(msg?.from ?? "").trim();
      const to = String(msg?.to ?? "").trim().slice(0, 60);
      if (!from || !to || from === to) return;
      this.state.tasks.forEach((t) => {
        if (t.client === from) t.client = to;
      });
      const c = this.state.clientColors.get(from);
      if (c !== undefined) {
        this.state.clientColors.delete(from);
        this.state.clientColors.set(to, c);
      }
      this.persistBoard();
    });

    // define a cor (hex) de um membro do time; vazio remove (volta pra auto)
    this.onMessage("member:setColor", (_c, msg: { name?: string; color?: string }) => {
      const name = String(msg?.name ?? "").trim().slice(0, 60);
      if (!name) return;
      const color = String(msg?.color ?? "").trim().slice(0, 9);
      if (color) this.state.memberColors.set(name, color);
      else this.state.memberColors.delete(name);
      this.persistBoard();
    });

    // renomeia um membro em TODOS os cards + no registro de cores
    this.onMessage("member:rename", (_c, msg: { from?: string; to?: string }) => {
      const from = String(msg?.from ?? "").trim();
      const to = String(msg?.to ?? "").trim().slice(0, 60);
      if (!from || !to || from === to) return;
      this.state.tasks.forEach((t) => {
        if (t.assignee === from) t.assignee = to;
      });
      const c = this.state.memberColors.get(from);
      if (c !== undefined) {
        this.state.memberColors.delete(from);
        this.state.memberColors.set(to, c);
      }
      this.persistBoard();
    });

    // "stream" do board: marca/desmarca — quem estiver perto ve/edita junto.
    this.onMessage("board:stream", (client, msg: { on?: boolean }) => {
      const p = this.state.players.get(client.sessionId);
      if (p) p.streamingBoard = !!msg?.on;
    });

    // ---------- cofre de credenciais (Central de Senhas) ----------
    // TODOS exigem membro autenticado (memberId != ""). Convidado -> "vault:denied".
    // A senha NUNCA entra no schema/broadcast — a lista vai como EntryPub (sem senha) e a
    // senha de UM item so vai por client.send pro solicitante.

    // Lista (sem senhas): so pro solicitante autenticado.
    this.onMessage("vault:list", (client) => {
      if (!this.vaultAuth(client)) return;
      client.send("vault:list", { entries: this.vaultPub() });
    });

    // Revela a senha de UM item — so desse item, so pro solicitante.
    this.onMessage("vault:reveal", (client, msg: { id?: string }) => {
      if (!this.vaultAuth(client)) return;
      const id = String(msg?.id ?? "");
      const e = this.vaultEntries.find((v) => v.id === id);
      if (!e) return;
      client.send("vault:secret", { id: e.id, password: e.password });
    });

    // Cria (sem id) ou atualiza; carimba updatedAt/updatedBy; persiste; re-lista a todos logados.
    this.onMessage("vault:save", (client, msg: { entry?: Partial<VaultEntry> }) => {
      const mid = this.vaultAuth(client);
      if (!mid) return;
      const raw = msg?.entry;
      if (!raw || typeof raw !== "object") return; // payload malformado -> ignora
      const now = Date.now();
      const id = String(raw.id ?? "").trim();
      if (id) {
        // atualizar item existente
        const e = this.vaultEntries.find((v) => v.id === id);
        if (!e) return;
        e.group = this.vaultStr(raw.group, 40, e.group);
        e.client = this.vaultStr(raw.client, 120, e.client);
        e.service = this.vaultStr(raw.service, 120, e.service);
        e.username = this.vaultStr(raw.username, 200, e.username);
        // senha vazia = manter a atual (a EntryPub nao traz senha, entao editar sem digitar mantem)
        if (typeof raw.password === "string" && raw.password.length > 0) {
          e.password = raw.password.slice(0, 400);
        }
        e.url = this.vaultStr(raw.url, 400, e.url);
        e.notes = this.vaultStr(raw.notes, 2000, e.notes);
        e.updatedAt = now;
        e.updatedBy = mid;
      } else {
        // criar novo item
        const e: VaultEntry = {
          id: `k${now.toString(36)}${(this.vaultSeq++).toString(36)}`,
          group: this.vaultStr(raw.group, 40, "ativo") || "ativo",
          client: this.vaultStr(raw.client, 120, ""),
          service: this.vaultStr(raw.service, 120, ""),
          username: this.vaultStr(raw.username, 200, ""),
          password: typeof raw.password === "string" ? raw.password.slice(0, 400) : "",
          url: this.vaultStr(raw.url, 400, ""),
          notes: this.vaultStr(raw.notes, 2000, ""),
          updatedAt: now,
          updatedBy: mid,
        };
        this.vaultEntries.push(e);
      }
      saveVault(this.vaultEntries);
      this.sendVaultListToAll();
    });

    // Remove; persiste; re-lista a todos logados.
    this.onMessage("vault:delete", (client, msg: { id?: string }) => {
      if (!this.vaultAuth(client)) return;
      const id = String(msg?.id ?? "");
      const i = this.vaultEntries.findIndex((v) => v.id === id);
      if (i < 0) return;
      this.vaultEntries.splice(i, 1);
      saveVault(this.vaultEntries);
      this.sendVaultListToAll();
    });

    // Importa de markdown: MESCLA (nao apaga os existentes); persiste; avisa a contagem + re-lista.
    this.onMessage("vault:import", (client, msg: { text?: string }) => {
      const mid = this.vaultAuth(client);
      if (!mid) return;
      const text = String(msg?.text ?? "");
      const parsed = parseVaultMarkdown(text);
      for (const e of parsed) {
        e.updatedBy = mid; // carimba quem importou
        this.vaultEntries.push(e);
      }
      if (parsed.length > 0) {
        saveVault(this.vaultEntries);
        this.sendVaultListToAll();
      }
      client.send("vault:imported", { count: parsed.length });
    });

    // ---------- F8 (V2): transcrição de reuniões (ata + tarefas automáticas) ----------
    // O navegador transcreve (Web Speech, SÓ TEXTO sai de lá) e manda meeting:say; o
    // servidor mantém a sessão por zona e, ao fechar, gera a ata via Haiku.
    if (getFlags().meetingScribe) {
      this.onMessage("meeting:say", (client, msg: { text?: string }) => {
        if (!getFlags().meetingScribe) return;
        const p = this.state.players.get(client.sessionId);
        if (!p || !p.memberId) return; // só membro LOGADO alimenta a ata
        const now = Date.now();
        if (now - (this.scribeSayAt.get(client.sessionId) ?? 0) < 700) return; // anti-flood
        this.scribeSayAt.set(client.sessionId, now);
        const text = String(msg?.text ?? "").trim().slice(0, 500);
        if (!text) return;
        const zone = zoneAt(p.x, p.y);
        if (zone < 0) return; // fora de sala de reunião: nunca transcreve
        this.scribe.say(zone, p.name || p.memberId, text, now);
      });
      this.clock.setInterval(() => this.scribeTick(), 1000);
    }

    // ---------- F7 (V2): emoji flutuante ----------
    // Whitelist + rate limit por cliente; broadcast pra todos renderizarem em cima do autor.
    this.onMessage("emote", (client, msg: { e?: string }) => {
      if (!getFlags().emotes) return;
      const e = String(msg?.e ?? "");
      if (!EMOTES.has(e)) return;
      const now = Date.now();
      if (now - (this.emoteAt.get(client.sessionId) ?? 0) < 750) return; // anti-spam
      this.emoteAt.set(client.sessionId, now);
      this.broadcast("emote", { sid: client.sessionId, e });
    });

    // ---------- F1: motor de audibilidade (fix definitivo do vazamento de voz) ----------
    // O servidor (dono das posições) decide quem RECEBE áudio de quem e força as
    // assinaturas no LiveKit. AUDIO_AUTH=0 desliga (volta ao fade-só-cliente).

    // Nonce do /token (hardening): o cliente pede e recebe um nonce atado à PRÓPRIA
    // sessão — identidade no LiveKit deixa de ser escolhida pelo cliente. SEMPRE
    // registrado (a voz existe mesmo com AUDIO_AUTH=0).
    this.onMessage("voice:nonce?", (client) => {
      client.send("voice:nonce", { nonce: issueVoiceNonce(client.sessionId) });
    });

    if (getFlags().audioAuth && this.lkSubs.ready()) {
      // cliente avisa que (re)entrou na voz / publicou track -> ressincroniza JÁ.
      // Throttle por sessão (anti-flood da API) + purge do lado OUVINTE: após um
      // full-reconnect do LiveKit o autoSubscribe re-assina tudo, mas o appliedSubs
      // ainda dizia "false" — sem purgar, o motor nunca re-desassinaria (review V2).
      this.onMessage("voice:ready", (client) => {
        const now = Date.now();
        if (now - (this.voiceReadyAt.get(client.sessionId) ?? 0) < 1000) return;
        this.voiceReadyAt.set(client.sessionId, now);
        const prefix = `${client.sessionId}>`;
        for (const key of [...this.appliedSubs.keys()]) {
          if (key.startsWith(prefix)) this.appliedSubs.delete(key);
        }
        void this.refreshLkSids();
      });
      this.clock.setInterval(() => this.audTick(), 300);
      this.clock.setInterval(() => void this.refreshLkSids(), 4000);
      void this.lkSubs.smoke().then((ok) => {
        console.log(
          ok
            ? "[audibility] RoomService OK — assinaturas server-side ATIVAS"
            : "[audibility] RoomService INDISPONÍVEL — degradando pro fade do cliente (verificar LIVEKIT_URL/keys)",
        );
      });
    } else {
      // sem flag/keys, o handler precisa existir mesmo assim (cliente manda sempre)
      this.onMessage("voice:ready", () => {});
      if (!getFlags().audioAuth) console.log("[audibility] AUDIO_AUTH=0 — motor desligado");
    }

    console.log("[OfficeRoom] sala criada");
  }

  // ---------- F8: transcrição — ciclo de sessões e geração da ata ----------

  /** A cada 1s: conta gente por zona, abre/fecha sessões; sessão fechada vira ata. */
  private scribeTick(): void {
    const counts = new Map<number, number>();
    this.state.players.forEach((p) => {
      const z = zoneAt(p.x, p.y);
      if (z >= 0) counts.set(z, (counts.get(z) ?? 0) + 1);
    });
    for (const s of this.scribe.tick(counts, Date.now())) void this.finishMeeting(s);
  }

  /** Fecha a reunião: resume via Haiku, cria card-ata + tarefas 🤖 e avisa o time. */
  private async finishMeeting(s: MeetingSession): Promise<void> {
    const words = s.utterances.reduce((n, u) => n + u.text.split(/\s+/).length, 0);
    if (words < 30) return; // conversa curta/ruído — sem ata
    const ata = await summarizeMeeting(s.utterances);
    if (!ata || !ata.resumo) return; // IA fora ou "não era reunião de trabalho"
    const ZONE_NAMES = ["azul", "vermelha", "dourada"];
    const d = new Date();
    const dd = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
    const hh = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const desc = [
      `Sala ${ZONE_NAMES[s.zone] ?? s.zone} · participantes: ${[...s.speakers].join(", ") || "—"}`,
      "",
      "RESUMO:",
      ata.resumo,
    ]
      .concat(ata.decisoes.length ? ["", "DECISÕES:", ...ata.decisoes.map((x) => `• ${x}`)] : [])
      .join("\n");
    this.createScribeTask(`📋 Ata — ${dd} ${hh}`, desc, "", "");
    // responsável só quando o nome dito bate com um membro REGISTRADO (normId) — a IA
    // nunca atribui tarefa pra nome que não existe no quadro.
    const known = new Map<string, string>();
    this.state.memberColors.forEach((_c, nome) => known.set(normId(nome), nome));
    for (const t of ata.tarefas) {
      const assignee = known.get(normId(t.responsavel)) ?? "";
      this.createScribeTask(
        `🤖 ${t.titulo}`,
        `Criada automaticamente pela ata da reunião de ${dd} ${hh}. Confere e ajusta o que precisar.`,
        assignee,
        t.due,
      );
    }
    this.persistBoard();
    appendMeetingLog({
      startedAt: s.startedAt,
      endedAt: Date.now(),
      zone: s.zone,
      speakers: [...s.speakers],
      utterances: s.utterances.length,
      ata,
    });
    this.broadcast("meeting:ata", { tarefas: ata.tarefas.length });
    console.log(`[scribe] ata criada (${s.utterances.length} falas -> ${ata.tarefas.length} tarefas)`);
  }

  /** Cria um card vindo da ata (client "Reunião", coluna A Fazer, fim da coluna). */
  private createScribeTask(title: string, desc: string, assignee: string, due: string): void {
    const t = new Task();
    t.id = `t${Date.now().toString(36)}${(this.taskSeq++).toString(36)}`;
    t.title = title.slice(0, 200);
    t.desc = desc.slice(0, 4000);
    t.assignee = assignee.slice(0, 60);
    t.client = "Reunião";
    t.due = due.slice(0, 10);
    t.createdAt = Date.now();
    this.markColumn(t, "afazer");
    t.col = "afazer";
    let maxOrder = -1;
    this.state.tasks.forEach((x) => {
      if (x.col === "afazer" && x.order > maxOrder) maxOrder = x.order;
    });
    t.order = maxOrder + 1;
    this.state.tasks.set(t.id, t);
    this.register(this.state.clientColors, t.client);
    if (assignee) this.register(this.state.memberColors, assignee);
  }

  // ---------- F1: audibilidade — tick, eventos de proximidade e reconciliação ----------

  /** Recomputa pares audíveis (300ms) e dispara eventos + reconciliação de assinaturas. */
  private audTick(): void {
    const players: AudPoint[] = [];
    this.state.players.forEach((p, sid) => players.push({ id: sid, x: p.x, y: p.y }));
    const { enters, leaves } = this.aud.tick(players);
    if (enters.length || leaves.length) {
      // O(pares) em vez de O(pares×clients): índice de clients uma vez por tick
      const bySid = new Map<string, Client>();
      for (const c of this.clients) bySid.set(c.sessionId, c);
      for (const { a, b } of enters) this.sendProx(bySid, a, b, true);
      for (const { a, b } of leaves) this.sendProx(bySid, a, b, false);
    }
    // reconcilia SEMPRE (barato em memória; API só nos diffs) — applies que falharam
    // re-tentam em 300ms em vez de esperar o refresh de 4s.
    this.reconcileSubs();
  }

  /**
   * Avisa um par que entrou/saiu do alcance de voz (F2). Cada lado só recebe o aviso
   * se o OUTRO publica áudio — o som significa "você agora OUVE (ou deixou de ouvir)
   * alguém", nunca "um avatar sem voz passou perto".
   */
  private sendProx(bySid: Map<string, Client>, a: string, b: string, entered: boolean): void {
    const evt = entered ? "prox:enter" : "prox:leave";
    const inVoice = (id: string) => (this.lkSids.get(id)?.sids.length ?? 0) > 0;
    if (inVoice(b)) bySid.get(a)?.send(evt, { sid: b, name: this.state.players.get(b)?.name ?? "" });
    if (inVoice(a)) bySid.get(b)?.send(evt, { sid: a, name: this.state.players.get(a)?.name ?? "" });
  }

  /**
   * Atualiza o cache identity->SIDs de áudio a partir do LiveKit e invalida o estado
   * aplicado de quem publicou/despublicou track. Roda a cada 4s e no voice:ready —
   * o sistema é AUTO-CURATIVO: qualquer dessincronização dura no máximo um ciclo.
   */
  private async refreshLkSids(): Promise<void> {
    if (!getFlags().audioAuth) return;
    // single-flight com coalescing: refreshes sobrepostos (timer 4s + voice:ready em
    // rajada) não disparam requests paralelos nem terminam fora de ordem — o pedido
    // que chegar durante o voo vira UMA rodada extra ao final (review V2).
    if (this.lkRefreshing) {
      this.lkDirty = true;
      return;
    }
    this.lkRefreshing = true;
    try {
      do {
        this.lkDirty = false;
        const map = await this.lkSubs.audioSidsByIdentity();
        if (!map) break; // falha de TRANSPORTE: mantém o estado atual; próximo ciclo tenta
        for (const [id, cur] of map) {
          const prev = this.lkSids.get(id);
          if (!prev || prev.sig !== cur.sig) {
            // publisher mudou as tracks -> força re-aplicar tudo que envolve ele como speaker
            for (const key of [...this.appliedSubs.keys()]) {
              if (key.endsWith(`>${id}`)) this.appliedSubs.delete(key);
            }
          }
        }
        for (const id of [...this.lkSids.keys()]) {
          if (!map.has(id)) {
            for (const key of [...this.appliedSubs.keys()]) {
              if (key.startsWith(`${id}>`) || key.endsWith(`>${id}`)) this.appliedSubs.delete(key);
            }
          }
        }
        this.lkSids = map;
        this.reconcileSubs();
      } while (this.lkDirty);
    } finally {
      this.lkRefreshing = false;
    }
  }

  /**
   * Reconciliação declarativa: pra cada par (listener, speaker) presente no LiveKit,
   * aplica no LiveKit o estado desejado pelo motor SE ainda não foi aplicado.
   * Chamadas idempotentes; falha fica sem registrar e re-tenta no próximo ciclo.
   */
  private reconcileSubs(): void {
    if (!getFlags().audioAuth || this.lkSids.size < 2) return;
    for (const [listener] of this.lkSids) {
      for (const [speaker, audio] of this.lkSids) {
        if (listener === speaker || audio.sids.length === 0) continue;
        const desired = this.aud.isAudible(listener, speaker);
        const key = `${listener}>${speaker}`;
        if (this.appliedSubs.get(key) === desired) continue;
        this.launchApply(key, listener, speaker, desired);
      }
    }
  }

  /**
   * Aplica UMA mudança de assinatura por par de cada vez (single-flight). Se o desejo
   * flipar enquanto uma chamada está em voo, só a INTENÇÃO MAIS NOVA é aplicada ao
   * final — nunca duas chamadas opostas em paralelo chegando fora de ordem no LiveKit
   * (review V2). Falha não grava estado e re-tenta no próximo tick (sem hot-loop).
   */
  private launchApply(key: string, listener: string, speaker: string, desired: boolean): void {
    const flight = this.subFlight.get(key);
    if (flight) {
      flight.next = desired; // já tem chamada em voo: só atualiza a intenção
      return;
    }
    const sids = this.lkSids.get(speaker)?.sids ?? [];
    if (sids.length === 0) return;
    this.subFlight.set(key, {});
    void this.lkSubs.apply(listener, sids, desired).then((ok) => {
      const f = this.subFlight.get(key);
      this.subFlight.delete(key);
      if (!ok) return; // re-tentado pelo reconcile do próximo tick (300ms)
      this.appliedSubs.set(key, desired);
      // intenção mais nova durante o voo? (ou o motor já mudou de ideia) -> encadeia
      const cur = this.aud.isAudible(listener, speaker);
      const next = f?.next !== undefined ? f.next : cur;
      if (next !== desired && this.lkSids.has(listener) && this.lkSids.has(speaker)) {
        this.launchApply(key, listener, speaker, next);
      }
    });
  }

  /** Garante que `name` esteja no registro de cores (cor automatica se ausente). */
  private register(map: MapSchema<string>, name: string) {
    if (name && !map.has(name)) map.set(name, autoHex(name));
  }

  /** Congela o prazo (committedDue, ms = fim do dia da entrega) na 1a vez — anti "empurrar prazo". */
  private freezeCommittedDue(t: Task) {
    if (t.committedDue !== 0 || !t.due) return;
    const ms = Date.parse(t.due + "T23:59:59");
    if (Number.isFinite(ms)) t.committedDue = ms;
  }

  /**
   * Carimba transicoes de coluna (base da gamificacao). Chamar ANTES de sobrescrever t.col,
   * pelos DOIS caminhos que mudam coluna (task:move no drag e task:update pelo modal).
   * - ao iniciar ("fazendo"): congela committedDue (prazo comprometido).
   * - 1a vez em "feito": carimba completedAt do SERVIDOR (autoritativo).
   */
  private markColumn(t: Task, newCol: string) {
    if (newCol === t.col) return;
    // Sair de "feito" pra trás = retrabalho: o ciclo recomeça, então zera o estado de entrega.
    // Senão o card volta com o selo "Verificado" e a prova antiga sem reentrega (escrow furado).
    if (t.col === "feito" && newCol !== "feito") this.resetDelivery(t);
    // F4 — pausa REAL do relógio: acumula o tempo parado em "Travado" pra ESTENDER o prazo.
    if (newCol === "travado") {
      t.blockedAt = Date.now(); // começou a pausar
    } else if (t.col === "travado") {
      if (t.blockedAt > 0) t.blockedMs += Date.now() - t.blockedAt; // destravou: soma o tempo parado
      t.blockedAt = 0;
      t.blockReason = ""; // destravou: limpa o motivo
    }
    // congela o prazo ao INICIAR ("fazendo") OU ao concluir direto ("feito") — arrastar
    // afazer/backlog direto pra feito não passava por "fazendo" e fugia do -40% de atraso.
    if (newCol === "fazendo" || newCol === "feito") this.freezeCommittedDue(t);
    if (newCol === "feito" && t.completedAt === 0) t.completedAt = Date.now();
  }

  /** Zera todo o estado de entrega/escrow de um card (retrabalho ou "Devolver"). */
  private resetDelivery(t: Task) {
    // F6: se já creditou PE, estorna SEMPRE que houver crédito (escrow revogado) ANTES de limpar.
    // NÃO gate no flag progression nem exige awardedTo: se o estorno é pulado mas os campos são
    // zerados, o PE fica órfão no membro E o card volta elegível a novo crédito (dobro). Fallback
    // pro assignee cobre dados migrados (creditados antes de awardedTo existir). clawbackPE é
    // no-op quando não há registro daquele membro, então é seguro chamar incondicionalmente.
    if (t.scoreAwarded > 0) {
      const who = t.awardedTo || normId(t.assignee);
      if (who) this.sendProgressTo(who, clawbackPE(who, t.scoreAwarded, t.awardedWeek));
    }
    t.scoreAwarded = 0;
    t.awardedTo = "";
    t.awardedWeek = "";
    t.delivered = false;
    t.verified = false;
    t.proof = "";
    t.deliverNote = "";
    t.deliveredBy = "";
    t.deliveredAt = 0;
    t.verifiedBy = "";
    t.verifiedAt = 0;
    t.aiScore = -1;
    t.aiNote = "";
  }

  /** F6 — PE creditado: Tamanho × PesoCliente × FatorPrazo. (FatorRetrabalho vem do clawback.) */
  private computePE(t: Task): number {
    const base = SIZE_PE[t.size] ?? SIZE_PE.M; // default M se o tamanho não foi setado
    const peso = (t.clientWeight || 100) / 100; // 70→0.7, 100→1.0, 150→1.5
    // FatorPrazo: deliveredAt (servidor) vs a data de entrega ATUAL (`due`) + o tempo pausado em
    // "Travado" (bloqueio externo não conta como atraso). Score e o chip do cliente usam a MESMA
    // fonte (o due), então nunca divergem — se adiar a data, o -40% acompanha. Atrasou -> ×0.6.
    let prazo = 0;
    if (t.due) {
      const ms = Date.parse(t.due + "T23:59:59");
      if (Number.isFinite(ms)) prazo = ms + t.blockedMs;
    }
    const atrasou = prazo > 0 && t.deliveredAt > 0 && t.deliveredAt > prazo;
    return Math.round(base * peso * (atrasou ? 0.6 : 1.0) * 10) / 10;
  }

  /** F6 — credita PE ao RESPONSÁVEL quando a entrega vira Verificada. Idempotente (scoreAwarded). */
  private creditIfVerified(t: Task) {
    if (!getFlags().progression) return;
    if (!t.verified || t.scoreAwarded > 0) return; // não verificada ou já creditada
    const who = normId(t.assignee);
    if (!who) return; // sem responsável -> não há a quem creditar
    const pe = this.computePE(t);
    if (pe <= 0) return;
    t.scoreAwarded = pe; // marca ANTES de persistir (anti-crédito-duplo)
    t.awardedTo = who; // quem recebeu (pra estornar a pessoa certa mesmo se reassignar)
    t.awardedWeek = currentWeekKey(); // semana do crédito (pra estornar na semana certa)
    const view = awardPE(who, t.assignee, pe);
    this.sendProgressTo(who, view);
    this.applyStatsTo(who, view.level); // F7: aplica bônus do novo nível ao vivo (level-up cura/sobe stats)
    if (getFlags().cosmetics) this.celebrateDelivery(who, pe, view.level); // F8: juice da entrega verificada
  }

  /** F8 — celebração da entrega verificada: burst no mundo (glória pública) + toast privado pro autor. */
  private celebrateDelivery(memberId: string, pe: number, level: number) {
    for (const c of this.clients) {
      const p = this.state.players.get(c.sessionId);
      if (p?.memberId !== memberId) continue;
      this.broadcast("celebrate", { x: Math.round(p.x), y: Math.round(p.y) }); // todos perto/no andar veem
      c.send("celebrate:self", { pe, level }); // toast só pro autor
      return; // posição é a mesma entre sessões do mesmo membro
    }
  }

  /** Manda o progresso atualizado pro cliente daquele membro, se online (HUD privado). */
  private sendProgressTo(memberId: string, view: ProgressView | undefined) {
    if (!view || !memberId) return;
    for (const c of this.clients) {
      const p = this.state.players.get(c.sessionId);
      if (p?.memberId === memberId) c.send("progress:self", view); // todas as sessões do membro
    }
  }

  /** F7 — stats upside-only derivados do nível. Baseline 100/20 SEMPRE preservado (flag off = baseline). */
  private statsFor(level: number): { maxHp: number; dmg: number } {
    if (!getFlags().stats) return { maxHp: 100, dmg: 20 };
    const lvl = Math.max(1, level || 1);
    return { maxHp: 100 + Math.min(lvl * 2, 20), dmg: 20 + Math.min(lvl, 6) }; // teto 120/26
  }

  /** Aplica os stats do nível a um Player online. SÓ SOBE (nunca rebaixa mid-sessão — upside-only). */
  private applyStatsTo(memberId: string, level: number) {
    if (!memberId || !getFlags().stats) return; // guarda própria (defesa em profundidade)
    const st = this.statsFor(level);
    // aplica a TODAS as sessões do membro (ex.: 2 abas), não só a 1a
    for (const c of this.clients) {
      const p = this.state.players.get(c.sessionId);
      if (p?.memberId !== memberId) continue;
      const leveledUp = st.maxHp > p.maxHp;
      p.level = level;
      p.maxHp = Math.max(p.maxHp, st.maxHp); // nunca abaixa (clawback não pune o combate)
      p.dmg = Math.max(p.dmg, st.dmg);
      if (leveledUp) p.hp = p.maxHp; // level-up cura (recompensa, nunca punição)
    }
  }

  /**
   * F3 — avalia a entrega com a IA (Haiku) em 2o plano. NUNCA trava o board: reviewDelivery
   * trata timeout/erro/sem-chave devolvendo null. >=7 verifica (libera o escrow) e publica a
   * nota; 4-6 e <4 NAO verificam e o feedback vai SEMPRE PRIVADO pro responsavel (vergonha
   * privada). Sem avaliacao -> deixa em escrow pro sign-off manual (degrada como o F2).
   */
  private async runAiReview(taskId: string, sessionId: string, image?: ProofImage) {
    const t0 = this.state.tasks.get(taskId);
    if (!t0) return;
    const deliveredAt0 = t0.deliveredAt; // token de identidade DESTA entrega (anti-race)
    // snapshot pro prompt (a tarefa pode mudar enquanto a IA pensa). A imagem (print) vem do
    // deliver e NAO fica guardada no card — e transitoria, so pra a IA avaliar.
    const result = await reviewDelivery({
      title: t0.title,
      desc: t0.desc,
      client: t0.client,
      unit: t0.unit,
      proof: t0.proof,
      image,
    });
    // re-busca: ignora resultado tardio se foi devolvida/movida/deletada/verificada OU
    // RE-ENTREGUE no meio (deliveredAt mudou) — senao a nota da entrega antiga aplicaria na nova.
    const t = this.state.tasks.get(taskId);
    if (!t || !t.delivered || t.col !== "feito" || t.verified || t.deliveredAt !== deliveredAt0) return;
    // feedback vai pro DONO ATUAL da entrega (sobrevive a reconexao via memberId; convidado cai no sessionId)
    const client = this.findDeliverer(t.deliveredBy, sessionId);
    if (!result) {
      // degradou: entrega fica em escrow (verificacao manual). Avisa so o responsavel.
      client?.send("ai:feedback", { status: "unavailable", score: -1, note: "" });
      return;
    }
    if (result.score >= 7) {
      // aprovado: gloria publica — verifica e mostra a nota a todos
      t.verified = true;
      t.verifiedBy = "IA";
      t.verifiedAt = Date.now();
      t.aiScore = result.score;
      t.aiNote = result.note;
      this.creditIfVerified(t); // F6: a IA aprovou -> credita PE (idempotente)
      this.persistBoard();
      client?.send("ai:feedback", { status: "verified", score: result.score, note: result.note });
    } else {
      // 4-6 (parcial) ou <4 (baixo): NAO verifica; feedback PRIVADO, nada publico no card
      const status = result.score >= 4 ? "partial" : "low";
      client?.send("ai:feedback", { status, score: result.score, note: result.note });
    }
  }

  /**
   * Acha o cliente que e o DONO ATUAL da entrega. Por memberId (sobrevive a reconexao: o
   * sessionId muda, mas o memberId nao). Convidado (deliveredBy = nome, sem memberId) cai no
   * sessionId capturado no deliver. Se ninguem casar (saiu de vez), o feedback se perde — ok:
   * a entrega fica em escrow e ele reentrega/ve o estado quando voltar.
   */
  private findDeliverer(deliveredBy: string, fallbackSessionId: string): Client | undefined {
    if (deliveredBy) {
      for (const c of this.clients) {
        const p = this.state.players.get(c.sessionId);
        if (p?.memberId && p.memberId === deliveredBy) return c;
      }
    }
    return this.clients.find((c) => c.sessionId === fallbackSessionId);
  }

  /** Serializa o board atual (tarefas + cores de cliente/membro) e agenda a gravacao. */
  private persistBoard() {
    const tasks: TaskData[] = [];
    this.state.tasks.forEach((t) => {
      tasks.push({
        id: t.id,
        title: t.title,
        desc: t.desc,
        assignee: t.assignee,
        client: t.client,
        due: t.due,
        col: t.col,
        order: t.order,
        archived: t.archived,
        unit: t.unit,
        createdAt: t.createdAt,
        completedAt: t.completedAt,
        committedDue: t.committedDue,
        dueChanges: t.dueChanges,
        delivered: t.delivered,
        deliveredAt: t.deliveredAt,
        deliveredBy: t.deliveredBy,
        deliveryFormat: t.deliveryFormat,
        proof: t.proof,
        deliverNote: t.deliverNote,
        verified: t.verified,
        verifiedBy: t.verifiedBy,
        verifiedAt: t.verifiedAt,
        aiScore: t.aiScore,
        aiNote: t.aiNote,
        blockReason: t.blockReason,
        blockedMs: t.blockedMs,
        blockedAt: t.blockedAt,
        scoreAwarded: t.scoreAwarded,
        awardedTo: t.awardedTo,
        awardedWeek: t.awardedWeek,
        size: t.size,
        clientWeight: t.clientWeight,
      });
    });
    const clients: ClientColor[] = [];
    this.state.clientColors.forEach((color, name) => clients.push({ name, color }));
    const members: ClientColor[] = [];
    this.state.memberColors.forEach((color, name) => members.push({ name, color }));
    saveBoard({ tasks, clients, members });
  }

  // ---------- cofre: helpers ----------

  /**
   * Autentica a acao no cofre. Devolve o memberId (trim) se o solicitante e membro logado;
   * senao manda "vault:denied" e devolve "". NUNCA confie em memberId vindo do payload — usa
   * SO o do Player (que veio do token verificado no onAuth).
   */
  private vaultAuth(client: Client): string {
    const p = this.state.players.get(client.sessionId);
    const mid = (p?.memberId || "").trim();
    if (mid === "") {
      client.send("vault:denied", {});
      return "";
    }
    return mid;
  }

  /** Corta uma string do payload no limite; se nao for string, devolve o fallback. */
  private vaultStr(v: unknown, max: number, fallback: string): string {
    return typeof v === "string" ? v.slice(0, max) : fallback;
  }

  /** Versao publica das entradas: SEM senha, COM hasPassword. Nunca vaza a senha. */
  private vaultPub(): EntryPub[] {
    return this.vaultEntries.map((e) => {
      const { password, ...rest } = e;
      return { ...rest, hasPassword: !!password };
    });
  }

  /** Re-manda "vault:list" (EntryPub[], sem senhas) so pros clientes com memberId != "". */
  private sendVaultListToAll(): void {
    const entries = this.vaultPub();
    for (const c of this.clients) {
      const p = this.state.players.get(c.sessionId);
      if ((p?.memberId || "").trim() === "") continue; // convidado nao recebe o cofre
      c.send("vault:list", { entries });
    }
  }

  /**
   * Identidade AUTENTICADA da sessão: vem do TOKEN emitido pelo /login (HMAC do memberId),
   * NUNCA do options.memberId cru — senão qualquer cliente se passa por outro (lê o progresso
   * privado, credita/estorna XP no nome alheio). Token ausente/inválido = convidado (memberId
   * vazio), que entra normalmente. O retorno vira client.auth.
   */
  onAuth(_client: Client, options: JoinOptions) {
    const token = String(options.authToken ?? "");
    const memberId = token ? verifyToken(token) : null;
    return { memberId: memberId ?? "" };
  }

  onJoin(client: Client, options: JoinOptions = {}) {
    const p = new Player();
    p.name = String(options.name ?? "Convidado").slice(0, 16) || "Convidado";
    p.charId = clamp(Number(options.charId ?? 0) | 0, 0, 9);
    p.x = Number.isFinite(options.x) ? Number(options.x) : 496;
    p.y = Number.isFinite(options.y) ? Number(options.y) : 592;
    p.dir = 0;
    p.moving = false;
    // identidade AUTENTICADA (do onAuth), não do options cru
    const auth = client.auth as { memberId?: string } | undefined;
    p.memberId = String(auth?.memberId ?? "").slice(0, 40);
    // F7: re-hidrata os stats do nível persistido. Convidado (sem memberId) = baseline 100/20 puro.
    const lvl = p.memberId ? getMember(p.memberId)?.level ?? 1 : 1;
    const st = p.memberId ? this.statsFor(lvl) : { maxHp: 100, dmg: 20 };
    p.level = lvl;
    p.maxHp = st.maxHp;
    p.dmg = st.dmg;
    p.hp = st.maxHp; // entra com vida cheia (até o teto do nível)
    this.state.players.set(client.sessionId, p);
    // F6: re-hidrata o progresso persistido e manda pro HUD do próprio jogador (privado).
    if (getFlags().progression && p.memberId) {
      const view = getProgressView(p.memberId);
      if (view) client.send("progress:self", view);
    }
    console.log(`[OfficeRoom] entrou: ${p.name} (${client.sessionId}) — ${this.clients.length} online`);
  }

  onLeave(client: Client) {
    const sid = client.sessionId;
    const name = this.state.players.get(sid)?.name ?? "";
    this.state.players.delete(sid);
    // F1: limpa o motor/caches e avisa quem o OUVIA (som de saída só se ele tinha voz)
    const others = this.aud.dropId(sid);
    const wasInVoice = (this.lkSids.get(sid)?.sids.length ?? 0) > 0;
    if (wasInVoice && others.length) {
      const bySid = new Map<string, Client>();
      for (const c of this.clients) bySid.set(c.sessionId, c);
      for (const otherId of others) bySid.get(otherId)?.send("prox:leave", { sid, name });
    }
    this.lkSids.delete(sid);
    for (const key of [...this.appliedSubs.keys()]) {
      if (key.startsWith(`${sid}>`) || key.endsWith(`>${sid}`)) this.appliedSubs.delete(key);
    }
    for (const key of [...this.subFlight.keys()]) {
      if (key.startsWith(`${sid}>`) || key.endsWith(`>${sid}`)) this.subFlight.delete(key);
    }
    this.voiceReadyAt.delete(sid);
    revokeVoiceNonce(sid);
    this.emoteAt.delete(sid);
    this.scribeSayAt.delete(sid);
    console.log(`[OfficeRoom] saiu: ${sid}`);
  }

  onDispose() {
    // grava na hora qualquer edicao pendente no debounce antes da sala morrer.
    // No redeploy do Coolify (SIGTERM) o Colyseus faz shutdown gracioso e chama
    // onDispose — sem isso as ultimas alteracoes do board se perderiam.
    flushBoardSync();
    flushProgressSync(); // grava o progresso de gamificacao pendente tambem
    flushVaultSync(); // grava o cofre cifrado pendente tambem
    console.log("[OfficeRoom] sala encerrada (board + progresso + cofre gravados)");
  }
}
