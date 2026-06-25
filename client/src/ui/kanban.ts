import { getStateCallbacks, type Room } from "../net/room";

/** Gestor de tarefas (kanban) — overlay HTML compartilhado, sincronizado via Colyseus. */

type ColKey = "backlog" | "afazer" | "fazendo" | "travado" | "feito";

const COLUMNS: { key: ColKey; label: string; color: string }[] = [
  { key: "backlog", label: "Backlog", color: "#6b7280" },
  { key: "afazer", label: "A fazer", color: "#3b82f6" },
  { key: "fazendo", label: "Fazendo", color: "#6366f1" },
  { key: "travado", label: "Travado", color: "#ef4444" },
  { key: "feito", label: "Feito", color: "#22c55e" },
];

type TaskView = {
  id: string;
  title: string;
  desc: string;
  assignee: string;
  client: string;
  due: string;
  col: string;
  order: number;
};

/** Cor consistente (pastel) derivada do nome — chips de cliente/responsavel. */
function tagColor(name: string): { bg: string; fg: string } {
  if (!name) return { bg: "#e5e7eb", fg: "#374151" };
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return { bg: `hsl(${hue} 70% 90%)`, fg: `hsl(${hue} 55% 30%)` };
}

/** Dias em atraso: hoje - entrega, so se passou e nao esta em "Feito". */
function daysOverdue(due: string, col: string): number {
  if (!due || col === "feito") return 0;
  const d = new Date(`${due}T00:00:00`);
  if (Number.isNaN(d.getTime())) return 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.floor((today.getTime() - d.getTime()) / 86400000);
  return diff > 0 ? diff : 0;
}

