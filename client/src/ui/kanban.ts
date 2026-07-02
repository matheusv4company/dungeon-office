import { getStateCallbacks, type Room } from "../net/room";
import { getFlags } from "../net/config";
import { daysToDue } from "../util/overdue";

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
  archived: boolean;
  unit: string; // "" | "ia" | "mkt"
  // F2 — gate de entrega
  delivered: boolean;
  deliveredBy: string;
  proof: string;
  deliverNote: string;
  verified: boolean;
  // F3 — nota da IA (pública só quando aprovada)
  aiScore: number;
  aiNote: string;
  // F4 — atraso amigável
  committedDue: number; // prazo congelado (ms); 0 = ainda não congelado, cai no due
  blockReason: string; // motivo do "Travado" (pausa o relógio)
  blockedMs: number; // tempo acumulado em "Travado" (estende o prazo)
  // F6 — progressão (peso pra PE)
  size: string; // "" | PP | P | M | G | GG
  clientWeight: number; // 70 | 100 | 150
};

// empresas (categoria IA / Marketing) — rotulo + cor do selo no card
const UNIT_META: Record<string, { label: string; color: string }> = {
  ia: { label: "IA", color: "#14b8a6" },
  mkt: { label: "Marketing", color: "#f59e0b" },
};
const UNIT_OPTS: { value: string; label: string }[] = [
  { value: "", label: "— nenhuma —" },
  { value: "ia", label: "IA" },
  { value: "mkt", label: "Marketing" },
];
// F6 — tamanho (esforço) e peso do cliente, que pesam os Pontos de Entrega
const SIZE_OPTS: { value: string; label: string }[] = [
  { value: "", label: "— tamanho — (assume M)" },
  { value: "PP", label: "PP — mínimo" },
  { value: "P", label: "P — pequeno" },
  { value: "M", label: "M — médio" },
  { value: "G", label: "G — grande" },
  { value: "GG", label: "GG — enorme" },
];
const WEIGHT_OPTS: { value: number; label: string }[] = [
  { value: 70, label: "Interno / baixa criticidade (×0.7)" },
  { value: 100, label: "Normal (×1.0)" },
  { value: 150, label: "Estratégico / crítico (×1.5)" },
];

