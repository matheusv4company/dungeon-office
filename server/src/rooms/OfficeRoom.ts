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
  type ProgressView,
} from "../progress/store";
import { getFlags } from "../gamification/flags";
import { reviewDelivery } from "../gamification/aiReview";

type JoinOptions = { name?: string; charId?: number; x?: number; y?: number; memberId?: string };
type MoveMsg = { x?: number; y?: number; dir?: number; moving?: boolean };
type CallMsg = { to?: string };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
// dimensoes do mapa em px (espelham client/OfficeScene: COLS*T x ROWS*T = 30*32 x 57*32)
const MAP_W = 960;
const MAP_H = 1824;
const COLS = new Set(["backlog", "afazer", "fazendo", "travado", "feito"]);
const UNITS = new Set(["", "ia", "mkt"]); // empresa dona da tarefa
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

    // ---------- F2: gate de entrega (escrow — "Feito" sozinho NAO credita) ----------

    // Entregar ao cliente: exige prova (link). Carimba deliveredAt no SERVIDOR (anti-forja).
    // Fica "aguardando verificacao" — nenhum ponto e creditado aqui (escrow).
    this.onMessage("task:deliver", (client, msg: { id?: string; proof?: string; note?: string }) => {
      if (!getFlags().gate) return; // feature desligada -> no-op
      const t = this.state.tasks.get(String(msg?.id ?? ""));
      if (!t || t.col !== "feito") return; // so entrega o que esta em "Feito"
      if (t.delivered) return; // ja entregue: use "Devolver" antes de reentregar (nao recarimba/forja)
      const proof = String(msg?.proof ?? "").trim().slice(0, 300);
      if (!/^https?:\/\/\S+/i.test(proof)) return; // prova precisa ser link verificavel (espelha o cliente)
      const p = this.state.players.get(client.sessionId);
      t.delivered = true;
      t.deliveredAt = Date.now(); // carimbo autoritativo do servidor
      t.deliveredBy = (p?.memberId || p?.name || "").slice(0, 60);
      t.proof = proof;
      t.deliverNote = String(msg?.note ?? "").trim().slice(0, 280);
      t.verified = false; // aguarda verificacao (IA em F3 ou sign-off manual)
      this.persistBoard();
      // F3: avaliacao da IA em segundo plano (nao bloqueia o board). So se o flag estiver on.
      if (getFlags().aiReview) void this.runAiReview(t.id, client.sessionId);
    });

    // Verificar (sign-off): libera o selo verde + carimba QUEM verificou (anti-forja simetrico;
    // base pro F6 sinalizar conluio). F2 nao credita ponto (isso e F6). O design permite o dono da
    // conta assinar a propria entrega, entao NAO bloqueio self-verify aqui — o carimbo fica de registro.
    this.onMessage("task:verify", (client, msg: { id?: string }) => {
      if (!getFlags().gate) return;
      const t = this.state.tasks.get(String(msg?.id ?? ""));
      if (!t || !t.delivered) return; // so verifica o que foi entregue
      const p = this.state.players.get(client.sessionId);
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

    console.log("[OfficeRoom] sala criada");
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
    // FatorPrazo: deliveredAt (servidor) vs prazo congelado ESTENDIDO pelo tempo em "Travado"
    // (bloqueio externo não conta como atraso — culpa não é da pessoa). Atrasou -> ×0.6 (ainda paga).
    // Se nunca congelou committedDue (card antigo, entrou em "feito" antes do fix), cai pro due.
    let committed = t.committedDue;
    if (committed === 0 && t.due) {
      const ms = Date.parse(t.due + "T23:59:59");
      if (Number.isFinite(ms)) committed = ms;
    }
    const prazo = committed > 0 ? committed + t.blockedMs : 0;
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
  private async runAiReview(taskId: string, sessionId: string) {
    const t0 = this.state.tasks.get(taskId);
    if (!t0) return;
    const deliveredAt0 = t0.deliveredAt; // token de identidade DESTA entrega (anti-race)
    // snapshot pro prompt (a tarefa pode mudar enquanto a IA pensa)
    const result = await reviewDelivery({
      title: t0.title,
      desc: t0.desc,
      client: t0.client,
      unit: t0.unit,
      proof: t0.proof,
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

  onJoin(client: Client, options: JoinOptions = {}) {
    const p = new Player();
    p.name = String(options.name ?? "Convidado").slice(0, 16) || "Convidado";
    p.charId = clamp(Number(options.charId ?? 0) | 0, 0, 9);
    p.x = Number.isFinite(options.x) ? Number(options.x) : 496;
    p.y = Number.isFinite(options.y) ? Number(options.y) : 592;
    p.dir = 0;
    p.moving = false;
    p.memberId = String(options.memberId ?? "").slice(0, 40); // identidade de gamificacao
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
    this.state.players.delete(client.sessionId);
    console.log(`[OfficeRoom] saiu: ${client.sessionId}`);
  }

  onDispose() {
    // grava na hora qualquer edicao pendente no debounce antes da sala morrer.
    // No redeploy do Coolify (SIGTERM) o Colyseus faz shutdown gracioso e chama
    // onDispose — sem isso as ultimas alteracoes do board se perderiam.
    flushBoardSync();
    flushProgressSync(); // grava o progresso de gamificacao pendente tambem
    console.log("[OfficeRoom] sala encerrada (board + progresso gravados)");
  }
}