function fmtDate(due: string): string {
  if (!due) return "";
  const d = new Date(`${due}T00:00:00`);
  if (Number.isNaN(d.getTime())) return due;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const STYLE_ID = "kb-styles";
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
.kb-overlay{position:fixed;inset:0;z-index:10000;display:none;flex-direction:column;
  background:#0b0a12ee;font-family:system-ui,Segoe UI,monospace;color:#1f2937;}
.kb-overlay.open{display:flex;}
.kb-top{display:flex;align-items:center;gap:12px;padding:10px 16px;background:#15131d;
  color:#f0e6c8;border-bottom:1px solid #2a2636;flex:0 0 auto;}
.kb-top h2{font-size:16px;margin:0;font-weight:600;}
.kb-top .sp{flex:1;}
.kb-btn{font:13px system-ui;cursor:pointer;border:none;border-radius:8px;padding:7px 12px;color:#fff;}
.kb-btn.stream{background:#2a7a3a;}
.kb-btn.stream.on{background:#b9892a;}
.kb-btn.close{background:#3a3340;}
.kb-board{flex:1;display:flex;gap:12px;overflow-x:auto;padding:14px;align-items:flex-start;
  background:#11101a;}
.kb-col{flex:0 0 270px;display:flex;flex-direction:column;max-height:100%;
  background:#f4f5f7;border-radius:10px;padding:8px;}
.kb-col-head{display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:0 4px;}
.kb-pill{font-size:12px;font-weight:600;color:#fff;border-radius:6px;padding:3px 9px;}
.kb-count{font-size:12px;color:#6b7280;}
.kb-cards{display:flex;flex-direction:column;gap:8px;overflow-y:auto;min-height:24px;padding:2px;}
.kb-cards.dragover{outline:2px dashed #9ca3af;outline-offset:-2px;border-radius:8px;}
.kb-card{background:#fff;border:1.5px solid #e5e7eb;border-left-width:4px;border-radius:8px;
  padding:9px 10px;cursor:grab;box-shadow:0 1px 2px #0001;}
.kb-card:hover{box-shadow:0 2px 8px #0002;}
.kb-card.dragging{opacity:.45;}
.kb-card .t{font-size:13px;font-weight:600;line-height:1.25;margin-bottom:6px;word-break:break-word;}
.kb-card .meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;color:#6b7280;}
.kb-chip{font-size:11px;font-weight:600;border-radius:5px;padding:2px 7px;}
.kb-late{background:#fee2e2;color:#b91c1c;font-weight:700;border-radius:5px;padding:2px 6px;font-size:11px;}
.kb-add{margin-top:8px;font:12px system-ui;color:#4b5563;background:#e9eaee;border:none;
  border-radius:7px;padding:7px;cursor:pointer;width:100%;text-align:left;}
.kb-add:hover{background:#dfe1e6;}
.kb-modal-bg{position:fixed;inset:0;z-index:10002;display:none;align-items:center;
  justify-content:center;background:#000a;}
.kb-modal-bg.open{display:flex;}
.kb-modal{background:#fff;border-radius:12px;padding:18px;width:min(440px,92vw);
  max-height:90vh;overflow:auto;box-shadow:0 10px 40px #000a;}
.kb-modal h3{margin:0 0 12px;font-size:16px;}
.kb-field{margin-bottom:11px;}
.kb-field label{display:block;font-size:12px;color:#6b7280;margin-bottom:4px;font-weight:600;}
.kb-field input,.kb-field textarea,.kb-field select{width:100%;box-sizing:border-box;
  font:14px system-ui;padding:8px 9px;border:1.5px solid #d1d5db;border-radius:7px;outline:none;}
.kb-field textarea{min-height:64px;resize:vertical;}
.kb-modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;}
.kb-modal-actions .del{margin-right:auto;background:#fee2e2;color:#b91c1c;}
`;
  document.head.appendChild(s);
}

export class KanbanBoard {
  private room: Room;
  private $: (obj: unknown) => any;
  private overlay: HTMLDivElement;
  private boardEl: HTMLDivElement;
  private streamBtn: HTMLButtonElement;
  private modalBg: HTMLDivElement;
  private opened = false;
  private openedByStream = false;
  private dragging = false;
  private rafQueued = false;
  private streaming = false;
  /** chamado quando o usuario liga/desliga o stream (OfficeScene avisa o servidor) */
  onStreamChange?: (on: boolean) => void;

  constructor(room: Room) {
    this.room = room;
    this.$ = getStateCallbacks(room) as unknown as (obj: unknown) => any;
    injectStyles();

    this.overlay = document.createElement("div");
    this.overlay.className = "kb-overlay";
    const top = document.createElement("div");
    top.className = "kb-top";
    const h2 = document.createElement("h2");
    h2.textContent = "📋 Gestor de Tarefas";
    const sp = document.createElement("div");
    sp.className = "sp";
    this.streamBtn = document.createElement("button");
    this.streamBtn.className = "kb-btn stream";
    this.streamBtn.textContent = "📡 Stream";
    this.streamBtn.onclick = () => this.toggleStream();
    const closeBtn = document.createElement("button");
    closeBtn.className = "kb-btn close";
    closeBtn.textContent = "✕ Fechar";
    closeBtn.onclick = () => this.close();
    top.append(h2, sp, this.streamBtn, closeBtn);

    this.boardEl = document.createElement("div");
    this.boardEl.className = "kb-board";
    this.overlay.append(top, this.boardEl);
    document.body.appendChild(this.overlay);

    this.modalBg = document.createElement("div");
    this.modalBg.className = "kb-modal-bg";
    this.modalBg.onclick = (e) => {
      if (e.target === this.modalBg) this.closeModal();
    };
    document.body.appendChild(this.modalBg);

    // sincronizacao ao vivo: qualquer mudanca no board re-renderiza
    const tasks = this.$(room.state).tasks;
    tasks.onAdd((t: unknown) => {
      this.$(t).onChange(() => this.scheduleRender());
      this.scheduleRender();
    });
    tasks.onRemove(() => this.scheduleRender());
  }

  isOpen(): boolean {
    return this.opened;
  }
  isStreamOpened(): boolean {
    return this.openedByStream;
  }

  open(byStream = false) {
    if (!byStream) this.openedByStream = false;
    else if (!this.opened) this.openedByStream = true;
    this.opened = true;
    this.overlay.classList.add("open");
    this.render();
  }

  close() {
    this.opened = false;
    this.openedByStream = false;
    this.overlay.classList.remove("open");
    this.closeModal();
    if (this.streaming) this.toggleStream(); // fechar = parar de streamar
  }

  toggle() {
    if (this.opened) this.close();
    else this.open(false);
  }

  private toggleStream() {
    this.streaming = !this.streaming;
    this.streamBtn.classList.toggle("on", this.streaming);
    this.streamBtn.textContent = this.streaming ? "📡 Streamando" : "📡 Stream";
    this.onStreamChange?.(this.streaming);
  }

  private scheduleRender() {
    if (!this.opened || this.dragging || this.rafQueued) return;
    this.rafQueued = true;
    requestAnimationFrame(() => {
      this.rafQueued = false;
      if (this.opened && !this.dragging) this.render();
    });
  }

  private allTasks(): TaskView[] {
    const out: TaskView[] = [];
    const tasks = (this.room.state as unknown as { tasks: Map<string, TaskView> }).tasks;
    tasks.forEach((t) => {
      out.push({
        id: t.id,
        title: t.title,
        desc: t.desc,
        assignee: t.assignee,
        client: t.client,
        due: t.due,
        col: t.col,
        order: t.order,
      });
    });
    return out;
  }

  private knownValues(field: "client" | "assignee"): string[] {
    const set = new Set<string>();
    for (const t of this.allTasks()) {
      const v = t[field];
      if (v) set.add(v);
    }
    return [...set].sort();
  }

  private render() {
    const all = this.allTasks();
    this.boardEl.innerHTML = "";
    for (const c of COLUMNS) {
      const cards = all.filter((t) => t.col === c.key).sort((a, b) => a.order - b.order);
      const col = document.createElement("div");
      col.className = "kb-col";

      const head = document.createElement("div");
      head.className = "kb-col-head";
      const pill = document.createElement("span");
      pill.className = "kb-pill";
      pill.style.background = c.color;
      pill.textContent = c.label;
      const count = document.createElement("span");
      count.className = "kb-count";
      count.textContent = String(cards.length);
      head.append(pill, count);

      const list = document.createElement("div");
      list.className = "kb-cards";
      list.dataset.col = c.key;
      for (const t of cards) list.appendChild(this.cardEl(t, c.color));

      // drop zone
      list.addEventListener("dragover", (e) => {
        e.preventDefault();
        list.classList.add("dragover");
      });
      list.addEventListener("dragleave", () => list.classList.remove("dragover"));
      list.addEventListener("drop", (e) => {
        e.preventDefault();
        list.classList.remove("dragover");
        const id = e.dataTransfer?.getData("text/plain");
        if (id) this.dropCard(id, c.key, list, e.clientY);
      });

      const add = document.createElement("button");
      add.className = "kb-add";
      add.textContent = "+ Adicionar tarefa";
      add.onclick = () => this.openEditor(null, c.key);

      col.append(head, list, add);
      this.boardEl.appendChild(col);
    }
  }

  private cardEl(t: TaskView, colColor: string): HTMLDivElement {
    const card = document.createElement("div");
    card.className = "kb-card";
    card.style.borderLeftColor = colColor;
    card.draggable = true;
    card.dataset.id = t.id;

    const title = document.createElement("div");
    title.className = "t";
    title.textContent = t.title || "(sem titulo)";
    card.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "meta";
    if (t.due) {
      const dt = document.createElement("span");
      dt.textContent = fmtDate(t.due);
      meta.appendChild(dt);
    }
    const late = daysOverdue(t.due, t.col);
    if (late > 0) {
      const lt = document.createElement("span");
      lt.className = "kb-late";
      lt.textContent = `${late}d atraso`;
      meta.appendChild(lt);
    }
    if (t.client) {
      const ch = document.createElement("span");
      ch.className = "kb-chip";
      const col = tagColor(t.client);
      ch.style.background = col.bg;
      ch.style.color = col.fg;
      ch.textContent = t.client;
      meta.appendChild(ch);
    }
    if (t.assignee) {
      const as = document.createElement("span");
      as.className = "kb-chip";
      const col = tagColor(t.assignee);
      as.style.background = col.bg;
      as.style.color = col.fg;
      as.textContent = `👤 ${t.assignee}`;
      meta.appendChild(as);
    }
    if (meta.childElementCount) card.appendChild(meta);

    card.onclick = () => {
      if (!this.dragging) this.openEditor(t, t.col);
    };
    card.addEventListener("dragstart", (e) => {
      this.dragging = true;
      card.classList.add("dragging");
      e.dataTransfer?.setData("text/plain", t.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => {
      this.dragging = false;
      card.classList.remove("dragging");
      this.render();
    });
    return card;
  }

  /** Calcula a ordem fracionaria pela posicao do drop e move o card. */
  private dropCard(id: string, col: ColKey, list: HTMLDivElement, clientY: number) {
    const siblings = [...list.querySelectorAll<HTMLDivElement>(".kb-card")].filter(
      (el) => el.dataset.id !== id,
    );
    const orderOf = (el: HTMLDivElement) =>
      this.allTasks().find((t) => t.id === el.dataset.id)?.order ?? 0;
    let before: HTMLDivElement | null = null;
    for (const el of siblings) {
      const r = el.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) {
        before = el;
        break;
      }
    }
    let order: number;
    if (!siblings.length) order = 0;
    else if (!before) order = orderOf(siblings[siblings.length - 1]) + 1;
    else {
      const idx = siblings.indexOf(before);
      const prev = idx > 0 ? orderOf(siblings[idx - 1]) : orderOf(before) - 1;
      order = (prev + orderOf(before)) / 2;
    }
    this.room.send("task:move", { id, col, order });
  }

  // ---------- modal criar/editar ----------

  private openEditor(task: TaskView | null, col: string) {
    const editing = !!task;
    this.modalBg.innerHTML = "";
    const m = document.createElement("div");
    m.className = "kb-modal";
    m.onclick = (e) => e.stopPropagation();

    const h3 = document.createElement("h3");
    h3.textContent = editing ? "Editar tarefa" : "Nova tarefa";
    m.appendChild(h3);

    const mk = (
      label: string,
      el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    ) => {
      const f = document.createElement("div");
      f.className = "kb-field";
      const l = document.createElement("label");
      l.textContent = label;
      f.append(l, el);
      m.appendChild(f);
      return el;
    };

    const title = document.createElement("input");
    title.value = task?.title ?? "";
    title.placeholder = "Nome da tarefa";
    mk("Nome da tarefa", title);

    const desc = document.createElement("textarea");
    desc.value = task?.desc ?? "";
    mk("Descrição", desc);

    const assignee = document.createElement("input");
    assignee.value = task?.assignee ?? "";
    assignee.setAttribute("list", "kb-assignees");
    mk("Responsável", assignee);

    const client = document.createElement("input");
    client.value = task?.client ?? "";
    client.setAttribute("list", "kb-clients");
    mk("Cliente", client);

    const due = document.createElement("input");
    due.type = "date";
    due.value = task?.due ?? "";
    mk("Data de entrega", due);

    const colSel = document.createElement("select");
    for (const c of COLUMNS) {
      const o = document.createElement("option");
      o.value = c.key;
      o.textContent = c.label;
      colSel.appendChild(o);
    }
    colSel.value = task?.col ?? col;
    mk("Coluna", colSel);

    // datalists (lista gerenciada: sugere valores ja usados)
    const dlA = document.createElement("datalist");
    dlA.id = "kb-assignees";
    for (const v of this.knownValues("assignee")) {
      const o = document.createElement("option");
      o.value = v;
      dlA.appendChild(o);
    }
    const dlC = document.createElement("datalist");
    dlC.id = "kb-clients";
    for (const v of this.knownValues("client")) {
      const o = document.createElement("option");
      o.value = v;
      dlC.appendChild(o);
    }
    m.append(dlA, dlC);

    const actions = document.createElement("div");
    actions.className = "kb-modal-actions";
    if (editing) {
      const del = document.createElement("button");
      del.className = "kb-btn del";
      del.textContent = "🗑 Deletar";
      del.onclick = () => {
        if (task) this.room.send("task:delete", { id: task.id });
        this.closeModal();
      };
      actions.appendChild(del);
    }
    const cancel = document.createElement("button");
    cancel.className = "kb-btn close";
    cancel.textContent = "Cancelar";
    cancel.onclick = () => this.closeModal();
    const save = document.createElement("button");
    save.className = "kb-btn stream";
    save.textContent = "Salvar";
    save.onclick = () => {
      const payload = {
        title: title.value.trim(),
        desc: desc.value,
        assignee: assignee.value.trim(),
        client: client.value.trim(),
        due: due.value,
        col: colSel.value,
      };
      if (editing && task) this.room.send("task:update", { id: task.id, ...payload });
      else this.room.send("task:create", payload);
      this.closeModal();
    };
    actions.append(cancel, save);
    m.appendChild(actions);

    this.modalBg.appendChild(m);
    this.modalBg.classList.add("open");
    title.focus();
  }

  private closeModal() {
    this.modalBg.classList.remove("open");
    this.modalBg.innerHTML = "";
  }

  destroy() {
    this.overlay.remove();
    this.modalBg.remove();
  }
}