// paleta fixa de cores p/ chips automaticos (consistente por nome)
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
function contrast(hex: string): string {
  const c = hex.replace("#", "");
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? "#1f2937" : "#ffffff";
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
/** Monta o chip de prazo escalonado (ou null se não há nada a mostrar). Tom de SOCORRO, nunca culpa. */
function overdueChip(t: TaskView): HTMLSpanElement | null {
  const d = daysToDue(t.due, t.col, t.blockedMs);
  if (d === null) return null; // feito/travado/sem prazo
  let cls: string, text: string, tip: string;
  if (d < 0) {
    const late = -d;
    if (late >= 6) {
      cls = "od-rescue";
      text = `🆘 ${late}d — resgate`;
      tip = "missão de resgate: quem pode ajudar a fechar?";
    } else {
      cls = "od-late";
      text = `🆘 ${late}d atrasada`;
      tip = "precisa de ajuda pra destravar?";
    }
  } else if (d === 0) {
    cls = "od-today";
    text = "📅 vence hoje";
    tip = "dá pra fechar hoje? 💪";
  } else if (d <= 2) {
    cls = "od-soon";
    text = `⏳ vence em ${d}d`;
    tip = "chegando — de olho 🙂";
  } else {
    return null; // mais de 2 dias: sem chip (não polui)
  }
  const sp = document.createElement("span");
  sp.className = `kb-chip ${cls}`;
  sp.textContent = text;
  sp.title = tip;
  return sp;
}
function fmtDate(due: string): string {
  if (!due) return "";
  const d = new Date(`${due}T00:00:00`);
  if (Number.isNaN(d.getTime())) return due;
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
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
.kb-top,.kb-toolbar{display:flex;align-items:center;gap:10px;padding:9px 16px;background:#15131d;
  color:#f0e6c8;flex:0 0 auto;flex-wrap:wrap;}
.kb-top{border-bottom:1px solid #2a2636;}
.kb-toolbar{background:#1b1925;border-bottom:1px solid #2a2636;font-size:12px;}
.kb-top h2{font-size:16px;margin:0;font-weight:600;}
.kb-top .sp{flex:1;}
.kb-seg{display:inline-flex;border:1px solid #3a3550;border-radius:8px;overflow:hidden;}
.kb-seg-btn{font:12px system-ui;cursor:pointer;border:none;background:#0f0e16;color:#cfc7b0;padding:7px 13px;}
.kb-seg-btn+.kb-seg-btn{border-left:1px solid #3a3550;}
.kb-seg-btn.active{background:#b9892a;color:#fff;font-weight:600;}
.kb-btn{font:13px system-ui;cursor:pointer;border:none;border-radius:8px;padding:7px 12px;color:#fff;}
.kb-btn.stream{background:#2a7a3a;}
.kb-btn.stream.on{background:#b9892a;}
.kb-btn.close{background:#3a3340;}
.kb-btn.ghost{background:#2f2b3a;color:#e8e0c8;}
.kb-toolbar input[type=search],.kb-toolbar select{font:12px system-ui;padding:6px 8px;border-radius:7px;
  border:1px solid #3a3550;background:#0f0e16;color:#e8e0c8;outline:none;}
.kb-toolbar label{display:flex;align-items:center;gap:5px;color:#cfc7b0;cursor:pointer;user-select:none;}
.kb-board{flex:1;display:flex;gap:12px;overflow-x:auto;padding:14px;align-items:flex-start;background:#11101a;}
.kb-col{flex:0 0 270px;display:flex;flex-direction:column;max-height:100%;background:#f4f5f7;
  border-radius:10px;padding:8px;}
.kb-col-head{display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:0 4px;}
.kb-pill{font-size:12px;font-weight:600;color:#fff;border-radius:6px;padding:3px 9px;}
.kb-count{font-size:12px;color:#6b7280;}
.kb-arch{margin-left:auto;font-size:11px;color:#6b7280;background:#e9eaee;border:none;border-radius:6px;
  padding:3px 8px;cursor:pointer;}
.kb-arch:hover{background:#dfe1e6;}
.kb-cards{display:flex;flex-direction:column;gap:8px;overflow-y:auto;min-height:24px;padding:2px;}
.kb-cards.dragover{outline:2px dashed #9ca3af;outline-offset:-2px;border-radius:8px;}
.kb-card{background:#fff;border:1.5px solid #e5e7eb;border-left-width:4px;border-radius:8px;
  padding:9px 10px;cursor:grab;box-shadow:0 1px 2px #0001;touch-action:none;user-select:none;}
.kb-card:hover{box-shadow:0 2px 8px #0002;}
.kb-card.archived{opacity:.55;}
.kb-card.placeholder{background:#dbe4ff;border:1.5px dashed #93a4d6;min-height:34px;}
.kb-ghost{position:fixed;z-index:10050;width:250px;pointer-events:none;opacity:.92;
  transform:rotate(2deg);box-shadow:0 8px 24px #0005;}
.kb-card .t{font-size:13px;font-weight:600;line-height:1.25;margin-bottom:6px;word-break:break-word;}
.kb-card .meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;color:#6b7280;}
.kb-chip{font-size:11px;font-weight:600;border-radius:5px;padding:2px 7px;}
.kb-late{background:#fee2e2;color:#b91c1c;font-weight:700;border-radius:5px;padding:2px 6px;font-size:11px;}
/* F4 — chips de prazo com tom de socorro (escalonados) */
.kb-chip.od-soon{background:#fef9c3;color:#854d0e;}
.kb-chip.od-today{background:#ffedd5;color:#9a3412;}
.kb-chip.od-late{background:#fee2e2;color:#b91c1c;font-weight:700;}
.kb-chip.od-rescue{background:#b91c1c;color:#fff;font-weight:700;}
.kb-chip.od-block{background:#e5e7eb;color:#374151;}
/* F2 — gate de entrega no card de "Feito" */
.kb-gate{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:8px;padding-top:8px;
  border-top:1px dashed #e5e7eb;}
.kb-seal{font-size:11px;font-weight:700;border-radius:5px;padding:2px 8px;}
.kb-seal.wait{background:#e5e7eb;color:#6b7280;}
.kb-seal.ok{background:#dcfce7;color:#15803d;}
.kb-gbtn{font:11px system-ui;cursor:pointer;border:none;border-radius:6px;padding:5px 10px;font-weight:600;}
.kb-gbtn.deliver{background:#2563eb;color:#fff;}
.kb-gbtn.deliver:hover{background:#1d4ed8;}
.kb-gbtn.verify{background:#16a34a;color:#fff;}
.kb-gbtn.undo{background:#f3f4f6;color:#6b7280;}
.kb-gate a.proof{font-size:11px;color:#2563eb;text-decoration:underline;word-break:break-all;}
.kb-gate .by{font-size:10px;color:#9ca3af;width:100%;}
.kb-deliver-hint{font-size:12px;color:#15803d;background:#f0fdf4;border:1px solid #bbf7d0;
  border-radius:7px;padding:8px 10px;margin-bottom:11px;}
.kb-err{color:#b91c1c;font-size:12px;margin-top:4px;min-height:14px;}
.kb-add{margin-top:8px;font:12px system-ui;color:#4b5563;background:#e9eaee;border:none;border-radius:7px;
  padding:7px;cursor:pointer;width:100%;text-align:left;}
.kb-add:hover{background:#dfe1e6;}
.kb-modal-bg{position:fixed;inset:0;z-index:10052;display:none;align-items:center;justify-content:center;background:#000a;}
.kb-modal-bg.open{display:flex;}
.kb-modal{background:#fff;border-radius:12px;padding:18px;width:min(460px,92vw);max-height:90vh;
  overflow:auto;box-shadow:0 10px 40px #000a;}
.kb-modal h3{margin:0 0 12px;font-size:16px;}
.kb-field{margin-bottom:11px;}
.kb-field label{display:block;font-size:12px;color:#6b7280;margin-bottom:4px;font-weight:600;}
.kb-field input,.kb-field textarea,.kb-field select{width:100%;box-sizing:border-box;font:14px system-ui;
  padding:8px 9px;border:1.5px solid #d1d5db;border-radius:7px;outline:none;}
.kb-field textarea{min-height:64px;resize:vertical;}
.kb-modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;}
.kb-modal-actions .del{margin-right:auto;background:#fee2e2;color:#b91c1c;}
.kb-modal-actions .del.confirm{background:#b91c1c;color:#fff;}
.kb-cli-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #eee;}
.kb-cli-row .nm{flex:1;font-size:13px;}
.kb-cli-row input[type=color]{width:34px;height:28px;border:1px solid #ccc;border-radius:6px;padding:0;background:none;cursor:pointer;}
.kb-cli-row .ren{font-size:11px;background:#eef;border:none;border-radius:6px;padding:4px 8px;cursor:pointer;}
`;
  document.head.appendChild(s);
}

type Filter = {
  text: string;
  client: string;
  assignee: string;
  unit: string;
  lateOnly: boolean;
  showArchived: boolean;
};

export class KanbanBoard {
  private room: Room;
  private $: (obj: unknown) => any;
  private overlay: HTMLDivElement;
  private boardEl: HTMLDivElement;
  private streamBtn!: HTMLButtonElement;
  private modalBg: HTMLDivElement;
  private opened = false;
  private openedByStream = false;
  private streamDismissed = false; // usuario fechou um board aberto por stream
  private dragging = false;
  private rafQueued = false;
  private streaming = false;
  private filter: Filter = {
    text: "", client: "", assignee: "", unit: "", lateOnly: false, showArchived: false,
  };
  onStreamChange?: (on: boolean) => void;
  /** avisa o escritório quando o board abre/fecha, pra ele desligar o input do Phaser
   *  (senão o clique no kanban vaza pro canvas embaixo e muta/chama sem querer). */
  onOpenChange?: (open: boolean) => void;
  /** canceladores dos askText abertos — pra não deixar overlay órfão se o board fechar/reconectar */
  private readonly openPrompts = new Set<() => void>();

  constructor(room: Room) {
    this.room = room;
    this.$ = getStateCallbacks(room) as unknown as (obj: unknown) => any;
    injectStyles();

    this.overlay = document.createElement("div");
    this.overlay.className = "kb-overlay";
    this.overlay.append(this.buildTop(), this.buildToolbar());

    this.boardEl = document.createElement("div");
    this.boardEl.className = "kb-board";
    this.overlay.appendChild(this.boardEl);
    document.body.appendChild(this.overlay);

    this.modalBg = document.createElement("div");
    this.modalBg.className = "kb-modal-bg";
    this.modalBg.onclick = (e) => {
      if (e.target === this.modalBg) this.closeModal();
    };
    document.body.appendChild(this.modalBg);

    document.addEventListener("keydown", this.onKeydown);

    // sincronizacao ao vivo
    const tasks = this.$(room.state).tasks;
    tasks.onAdd((t: unknown) => {
      this.$(t).onChange(() => this.scheduleRender());
      this.scheduleRender();
    });
    tasks.onRemove(() => this.scheduleRender());
    for (const reg of [this.$(room.state).clientColors, this.$(room.state).memberColors]) {
      reg.onAdd(() => this.scheduleRender());
      reg.onChange?.(() => this.scheduleRender());
      reg.onRemove(() => this.scheduleRender());
    }
  }

  private buildTop(): HTMLDivElement {
    const top = document.createElement("div");
    top.className = "kb-top";
    const h2 = document.createElement("h2");
    h2.textContent = "📋 Gestor de Tarefas";

    // seletor de empresa (visao da daily): Todas · IA · Marketing
    const seg = document.createElement("div");
    seg.className = "kb-seg";
    for (const o of [{ value: "", label: "Todas" }, { value: "ia", label: "IA" }, { value: "mkt", label: "Marketing" }]) {
      const b = document.createElement("button");
      b.className = "kb-seg-btn";
      b.textContent = o.label;
      b.dataset.unit = o.value;
      b.onclick = () => {
        this.filter.unit = o.value;
        this.render();
      };
      seg.appendChild(b);
    }
    this.unitSeg = seg;

    const sp = document.createElement("div");
    sp.className = "sp";
    const cli = document.createElement("button");
    cli.className = "kb-btn ghost";
    cli.textContent = "👥 Clientes";
    cli.onclick = () => this.openRegistry("client");
    const mem = document.createElement("button");
    mem.className = "kb-btn ghost";
    mem.textContent = "🧑‍🤝‍🧑 Membros";
    mem.onclick = () => this.openRegistry("member");
    this.streamBtn = document.createElement("button");
    this.streamBtn.className = "kb-btn stream";
    this.streamBtn.textContent = "📡 Stream";
    this.streamBtn.onclick = () => this.toggleStream();
    const close = document.createElement("button");
    close.className = "kb-btn close";
    close.textContent = "✕ Fechar";
    close.onclick = () => this.close(true);
    top.append(h2, seg, sp, cli, mem, this.streamBtn, close);
    return top;
  }
  private unitSeg!: HTMLDivElement;

  private buildToolbar(): HTMLDivElement {
    const bar = document.createElement("div");
    bar.className = "kb-toolbar";
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "🔍 buscar...";
    search.oninput = () => {
      this.filter.text = search.value.toLowerCase();
      this.render();
    };
    const cliSel = document.createElement("select");
    cliSel.dataset.role = "client";
    cliSel.onchange = () => {
      this.filter.client = cliSel.value;
      this.render();
    };
    const asSel = document.createElement("select");
    asSel.dataset.role = "assignee";
    asSel.onchange = () => {
      this.filter.assignee = asSel.value;
      this.render();
    };
    const late = document.createElement("label");
    const lateCb = document.createElement("input");
    lateCb.type = "checkbox";
    lateCb.onchange = () => {
      this.filter.lateOnly = lateCb.checked;
      this.render();
    };
    late.append(lateCb, document.createTextNode("só atrasados"));
    const arch = document.createElement("label");
    const archCb = document.createElement("input");
    archCb.type = "checkbox";
    archCb.onchange = () => {
      this.filter.showArchived = archCb.checked;
      this.render();
    };
    arch.append(archCb, document.createTextNode("ver arquivados"));
    bar.append(search, cliSel, asSel, late, arch);
    this.cliSel = cliSel;
    this.asSel = asSel;
    return bar;
  }
  private cliSel!: HTMLSelectElement;
  private asSel!: HTMLSelectElement;

  isOpen() {
    return this.opened;
  }
  isStreamOpened() {
    return this.openedByStream;
  }
  /** estou streamando o board agora? (uso: manter o mic ligado enquanto apresento) */
  isStreaming() {
    return this.streaming;
  }
  clearStreamDismiss() {
    this.streamDismissed = false;
  }

  open(byStream = false) {
    if (byStream && this.streamDismissed) return; // dispensado: nao reabre ate sair de perto
    if (!byStream) this.openedByStream = false;
    else if (!this.opened) this.openedByStream = true;
    this.opened = true;
    this.overlay.classList.add("open");
    this.onOpenChange?.(true);
    this.render();
  }

  close(userInitiated = false) {
    if (this.openedByStream && userInitiated) this.streamDismissed = true;
    this.opened = false;
    this.openedByStream = false;
    this.overlay.classList.remove("open");
    this.closeModal();
    this.dismissPrompts();
    if (this.streaming) this.toggleStream();
    this.onOpenChange?.(false);
  }

  /** Fecha qualquer askText aberto — evita overlay órfão (z-index alto) travando a tela quando
   *  o board fecha/é destruído no reconnect com um prompt em aberto. */
  private dismissPrompts() {
    for (const d of [...this.openPrompts]) d();
  }

  toggle() {
    if (this.opened) this.close(true);
    else this.open(false);
  }

  private onKeydown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (this.modalBg.classList.contains("open")) this.closeModal();
    else if (this.opened) this.close(true);
  };

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
    tasks.forEach((t) =>
      out.push({
        id: t.id, title: t.title, desc: t.desc, assignee: t.assignee, client: t.client,
        due: t.due, col: t.col, order: t.order, archived: t.archived, unit: t.unit,
        delivered: !!t.delivered, deliveredBy: t.deliveredBy ?? "", proof: t.proof ?? "",
        deliverNote: t.deliverNote ?? "", verified: !!t.verified,
        aiScore: typeof t.aiScore === "number" ? t.aiScore : -1, aiNote: t.aiNote ?? "",
        committedDue: typeof t.committedDue === "number" ? t.committedDue : 0, blockReason: t.blockReason ?? "",
        blockedMs: typeof t.blockedMs === "number" ? t.blockedMs : 0,
        size: t.size ?? "", clientWeight: typeof t.clientWeight === "number" ? t.clientWeight : 100,
      }),
    );
    return out;
  }
  private clientColors(): Map<string, string> {
    return (this.room.state as unknown as { clientColors: Map<string, string> }).clientColors;
  }
  private memberColors(): Map<string, string> {
    return (this.room.state as unknown as { memberColors: Map<string, string> }).memberColors;
  }
  private clientBase(name: string): string {
    return this.clientColors().get(name) || autoHex(name);
  }
  private memberBase(name: string): string {
    return this.memberColors().get(name) || autoHex(name);
  }
  private baseFor(field: "client" | "assignee", name: string): string {
    return field === "client" ? this.clientBase(name) : this.memberBase(name);
  }

  private knownValues(field: "client" | "assignee"): string[] {
    const set = new Set<string>();
    for (const t of this.allTasks()) if (t[field]) set.add(t[field]);
    const reg = field === "client" ? this.clientColors() : this.memberColors();
    reg.forEach((_v, k) => set.add(k));
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  private syncFilterSelect(sel: HTMLSelectElement, field: "client" | "assignee", current: string) {
    const vals = this.knownValues(field);
    sel.innerHTML = "";
    const all = document.createElement("option");
    all.value = "";
    all.textContent = field === "client" ? "Todos os clientes" : "Todos os responsáveis";
    sel.appendChild(all);
    for (const v of vals) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = v;
      sel.appendChild(o);
    }
    sel.value = vals.includes(current) ? current : "";
    if (sel.value !== current) this.filter[field] = sel.value;
  }

  private render() {
    this.syncFilterSelect(this.cliSel, "client", this.filter.client);
    this.syncFilterSelect(this.asSel, "assignee", this.filter.assignee);
    this.unitSeg.querySelectorAll<HTMLButtonElement>(".kb-seg-btn").forEach((b) => {
      b.classList.toggle("active", (b.dataset.unit ?? "") === this.filter.unit);
    });

    const all = this.allTasks().filter((t) => {
      if (!this.filter.showArchived && t.archived) return false;
      if (this.filter.unit && t.unit !== this.filter.unit) return false;
      if (this.filter.client && t.client !== this.filter.client) return false;
      if (this.filter.assignee && t.assignee !== this.filter.assignee) return false;
      if (this.filter.lateOnly) {
        // com F4 on, "só atrasados" usa o mesmo critério dos chips (e pausa em travado);
        // sem F4, mantém o cálculo antigo.
        const isLate = getFlags().overdue
          ? (daysToDue(t.due, t.col, t.blockedMs) ?? 0) < 0
          : daysOverdue(t.due, t.col) > 0;
        if (!isLate) return false;
      }
      if (this.filter.text) {
        const hay = `${t.title} ${t.desc} ${t.client} ${t.assignee}`.toLowerCase();
        if (!hay.includes(this.filter.text)) return false;
      }
      return true;
    });

    // preserva a rolagem de cada coluna
    const scroll = new Map<string, number>();
    this.boardEl.querySelectorAll<HTMLDivElement>(".kb-cards").forEach((el) => {
      if (el.dataset.col) scroll.set(el.dataset.col, el.scrollTop);
    });

    this.boardEl.innerHTML = "";
    for (const c of COLUMNS) {
      // ordena por DATA DE ENTREGA (mais próxima primeiro); sem prazo / data inválida vai pro fim;
      // empate desfaz pela ordem manual do arrasto. Decorate-sort: parseia a data UMA vez por card
      // (não a cada comparação) e trata NaN como Infinity (comparador NaN embaralharia a coluna).
      const cards = all
        .filter((t) => t.col === c.key)
        .map((t) => {
          const ms = t.due ? Date.parse(`${t.due}T00:00:00`) : NaN;
          return { t, k: Number.isFinite(ms) ? ms : Infinity };
        })
        .sort((a, b) => a.k - b.k || a.t.order - b.t.order)
        .map((x) => x.t);
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
      if (c.key === "feito") {
        // não conta (nem arquiva) entrega em escrow pendente — o servidor também a protege
        const doneActive = this.allTasks().filter(
          (t) => t.col === "feito" && !t.archived && !(getFlags().gate && t.delivered && !t.verified),
        ).length;
        const arch = document.createElement("button");
        arch.className = "kb-arch";
        arch.textContent = `🗄 Arquivar (${doneActive})`;
        arch.title = "Arquivar os feitos (somem do board, ficam no histórico)";
        arch.onclick = () => {
          if (doneActive > 0) this.room.send("board:archiveDone", {});
        };
        head.appendChild(arch);
      }

      const list = document.createElement("div");
      list.className = "kb-cards";
      list.dataset.col = c.key;
      for (const t of cards) list.appendChild(this.cardEl(t, c.color));

      const add = document.createElement("button");
      add.className = "kb-add";
      add.textContent = "+ Adicionar tarefa";
      add.onclick = () => this.openEditor(null, c.key);

      col.append(head, list, add);
      this.boardEl.appendChild(col);
      const sc = scroll.get(c.key);
      if (sc) list.scrollTop = sc;
    }
  }

  private cardEl(t: TaskView, colColor: string): HTMLDivElement {
    const card = document.createElement("div");
    card.className = "kb-card" + (t.archived ? " archived" : "");
    card.style.borderLeftColor = colColor;
    card.dataset.id = t.id;

    const title = document.createElement("div");
    title.className = "t";
    title.textContent = t.title || "(sem titulo)";
    card.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "meta";
    const um = UNIT_META[t.unit];
    if (um) {
      const ub = document.createElement("span");
      ub.className = "kb-chip";
      ub.style.background = um.color;
      ub.style.color = contrast(um.color);
      ub.textContent = um.label;
      meta.appendChild(ub);
    }
    if (t.due) {
      const dt = document.createElement("span");
      dt.textContent = fmtDate(t.due);
      meta.appendChild(dt);
    }
    if (getFlags().overdue) {
      // F4: chip escalonado com TOM DE SOCORRO (usa o due atual; pausa em travado/feito)
      const chip = overdueChip(t);
      if (chip) meta.appendChild(chip);
      // motivo do "Travado" (relógio pausado) — neutro, sobre o trabalho
      if (t.col === "travado" && t.blockReason) {
        const bk = document.createElement("span");
        bk.className = "kb-chip od-block";
        bk.textContent = `🚧 ${t.blockReason}`;
        meta.appendChild(bk);
      }
    } else {
      // comportamento antigo (flag off): "Xd atraso" vermelho
      const late = daysOverdue(t.due, t.col);
      if (late > 0) {
        const lt = document.createElement("span");
        lt.className = "kb-late";
        lt.textContent = `${late}d atraso`;
        meta.appendChild(lt);
      }
    }
    if (t.client) {
      const ch = document.createElement("span");
      ch.className = "kb-chip";
      const base = this.clientBase(t.client);
      ch.style.background = base;
      ch.style.color = contrast(base);
      ch.textContent = t.client;
      meta.appendChild(ch);
    }
    if (t.assignee) {
      const as = document.createElement("span");
      as.className = "kb-chip";
      const base = this.memberBase(t.assignee);
      as.style.background = base;
      as.style.color = contrast(base);
      as.textContent = `👤 ${t.assignee}`;
      meta.appendChild(as);
    }
    if (meta.childElementCount) card.appendChild(meta);

    // F2 — gate de entrega: só em "Feito" e com o flag ligado.
    if (getFlags().gate && t.col === "feito" && !t.archived) {
      card.appendChild(this.buildGateSection(t));
    }

    card.addEventListener("pointerdown", (e) => this.onCardPointerDown(e, card, t));
    return card;
  }

  /** Bloco de entrega no rodapé do card de "Feito" (Entregar -> aguardando -> Verificado). */
  private buildGateSection(t: TaskView): HTMLDivElement {
    const gate = document.createElement("div");
    gate.className = "kb-gate";
    // os controles de entrega NÃO podem iniciar o drag nem o clique de editar o card
    gate.addEventListener("pointerdown", (e) => e.stopPropagation());

    const proofLink = () => {
      if (!/^https?:\/\//i.test(t.proof)) return null;
      const a = document.createElement("a");
      a.className = "proof";
      a.href = t.proof;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "🔗 prova";
      return a;
    };
    const gbtn = (label: string, cls: string, onClick: () => void) => {
      const b = document.createElement("button");
      b.className = `kb-gbtn ${cls}`;
      b.textContent = label;
      b.onclick = onClick;
      return b;
    };

    if (t.verified) {
      const seal = document.createElement("span");
      seal.className = "kb-seal ok";
      // mostra a nota da IA quando ela aprovou (glória pública); senão só "Verificado"
      seal.textContent = t.aiScore >= 0 ? `✅ Verificado · IA ${t.aiScore}/10` : "✅ Verificado";
      if (t.aiNote) seal.title = t.aiNote; // justificativa da IA no hover
      gate.appendChild(seal);
      const l = proofLink();
      if (l) gate.appendChild(l);
    } else if (t.delivered) {
      const seal = document.createElement("span");
      seal.className = "kb-seal wait";
      seal.textContent = "⏳ aguardando verificação";
      gate.appendChild(seal);
      const l = proofLink();
      if (l) gate.appendChild(l);
      gate.appendChild(gbtn("✓ Verificar", "verify", () => this.room.send("task:verify", { id: t.id })));
      gate.appendChild(gbtn("↩ Devolver", "undo", () => this.room.send("task:undeliver", { id: t.id })));
      if (t.deliveredBy) {
        const by = document.createElement("span");
        by.className = "by";
        by.textContent = `entregue por ${t.deliveredBy}`;
        gate.appendChild(by);
      }
    } else {
      gate.appendChild(
        gbtn("📤 Entregar ao cliente", "deliver", () => this.openDeliverModal(t)),
      );
    }
    return gate;
  }

  // ---------- drag por pointer (mouse + touch) ----------

  private drag?: {
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
    ghost?: HTMLDivElement;
    card: HTMLDivElement;
    task: TaskView;
  };

  private onCardPointerDown(e: PointerEvent, card: HTMLDivElement, t: TaskView) {
    if (e.button && e.button !== 0) return;
    if (this.drag) return; // ja arrastando outro card (ex: multitoque) — ignora o 2o
    this.drag = { id: t.id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false, card, task: t };
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
  }

  private onPointerMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < 6) return; // ainda e clique
    if (!d.moved) {
      d.moved = true;
      this.dragging = true;
      const g = d.card.cloneNode(true) as HTMLDivElement;
      g.className = "kb-card kb-ghost";
      document.body.appendChild(g);
      d.ghost = g;
      d.card.style.visibility = "hidden";
    }
    if (d.ghost) {
      d.ghost.style.left = `${e.clientX - 125}px`;
      d.ghost.style.top = `${e.clientY - 18}px`;
    }
    // realca a coluna alvo
    this.boardEl.querySelectorAll(".kb-cards").forEach((el) => el.classList.remove("dragover"));
    const list = this.listUnder(e.clientX, e.clientY);
    if (list) list.classList.add("dragover");
  };

  private onPointerUp = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    this.drag = undefined;
    if (d.ghost) d.ghost.remove();
    d.card.style.visibility = "";
    this.boardEl.querySelectorAll(".kb-cards").forEach((el) => el.classList.remove("dragover"));

    if (!d.moved) {
      this.openEditor(d.task, d.task.col); // foi um clique
      return;
    }
    this.dragging = false;
    const list = this.listUnder(e.clientX, e.clientY);
    if (list?.dataset.col) this.dropInto(d.id, list.dataset.col as ColKey, list, e.clientY);
    this.render();
  };

  private listUnder(x: number, y: number): HTMLDivElement | null {
    let el = document.elementFromPoint(x, y) as HTMLElement | null;
    while (el && el !== this.boardEl) {
      if (el.classList?.contains("kb-cards")) return el as HTMLDivElement;
      el = el.parentElement;
    }
    // fallback: coluna pela faixa horizontal
    const cols = [...this.boardEl.querySelectorAll<HTMLDivElement>(".kb-cards")];
    for (const c of cols) {
      const r = c.parentElement!.getBoundingClientRect();
      if (x >= r.left && x <= r.right) return c;
    }
    return null;
  }

  private dropInto(id: string, col: ColKey, list: HTMLDivElement, clientY: number) {
    const orderOf = (el: HTMLDivElement) =>
      this.allTasks().find((t) => t.id === el.dataset.id)?.order ?? 0;
    const siblings = [...list.querySelectorAll<HTMLDivElement>(".kb-card")].filter(
      (el) => el.dataset.id !== id,
    );
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
    const oldCol = this.allTasks().find((t) => t.id === id)?.col ?? "";
    this.room.send("task:move", { id, col, order });
    this.maybePromptBlock(id, col, oldCol);
  }

  /**
   * Pergunta de texto NÃO-BLOQUEANTE (substitui window.prompt). O prompt nativo congela a thread
   * e pausa os timers — o heartbeat de posição de quem abriu para, e os outros cortam a voz/share
   * dele pela trava de frescor. Este modal DOM mantém tudo rodando. Resolve com o texto ou null.
   */
  private askText(message: string, initial = ""): Promise<string | null> {
    return new Promise((resolve) => {
      const bg = document.createElement("div");
      bg.className = "kb-modal-bg open"; // z-index 10052, acima do overlay do board
      const m = document.createElement("div");
      m.className = "kb-modal";
      m.onclick = (e) => e.stopPropagation();
      const msg = document.createElement("div");
      msg.style.cssText = "white-space:pre-line;margin-bottom:12px;font:14px system-ui;color:#111;";
      msg.textContent = message;
      const input = document.createElement("input");
      input.type = "text";
      input.value = initial;
      input.style.cssText =
        "width:100%;box-sizing:border-box;font:14px system-ui;padding:8px 9px;border:1.5px solid #d1d5db;border-radius:7px;outline:none;";
      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:14px;";
      const cancel = document.createElement("button");
      cancel.className = "kb-btn";
      cancel.textContent = "Cancelar";
      cancel.style.background = "#6b7280";
      const ok = document.createElement("button");
      ok.className = "kb-btn";
      ok.textContent = "OK";
      ok.style.background = "#2563eb";
      let settled = false;
      const done = (val: string | null) => {
        if (settled) return;
        settled = true;
        this.openPrompts.delete(dismiss);
        bg.remove();
        resolve(val);
      };
      const dismiss = () => done(null);
      this.openPrompts.add(dismiss); // registrado pra ser fechado se o board sumir no meio
      cancel.onclick = () => done(null);
      ok.onclick = () => done(input.value);
      input.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          done(input.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          done(null);
        }
      };
      bg.onclick = () => done(null); // clicar fora cancela
      actions.append(cancel, ok);
      m.append(msg, input, actions);
      bg.appendChild(m);
      document.body.appendChild(bg);
      setTimeout(() => input.focus(), 0);
    });
  }

  /** F4 — ao ENTRAR em "Travado", pede um motivo curto (pausa o relógio de atraso). */
  private async maybePromptBlock(id: string, newCol: string, oldCol: string) {
    if (!getFlags().overdue) return;
    if (newCol !== "travado" || oldCol === "travado") return;
    const reason = await this.askText(
      "Travado — por quê? (motivo curto; ex.: aguardando cliente)\nIsso pausa o relógio de atraso.",
      "",
    );
    if (reason && reason.trim()) this.room.send("task:block", { id, reason: reason.trim() });
  }

  // ---------- modal criar/editar ----------

  /** Select gerenciado p/ cliente/membro: lista os registrados + "adicionar novo". */
  private buildManagedSelect(field: "client" | "assignee", current: string): HTMLSelectElement {
    const sel = document.createElement("select");
    const isClient = field === "client";
    const addMsg = isClient ? "client:setColor" : "member:setColor";
    const fill = (val: string) => {
      sel.innerHTML = "";
      sel.appendChild(new Option(isClient ? "— sem cliente —" : "— sem responsável —", ""));
      const names = this.knownValues(field);
      if (val && !names.includes(val)) names.push(val);
      names.sort((a, b) => a.localeCompare(b));
      for (const n of names) {
        const o = new Option(n, n);
        o.style.color = this.baseFor(field, n);
        sel.appendChild(o);
      }
      sel.appendChild(new Option(isClient ? "➕ Adicionar cliente…" : "➕ Adicionar membro…", "__add__"));
      sel.value = val;
      sel.dataset.prev = val;
    };
    fill(current);
    sel.onchange = async () => {
      if (sel.value === "__add__") {
        const label = isClient ? "cliente" : "membro";
        const name = (await this.askText(`Nome do novo ${label}:`, ""))?.trim();
        if (name) {
          // registra so se for novo — nao sobrescreve a cor escolhida de um existente
          if (!this.knownValues(field).includes(name)) {
            this.room.send(addMsg, { name, color: autoHex(name) });
          }
          fill(name);
        } else {
          fill(sel.dataset.prev ?? "");
        }
      } else {
        sel.dataset.prev = sel.value;
      }
    };
    return sel;
  }

  private openEditor(task: TaskView | null, col: string) {
    const editing = !!task;
    this.modalBg.innerHTML = "";
    const m = document.createElement("div");
    m.className = "kb-modal";
    m.onclick = (e) => e.stopPropagation();
    const h3 = document.createElement("h3");
    h3.textContent = editing ? "Editar tarefa" : "Nova tarefa";
    m.appendChild(h3);

    const mk = (label: string, el: HTMLElement) => {
      const f = document.createElement("div");
      f.className = "kb-field";
      const l = document.createElement("label");
      l.textContent = label;
      f.append(l, el);
      m.appendChild(f);
    };
    const title = document.createElement("input");
    title.value = task?.title ?? "";
    title.placeholder = "Nome da tarefa";
    mk("Nome da tarefa", title);
    const desc = document.createElement("textarea");
    desc.value = task?.desc ?? "";
    mk("Descrição", desc);
    const assignee = this.buildManagedSelect("assignee", task?.assignee ?? "");
    mk("Responsável", assignee);
    const client = this.buildManagedSelect("client", task?.client ?? "");
    mk("Cliente", client);
    const unitSel = document.createElement("select");
    for (const o of UNIT_OPTS) unitSel.appendChild(new Option(o.label, o.value));
    unitSel.value = task?.unit ?? "";
    mk("Empresa (IA / Marketing)", unitSel);
    // F6 — tamanho + peso do cliente (pesam os PE). Só com o flag de progressão on.
    let sizeSel: HTMLSelectElement | undefined;
    let weightSel: HTMLSelectElement | undefined;
    if (getFlags().progression) {
      sizeSel = document.createElement("select");
      for (const o of SIZE_OPTS) sizeSel.appendChild(new Option(o.label, o.value));
      sizeSel.value = task?.size ?? "";
      mk("Tamanho (esforço)", sizeSel);
      weightSel = document.createElement("select");
      for (const o of WEIGHT_OPTS) weightSel.appendChild(new Option(o.label, String(o.value)));
      weightSel.value = String(task?.clientWeight ?? 100);
      mk("Peso do cliente", weightSel);
    }
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

    const actions = document.createElement("div");
    actions.className = "kb-modal-actions";
    if (editing) {
      let armed = false;
      const del = document.createElement("button");
      del.className = "kb-btn del";
      del.textContent = "🗑 Deletar";
      del.onclick = () => {
        if (!armed) {
          armed = true;
          del.textContent = "Confirmar exclusão?";
          del.classList.add("confirm");
          return;
        }
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
      const col = colSel.value;
      const payload: Record<string, unknown> = {
        title: title.value.trim(),
        desc: desc.value,
        assignee: assignee.value.trim(),
        client: client.value.trim(),
        unit: unitSel.value,
        due: due.value,
        col,
      };
      if (sizeSel) payload.size = sizeSel.value;
      if (weightSel) payload.clientWeight = Number(weightSel.value);
      if (editing && task) {
        this.room.send("task:update", { id: task.id, ...payload });
        this.maybePromptBlock(task.id, col, task.col); // F4: motivo se foi pra Travado
      } else {
        this.room.send("task:create", payload);
      }
      this.closeModal();
    };
    actions.append(cancel, save);
    m.appendChild(actions);
    this.modalBg.appendChild(m);
    this.modalBg.classList.add("open");
    title.focus();
  }

  // ---------- F2: modal de entrega (link de prova + nota) ----------

  private openDeliverModal(t: TaskView) {
    this.modalBg.innerHTML = "";
    const m = document.createElement("div");
    m.className = "kb-modal";
    m.onclick = (e) => e.stopPropagation();
    const h3 = document.createElement("h3");
    h3.textContent = "📤 Entregar ao cliente";
    m.appendChild(h3);

    // enquadramento: proteção do colega, não auditoria (decisão do design)
    const hint = document.createElement("div");
    hint.className = "kb-deliver-hint";
    hint.textContent =
      "Fica registrado que você entregou — se o cliente reclamar, você está coberto. " +
      "Cole o link da prova: post publicado, arquivo no Drive, ID de envio.";
    m.appendChild(hint);

    const mk = (label: string, el: HTMLElement) => {
      const f = document.createElement("div");
      f.className = "kb-field";
      const l = document.createElement("label");
      l.textContent = label;
      f.append(l, el);
      m.appendChild(f);
    };
    const proof = document.createElement("input");
    proof.type = "url";
    proof.placeholder = "https://…";
    proof.value = t.proof || "";
    mk("Link da prova de entrega", proof);
    const note = document.createElement("textarea");
    note.placeholder = "Nota curta (opcional) — ex: enviei no grupo do cliente às 14h";
    note.value = t.deliverNote || "";
    mk("Nota", note);
    const err = document.createElement("div");
    err.className = "kb-err";
    m.appendChild(err);

    const send = () => {
      const link = proof.value.trim();
      if (!/^https?:\/\/\S+/i.test(link)) {
        err.textContent = "Cole um link válido (começa com http:// ou https://).";
        proof.focus();
        return;
      }
      this.room.send("task:deliver", { id: t.id, proof: link, note: note.value.trim() });
      this.closeModal();
    };
    proof.addEventListener("keydown", (e) => {
      if (e.key === "Enter") send();
    });

    const actions = document.createElement("div");
    actions.className = "kb-modal-actions";
    const cancel = document.createElement("button");
    cancel.className = "kb-btn close";
    cancel.textContent = "Cancelar";
    cancel.onclick = () => this.closeModal();
    const ok = document.createElement("button");
    ok.className = "kb-btn stream";
    ok.textContent = "📤 Entregar";
    ok.onclick = send;
    actions.append(cancel, ok);
    m.appendChild(actions);
    this.modalBg.appendChild(m);
    this.modalBg.classList.add("open");
    proof.focus();
  }

  // ---------- gerenciar listas (clientes / membros): cor + renomear + adicionar ----------

  private openRegistry(kind: "client" | "member") {
    const isClient = kind === "client";
    const field = isClient ? "client" : "assignee";
    const setColorMsg = isClient ? "client:setColor" : "member:setColor";
    const renameMsg = isClient ? "client:rename" : "member:rename";
    const noun = isClient ? "cliente" : "membro";

    this.modalBg.innerHTML = "";
    const m = document.createElement("div");
    m.className = "kb-modal";
    m.onclick = (e) => e.stopPropagation();
    const h3 = document.createElement("h3");
    h3.textContent = isClient ? "👥 Clientes — cor e nome" : "🧑‍🤝‍🧑 Membros do time — cor e nome";
    m.appendChild(h3);
    const hint = document.createElement("div");
    hint.style.cssText = "font-size:12px;color:#6b7280;margin-bottom:8px;";
    hint.textContent = `A cor vale pros chips em todos os cards. Renomear atualiza todos os cards do ${noun}.`;
    m.appendChild(hint);

    const add = document.createElement("button");
    add.className = "kb-btn ghost";
    add.style.cssText = "margin-bottom:8px;background:#eef;color:#3730a3;";
    add.textContent = `➕ Adicionar ${noun}`;
    add.onclick = async () => {
      const name = (await this.askText(`Nome do novo ${noun}:`, ""))?.trim();
      if (name) {
        // so registra se for novo — nao sobrescreve a cor de um ja existente
        if (!this.knownValues(field).includes(name)) {
          this.room.send(setColorMsg, { name, color: autoHex(name) });
        }
        this.openRegistry(kind);
      }
    };
    m.appendChild(add);

    const list = document.createElement("div");
    for (const name of this.knownValues(field)) {
      const row = document.createElement("div");
      row.className = "kb-cli-row";
      const color = document.createElement("input");
      color.type = "color";
      color.value = this.baseFor(field, name);
      color.oninput = () => this.room.send(setColorMsg, { name, color: color.value });
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = name;
      const ren = document.createElement("button");
      ren.className = "ren";
      ren.textContent = "renomear";
      ren.onclick = async () => {
        const to = await this.askText(`Renomear ${noun} "${name}" para:`, name);
        if (to && to.trim() && to.trim() !== name) {
          this.room.send(renameMsg, { from: name, to: to.trim() });
          this.openRegistry(kind);
        }
      };
      row.append(color, nm, ren);
      list.appendChild(row);
    }
    if (!list.childElementCount) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:#6b7280;font-size:13px;padding:8px 0;";
      empty.textContent = `Nenhum ${noun} ainda — adicione acima ou use um num card.`;
      list.appendChild(empty);
    }
    m.appendChild(list);
    const actions = document.createElement("div");
    actions.className = "kb-modal-actions";
    const close = document.createElement("button");
    close.className = "kb-btn close";
    close.textContent = "Fechar";
    close.onclick = () => this.closeModal();
    actions.appendChild(close);
    m.appendChild(actions);
    this.modalBg.appendChild(m);
    this.modalBg.classList.add("open");
  }

  private closeModal() {
    this.modalBg.classList.remove("open");
    this.modalBg.innerHTML = "";
  }

  destroy() {
    document.removeEventListener("keydown", this.onKeydown);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    this.dismissPrompts(); // não deixa askText pendurado ao ser destruído no reconnect
    this.overlay.remove();
    this.modalBg.remove();
  }
}
