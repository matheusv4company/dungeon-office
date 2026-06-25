import { Room, Client } from "colyseus";
import { OfficeState } from "../schema/OfficeState";
import { Player } from "../schema/Player";
import { Task } from "../schema/Task";
import { loadBoard, saveBoard, type TaskData, type ClientColor } from "../board/store";

type JoinOptions = { name?: string; charId?: number; x?: number; y?: number };
type MoveMsg = { x?: number; y?: number; dir?: number; moving?: boolean };
type CallMsg = { to?: string };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const COLS = new Set(["backlog", "afazer", "fazendo", "travado", "feito"]);

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
      this.state.tasks.set(t.id, t);
    }
    for (const c of board.clients) {
      if (c?.name && c?.color) this.state.clientColors.set(c.name, c.color);
    }

    // Client-authoritative: cada cliente envia sua posicao; retransmitimos.
    this.onMessage("move", (client, msg: MoveMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof msg.x === "number") p.x = msg.x;
      if (typeof msg.y === "number") p.y = msg.y;
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
      target.hp = Math.max(0, target.hp - 20);
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
        t.col = col;
      let maxOrder = -1; // posiciona no fim da coluna
      this.state.tasks.forEach((x) => {
        if (x.col === col && x.order > maxOrder) maxOrder = x.order;
      });
      t.order = maxOrder + 1;
      this.state.tasks.set(t.id, t);
      this.persistBoard();
    });

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
        },
      ) => {
        const t = this.state.tasks.get(String(msg?.id ?? ""));
        if (!t) return;
        if (typeof msg.title === "string") t.title = msg.title.slice(0, 200);
        if (typeof msg.desc === "string") t.desc = msg.desc.slice(0, 4000);
        if (typeof msg.assignee === "string") t.assignee = msg.assignee.slice(0, 60);
        if (typeof msg.client === "string") t.client = msg.client.slice(0, 60);
        if (typeof msg.due === "string") t.due = msg.due.slice(0, 10);
        if (typeof msg.archived === "boolean") t.archived = msg.archived;
        if (COLS.has(String(msg?.col)) && msg.col !== t.col) {
          // trocou de coluna pelo modal: vai pro fim da coluna nova
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
      if (COLS.has(String(msg?.col))) t.col = String(msg.col);
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

    // arquiva todos os cards em "Feito" (somem do board, mas ficam no historico)
    this.onMessage("board:archiveDone", () => {
      let changed = false;
      this.state.tasks.forEach((t) => {
        if (t.col === "feito" && !t.archived) {
          t.archived = true;
          changed = true;
        }
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

    // "stream" do board: marca/desmarca — quem estiver perto ve/edita junto.
    this.onMessage("board:stream", (client, msg: { on?: boolean }) => {
      const p = this.state.players.get(client.sessionId);
      if (p) p.streamingBoard = !!msg?.on;
    });

    console.log("[OfficeRoom] sala criada");
  }

  /** Serializa o board atual (tarefas + cores de cliente) e agenda a gravacao. */
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
      });
    });
    const clients: ClientColor[] = [];
    this.state.clientColors.forEach((color, name) => clients.push({ name, color }));
    saveBoard({ tasks, clients });
  }

  onJoin(client: Client, options: JoinOptions = {}) {
    const p = new Player();
    p.name = String(options.name ?? "Convidado").slice(0, 16) || "Convidado";
    p.charId = clamp(Number(options.charId ?? 0) | 0, 0, 9);
    p.x = Number.isFinite(options.x) ? Number(options.x) : 496;
    p.y = Number.isFinite(options.y) ? Number(options.y) : 592;
    p.dir = 0;
    p.moving = false;
    this.state.players.set(client.sessionId, p);
    console.log(`[OfficeRoom] entrou: ${p.name} (${client.sessionId}) — ${this.clients.length} online`);
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    console.log(`[OfficeRoom] saiu: ${client.sessionId}`);
  }
}
