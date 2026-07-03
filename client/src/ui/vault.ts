import { type Room } from "../net/room";

/**
 * Central de Senhas (cofre) — overlay HTML compartilhado, movido por mensagens Colyseus.
 *
 * IMPORTANTE (segurança no cliente): as senhas NUNCA vêm na listagem. A lista traz apenas
 * EntryPub (sem password, com hasPassword). A senha de UM item só chega via onSecret(), em
 * resposta a um "vault:reveal" que o próprio usuário disparou. Nada de senha é renderizado antes
 * disso, e toda senha revelada guardada em memória é limpa ao fechar/destruir o painel.
 */

/** Entrada pública do cofre (espelha EntryPub do servidor — SEM o campo password). */
export type EntryPub = {
  id: string;
  group: string;
  client: string;
  service: string;
  username: string;
  url: string;
  notes: string;
  hasPassword: boolean;
  updatedAt: number;
  updatedBy: string;
};

/** Payload de gravação (vault:save). Sem id = criar; com id = atualizar. */
type VaultSavePayload = {
  id?: string;
  group: string;
  client: string;
  service: string;
  username: string;
  password: string;
  url: string;
  notes: string;
};

// abas de grupo — filtram a lista por VaultEntry.group (string livre no servidor).
type GroupKey = "" | "ativo" | "desativado" | "headquarters";
const GROUP_TABS: { key: GroupKey; label: string }[] = [
  { key: "", label: "Todos" },
  { key: "ativo", label: "Ativo" },
  { key: "desativado", label: "Desativado" },
  { key: "headquarters", label: "Headquarters" },
];
// opções de grupo no editor (o servidor aceita string livre; oferecemos os grupos típicos)
const GROUP_OPTS: { value: string; label: string }[] = [
  { value: "ativo", label: "Ativo" },
  { value: "desativado", label: "Desativado" },
  { value: "headquarters", label: "Headquarters" },
];

// limites defensivos espelhando a validação do servidor (só pra não mandar lixo grande)
const LIMITS = {
  client: 120,
  service: 120,
  username: 200,
  password: 400,
  url: 400,
  notes: 2000,
  group: 40,
} as const;

// quanto tempo uma senha revelada fica na tela/memória antes de ser apagada
const REVEAL_TTL_MS = 30_000;

function fmtWhen(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

const STYLE_ID = "vt-styles";
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
.vt-overlay{position:fixed;inset:0;z-index:10000;display:none;flex-direction:column;
  background:#0b0a12ee;font-family:system-ui,Segoe UI,monospace;color:#1f2937;}
.vt-overlay.open{display:flex;}
.vt-top,.vt-toolbar{display:flex;align-items:center;gap:10px;padding:9px 16px;background:#15131d;
  color:#f0e6c8;flex:0 0 auto;flex-wrap:wrap;}
.vt-top{border-bottom:1px solid #2a2636;}
.vt-toolbar{background:#1b1925;border-bottom:1px solid #2a2636;font-size:12px;}
.vt-top h2{font-size:16px;margin:0;font-weight:600;}
.vt-top .sp{flex:1;}
.vt-seg{display:inline-flex;border:1px solid #3a3550;border-radius:8px;overflow:hidden;}
.vt-seg-btn{font:12px system-ui;cursor:pointer;border:none;background:#0f0e16;color:#cfc7b0;padding:7px 13px;}
.vt-seg-btn+.vt-seg-btn{border-left:1px solid #3a3550;}
.vt-seg-btn.active{background:#b9892a;color:#fff;font-weight:600;}
.vt-btn{font:13px system-ui;cursor:pointer;border:none;border-radius:8px;padding:7px 12px;color:#fff;}
.vt-btn.add{background:#2a7a3a;}
.vt-btn.import{background:#2f6ab9;}
.vt-btn.close{background:#3a3340;}
.vt-btn.ghost{background:#2f2b3a;color:#e8e0c8;}
.vt-toolbar input[type=search]{font:12px system-ui;padding:6px 8px;border-radius:7px;
  border:1px solid #3a3550;background:#0f0e16;color:#e8e0c8;outline:none;min-width:220px;flex:1;}
.vt-body{flex:1;overflow-y:auto;padding:14px;background:#11101a;}
.vt-group-block{background:#f4f5f7;border-radius:10px;padding:10px 12px;margin-bottom:12px;}
.vt-group-head{display:flex;align-items:center;gap:8px;margin-bottom:8px;}
.vt-group-title{font-size:14px;font-weight:700;color:#1f2937;}
.vt-group-count{font-size:12px;color:#6b7280;}
.vt-entry{background:#fff;border:1.5px solid #e5e7eb;border-left-width:4px;border-left-color:#6366f1;
  border-radius:8px;padding:10px 11px;margin-top:8px;}
.vt-entry .svc{font-size:13px;font-weight:600;line-height:1.25;margin-bottom:6px;word-break:break-word;
  display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.vt-tag{font-size:11px;font-weight:600;border-radius:5px;padding:2px 7px;background:#eef2ff;color:#3730a3;}
.vt-row{display:flex;align-items:center;gap:8px;margin-top:5px;font-size:12px;color:#374151;flex-wrap:wrap;}
.vt-row .lbl{font-size:11px;color:#9ca3af;min-width:64px;}
.vt-row .val{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;}
.vt-row a.link{color:#2563eb;text-decoration:underline;word-break:break-all;font-size:12px;}
.vt-row .notes{white-space:pre-wrap;color:#4b5563;font-size:12px;}
.vt-iconbtn{font:11px system-ui;cursor:pointer;border:none;border-radius:6px;padding:3px 8px;
  background:#eef;color:#3730a3;}
.vt-iconbtn:hover{background:#dfe1ff;}
.vt-secret{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f3f4f6;border-radius:6px;
  padding:3px 8px;color:#111827;letter-spacing:1px;}
.vt-secret.hidden{color:#9ca3af;letter-spacing:2px;}
.vt-entry-actions{display:flex;gap:6px;margin-top:9px;padding-top:8px;border-top:1px dashed #e5e7eb;}
.vt-ebtn{font:11px system-ui;cursor:pointer;border:none;border-radius:6px;padding:5px 10px;font-weight:600;}
.vt-ebtn.edit{background:#2563eb;color:#fff;}
.vt-ebtn.del{background:#fee2e2;color:#b91c1c;}
.vt-ebtn.del.armed{background:#b91c1c;color:#fff;}
.vt-empty{color:#9aa2b1;font-size:13px;text-align:center;padding:40px 12px;}
.vt-modal-bg{position:fixed;inset:0;z-index:10052;display:none;align-items:center;justify-content:center;background:#000a;}
.vt-modal-bg.open{display:flex;}
.vt-modal{background:#fff;border-radius:12px;padding:18px;width:min(460px,92vw);max-height:90vh;
  overflow:auto;box-shadow:0 10px 40px #000a;}
.vt-modal h3{margin:0 0 12px;font-size:16px;}
.vt-field{margin-bottom:11px;}
.vt-field label{display:block;font-size:12px;color:#6b7280;margin-bottom:4px;font-weight:600;}
.vt-field input,.vt-field textarea,.vt-field select{width:100%;box-sizing:border-box;font:14px system-ui;
  padding:8px 9px;border:1.5px solid #d1d5db;border-radius:7px;outline:none;}
.vt-field textarea{min-height:64px;resize:vertical;}
.vt-field textarea.imp{min-height:180px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;}
.vt-modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;}
.vt-err{color:#b91c1c;font-size:12px;margin-top:4px;min-height:14px;}
.vt-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:10060;
  background:#111827;color:#f9fafb;font:13px system-ui;padding:10px 16px;border-radius:9px;
  box-shadow:0 8px 24px #0007;opacity:0;transition:opacity .2s;pointer-events:none;}
.vt-toast.show{opacity:1;}
`;
  document.head.appendChild(s);
}

type Filter = { text: string; group: GroupKey };

/** senha revelada em memória, com o timer que a apaga. */
type RevealState = { password: string; timer: ReturnType<typeof setTimeout> };

export class VaultPanel {
  private room: Room;
  private overlay: HTMLDivElement;
  private bodyEl: HTMLDivElement;
  private modalBg: HTMLDivElement;
  private searchEl!: HTMLInputElement;
  private groupSeg!: HTMLDivElement;
  private toastEl: HTMLDivElement;
  private toastTimer?: ReturnType<typeof setTimeout>;

  private opened = false;
  private entries: EntryPub[] = [];
  private filter: Filter = { text: "", group: "" };

  /** senhas reveladas (só as que o usuário pediu), apagadas por TTL ou ao fechar. */
  private readonly revealed = new Map<string, RevealState>();
  /** preserva o scroll no rerender. */
  private savedScroll = 0;

  /** avisa a cena quando o painel abre/fecha, pra ela desligar/religar o input do Phaser
   *  (senão o clique no cofre vaza pro canvas embaixo). */
  onOpenChange?: (open: boolean) => void;
  /** canceladores dos askText abertos — pra não deixar overlay órfão se o painel fechar/reconectar. */
  private readonly openPrompts = new Set<() => void>();

  constructor(room: Room) {
    this.room = room;
    injectStyles();

    this.overlay = document.createElement("div");
    this.overlay.className = "vt-overlay";
    this.overlay.append(this.buildTop(), this.buildToolbar());

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "vt-body";
    this.overlay.appendChild(this.bodyEl);
    document.body.appendChild(this.overlay);

    this.modalBg = document.createElement("div");
    this.modalBg.className = "vt-modal-bg";
    this.modalBg.onclick = (e) => {
      if (e.target === this.modalBg) this.closeModal();
    };
    document.body.appendChild(this.modalBg);

    this.toastEl = document.createElement("div");
    this.toastEl.className = "vt-toast";
    document.body.appendChild(this.toastEl);

    document.addEventListener("keydown", this.onKeydown);
  }

  private buildTop(): HTMLDivElement {
    const top = document.createElement("div");
    top.className = "vt-top";
    const h2 = document.createElement("h2");
    h2.textContent = "🔐 Central de Senhas";

    const sp = document.createElement("div");
    sp.className = "sp";

    const add = document.createElement("button");
    add.className = "vt-btn add";
    add.textContent = "➕ Adicionar";
    add.onclick = () => this.openEditor(null);

    const imp = document.createElement("button");
    imp.className = "vt-btn import";
    imp.textContent = "📥 Importar de .md";
    imp.onclick = () => this.openImport();

    const close = document.createElement("button");
    close.className = "vt-btn close";
    close.textContent = "✕ Fechar";
    close.onclick = () => this.close(true);

    top.append(h2, sp, add, imp, close);
    return top;
  }

  private buildToolbar(): HTMLDivElement {
    const bar = document.createElement("div");
    bar.className = "vt-toolbar";

    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "🔍 buscar por cliente, serviço, usuário ou url...";
    search.oninput = () => {
      this.filter.text = search.value.toLowerCase();
      this.render();
    };
    this.searchEl = search;

    const seg = document.createElement("div");
    seg.className = "vt-seg";
    for (const tab of GROUP_TABS) {
      const b = document.createElement("button");
      b.className = "vt-seg-btn";
      b.textContent = tab.label;
      b.dataset.group = tab.key;
      b.onclick = () => {
        this.filter.group = tab.key;
        this.render();
      };
      seg.appendChild(b);
    }
    this.groupSeg = seg;

    bar.append(search, seg);
    return bar;
  }

  // ---------- ciclo de vida ----------

  isOpen(): boolean {
    return this.opened;
  }

  open() {
    this.opened = true;
    this.overlay.classList.add("open");
    this.onOpenChange?.(true);
    // pede a lista fresca ao abrir (senhas nunca vêm aqui — só EntryPub)
    this.room.send("vault:list", {});
    this.render();
  }

  close(_userInitiated = false) {
    this.opened = false;
    this.overlay.classList.remove("open");
    this.closeModal();
    this.dismissPrompts();
    this.clearRevealed(); // segurança: nenhuma senha revelada sobrevive ao fechamento
    this.onOpenChange?.(false);
  }

  toggle() {
    if (this.opened) this.close(true);
    else this.open();
  }

  /** Fecha qualquer askText aberto — evita overlay órfão (z-index alto) travando a tela quando
   *  o painel fecha/é destruído no reconnect com um prompt em aberto. */
  private dismissPrompts() {
    for (const d of [...this.openPrompts]) d();
  }

  private onKeydown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (this.modalBg.classList.contains("open")) this.closeModal();
    else if (this.opened) this.close(true);
  };

  // ---------- respostas do servidor (a cena repassa) ----------

  /** Recebe a lista pública (sem senhas). Reseta qualquer senha revelada que já não exista mais. */
  onList(entries: EntryPub[]) {
    this.entries = Array.isArray(entries) ? entries : [];
    // limpa reveals de itens que sumiram/mudaram
    const ids = new Set(this.entries.map((e) => e.id));
    for (const id of [...this.revealed.keys()]) {
      if (!ids.has(id)) this.clearReveal(id);
    }
    if (this.opened) this.render();
  }

  /** Senha de UM item chegou (só desse item, só pra quem pediu). Mostra e agenda o apagamento. */
  onSecret(id: string, password: string) {
    // substitui reveal anterior do mesmo id (reinicia o TTL)
    const prev = this.revealed.get(id);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => this.clearReveal(id, true), REVEAL_TTL_MS);
    this.revealed.set(id, { password, timer });
    if (this.opened) this.render();
  }

  /** Importação concluída — toast com a contagem. */
  onImported(count: number) {
    this.toast(`📥 ${count} ${count === 1 ? "senha importada" : "senhas importadas"}`);
  }

  /** Sessão não autenticada — o servidor recusou. */
  onDenied() {
    this.toast("🔒 Sessão não autenticada — faça login pra usar o cofre.");
  }

  // ---------- senhas reveladas em memória ----------

  private clearReveal(id: string, rerender = false) {
    const st = this.revealed.get(id);
    if (!st) return;
    clearTimeout(st.timer);
    this.revealed.delete(id);
    if (rerender && this.opened) this.render();
  }

  private clearRevealed() {
    for (const st of this.revealed.values()) clearTimeout(st.timer);
    this.revealed.clear();
  }

  // ---------- clipboard + toast ----------

  private async copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.toast(`📋 ${label} copiado`);
    } catch {
      // fallback pra contextos sem clipboard API
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:-1000px;left:-1000px;opacity:0;";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        this.toast(`📋 ${label} copiado`);
      } catch {
        this.toast("Não consegui copiar automaticamente.");
      }
      ta.remove();
    }
  }

  private toast(msg: string) {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastEl.textContent = msg;
    this.toastEl.classList.add("show");
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove("show"), 2600);
  }

  // ---------- render ----------

  private filtered(): EntryPub[] {
    return this.entries.filter((e) => {
      if (this.filter.group && e.group !== this.filter.group) return false;
      if (this.filter.text) {
        const hay = `${e.client} ${e.service} ${e.username} ${e.url}`.toLowerCase();
        if (!hay.includes(this.filter.text)) return false;
      }
      return true;
    });
  }

  private render() {
    // abas ativas
    this.groupSeg.querySelectorAll<HTMLButtonElement>(".vt-seg-btn").forEach((b) => {
      b.classList.toggle("active", (b.dataset.group ?? "") === this.filter.group);
    });

    // preserva o scroll
    this.savedScroll = this.bodyEl.scrollTop;
    this.bodyEl.innerHTML = "";

    const list = this.filtered();
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "vt-empty";
      empty.textContent = this.entries.length
        ? "Nenhuma senha bate com o filtro."
        : "Cofre vazio — adicione uma senha ou importe de um .md.";
      this.bodyEl.appendChild(empty);
      return;
    }

    // agrupa por cliente (um bloco por cliente, entradas dentro), ordenado
    const byClient = new Map<string, EntryPub[]>();
    for (const e of list) {
      const key = e.client || "(sem cliente)";
      const arr = byClient.get(key);
      if (arr) arr.push(e);
      else byClient.set(key, [e]);
    }
    const clients = [...byClient.keys()].sort((a, b) => a.localeCompare(b));

    for (const client of clients) {
      const items = byClient.get(client)!.slice().sort((a, b) =>
        (a.service || "").localeCompare(b.service || ""),
      );
      const block = document.createElement("div");
      block.className = "vt-group-block";

      const head = document.createElement("div");
      head.className = "vt-group-head";
      const title = document.createElement("span");
      title.className = "vt-group-title";
      title.textContent = client;
      const count = document.createElement("span");
      count.className = "vt-group-count";
      count.textContent = String(items.length);
      head.append(title, count);
      block.appendChild(head);

      for (const e of items) block.appendChild(this.entryEl(e));
      this.bodyEl.appendChild(block);
    }

    this.bodyEl.scrollTop = this.savedScroll;
  }

  private entryEl(e: EntryPub): HTMLDivElement {
    const card = document.createElement("div");
    card.className = "vt-entry";
    card.dataset.id = e.id;

    // serviço + grupo (tag)
    const svc = document.createElement("div");
    svc.className = "svc";
    const svcTxt = document.createElement("span");
    svcTxt.textContent = e.service || "(sem serviço)";
    svc.appendChild(svcTxt);
    if (e.group) {
      const tag = document.createElement("span");
      tag.className = "vt-tag";
      tag.textContent = e.group;
      svc.appendChild(tag);
    }
    card.appendChild(svc);

    // usuário + copiar
    if (e.username) {
      const row = document.createElement("div");
      row.className = "vt-row";
      const lbl = document.createElement("span");
      lbl.className = "lbl";
      lbl.textContent = "usuário";
      const val = document.createElement("span");
      val.className = "val";
      val.textContent = e.username;
      const cp = document.createElement("button");
      cp.className = "vt-iconbtn";
      cp.textContent = "📋";
      cp.title = "copiar usuário";
      cp.onclick = () => this.copy(e.username, "Usuário");
      row.append(lbl, val, cp);
      card.appendChild(row);
    }

    // senha — OCULTA por padrão; 👁 dispara vault:reveal e só mostra quando onSecret chegar
    if (e.hasPassword) {
      card.appendChild(this.secretRow(e));
    }

    // url como link
    if (e.url) {
      const row = document.createElement("div");
      row.className = "vt-row";
      const lbl = document.createElement("span");
      lbl.className = "lbl";
      lbl.textContent = "url";
      const a = document.createElement("a");
      a.className = "link";
      a.href = e.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = e.url;
      const cp = document.createElement("button");
      cp.className = "vt-iconbtn";
      cp.textContent = "📋";
      cp.title = "copiar url";
      cp.onclick = () => this.copy(e.url, "URL");
      row.append(lbl, a, cp);
      card.appendChild(row);
    }

    // notas
    if (e.notes) {
      const row = document.createElement("div");
      row.className = "vt-row";
      const lbl = document.createElement("span");
      lbl.className = "lbl";
      lbl.textContent = "notas";
      const val = document.createElement("span");
      val.className = "notes";
      val.textContent = e.notes;
      row.append(lbl, val);
      card.appendChild(row);
    }

    // ações: editar / excluir (armed) + carimbo de atualização
    const actions = document.createElement("div");
    actions.className = "vt-entry-actions";
    const edit = document.createElement("button");
    edit.className = "vt-ebtn edit";
    edit.textContent = "✏️ Editar";
    edit.onclick = () => this.openEditor(e);

    let armed = false;
    const del = document.createElement("button");
    del.className = "vt-ebtn del";
    del.textContent = "🗑 Excluir";
    del.onclick = () => {
      if (!armed) {
        armed = true;
        del.textContent = "Confirmar exclusão?";
        del.classList.add("armed");
        return;
      }
      this.room.send("vault:delete", { id: e.id });
    };

    actions.append(edit, del);

    if (e.updatedAt) {
      const by = document.createElement("span");
      by.style.cssText = "margin-left:auto;font-size:10px;color:#9ca3af;align-self:center;";
      const when = fmtWhen(e.updatedAt);
      by.textContent = e.updatedBy ? `por ${e.updatedBy} · ${when}` : when;
      actions.appendChild(by);
    }
    card.appendChild(actions);

    return card;
  }

  /** Linha da senha: bolinhas até revelar; 👁 pede o segredo; 📋 copia (revelando se preciso). */
  private secretRow(e: EntryPub): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "vt-row";
    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = "senha";

    const st = this.revealed.get(e.id);
    const secret = document.createElement("span");
    if (st) {
      secret.className = "vt-secret";
      secret.textContent = st.password;
    } else {
      secret.className = "vt-secret hidden";
      secret.textContent = "••••••••••";
    }

    const eye = document.createElement("button");
    eye.className = "vt-iconbtn";
    eye.textContent = st ? "🙈" : "👁";
    eye.title = st ? "ocultar" : "revelar senha";
    eye.onclick = () => {
      if (this.revealed.has(e.id)) this.clearReveal(e.id, true);
      else this.room.send("vault:reveal", { id: e.id }); // onSecret vai renderizar
    };

    const cp = document.createElement("button");
    cp.className = "vt-iconbtn";
    cp.textContent = "📋";
    cp.title = "copiar senha";
    cp.onclick = () => {
      const cur = this.revealed.get(e.id);
      if (cur) this.copy(cur.password, "Senha");
      else this.room.send("vault:reveal", { id: e.id }); // revela; usuário copia depois de aparecer
    };

    row.append(lbl, secret, eye, cp);
    return row;
  }

  // ---------- prompt de texto não-bloqueante (espelha kanban.askText) ----------

  /**
   * Pergunta de texto NÃO-BLOQUEANTE (substitui window.prompt). O prompt nativo congela a thread
   * e pausa os timers — o heartbeat de posição de quem abriu para, e os outros cortam a voz/share
   * dele pela trava de frescor. Este modal DOM mantém tudo rodando. Resolve com o texto ou null.
   */
  private askText(message: string, initial = ""): Promise<string | null> {
    return new Promise((resolve) => {
      const bg = document.createElement("div");
      bg.className = "vt-modal-bg open"; // z-index 10052, acima do overlay do painel
      const m = document.createElement("div");
      m.className = "vt-modal";
      m.onclick = (ev) => ev.stopPropagation();
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
      cancel.className = "vt-btn";
      cancel.textContent = "Cancelar";
      cancel.style.background = "#6b7280";
      const ok = document.createElement("button");
      ok.className = "vt-btn";
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
      this.openPrompts.add(dismiss); // registrado pra ser fechado se o painel sumir no meio
      cancel.onclick = () => done(null);
      ok.onclick = () => done(input.value);
      input.onkeydown = (ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") {
          ev.preventDefault();
          done(input.value);
        } else if (ev.key === "Escape") {
          ev.preventDefault();
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

  // ---------- modal criar / editar ----------

  private openEditor(entry: EntryPub | null) {
    const editing = !!entry;
    this.modalBg.innerHTML = "";
    const m = document.createElement("div");
    m.className = "vt-modal";
    m.onclick = (e) => e.stopPropagation();
    const h3 = document.createElement("h3");
    h3.textContent = editing ? "Editar senha" : "Nova senha";
    m.appendChild(h3);

    const mk = (label: string, el: HTMLElement) => {
      const f = document.createElement("div");
      f.className = "vt-field";
      const l = document.createElement("label");
      l.textContent = label;
      f.append(l, el);
      m.appendChild(f);
    };

    const groupSel = document.createElement("select");
    for (const o of GROUP_OPTS) groupSel.appendChild(new Option(o.label, o.value));
    // grupo livre: se o valor atual não está nas opções, adiciona
    const curGroup = entry?.group ?? "ativo";
    if (curGroup && !GROUP_OPTS.some((o) => o.value === curGroup)) {
      groupSel.appendChild(new Option(curGroup, curGroup));
    }
    groupSel.value = curGroup;
    mk("Grupo", groupSel);

    const client = document.createElement("input");
    client.value = entry?.client ?? "";
    client.placeholder = "Nome do cliente";
    mk("Cliente", client);

    const service = document.createElement("input");
    service.value = entry?.service ?? "";
    service.placeholder = "Serviço (ex: Meta Ads, Google Ads, Hostinger)";
    mk("Serviço", service);

    const username = document.createElement("input");
    username.value = entry?.username ?? "";
    username.placeholder = "Usuário / e-mail / login";
    mk("Usuário", username);

    const password = document.createElement("input");
    password.type = "text"; // texto pra o usuário conferir o que digita ao criar/editar
    // ao editar, o campo começa vazio: senha não vem na EntryPub. Vazio = manter a atual no servidor.
    password.value = "";
    password.placeholder = editing
      ? "(deixe em branco para manter a senha atual)"
      : "Senha";
    mk("Senha", password);

    const url = document.createElement("input");
    url.type = "url";
    url.value = entry?.url ?? "";
    url.placeholder = "https://…";
    mk("URL", url);

    const notes = document.createElement("textarea");
    notes.value = entry?.notes ?? "";
    notes.placeholder = "Notas (opcional)";
    mk("Notas", notes);

    const err = document.createElement("div");
    err.className = "vt-err";
    m.appendChild(err);

    const actions = document.createElement("div");
    actions.className = "vt-modal-actions";
    const cancel = document.createElement("button");
    cancel.className = "vt-btn close";
    cancel.textContent = "Cancelar";
    cancel.onclick = () => this.closeModal();
    const save = document.createElement("button");
    save.className = "vt-btn add";
    save.textContent = "Salvar";
    save.onclick = () => {
      err.textContent = "";
      // ao criar, senha é obrigatória; ao editar, vazio significa "manter a atual"
      const pw = password.value;
      if (!editing && !pw) {
        err.textContent = "Informe a senha.";
        password.focus();
        return;
      }
      const payload: VaultSavePayload = {
        group: groupSel.value.slice(0, LIMITS.group),
        client: client.value.trim().slice(0, LIMITS.client),
        service: service.value.trim().slice(0, LIMITS.service),
        username: username.value.trim().slice(0, LIMITS.username),
        password: pw.slice(0, LIMITS.password),
        url: url.value.trim().slice(0, LIMITS.url),
        notes: notes.value.slice(0, LIMITS.notes),
      };
      if (editing && entry) payload.id = entry.id;
      this.room.send("vault:save", { entry: payload });
      this.closeModal();
    };
    actions.append(cancel, save);
    m.appendChild(actions);
    this.modalBg.appendChild(m);
    this.modalBg.classList.add("open");
    client.focus();
  }

  // ---------- modal importar de .md ----------

  private openImport() {
    this.modalBg.innerHTML = "";
    const m = document.createElement("div");
    m.className = "vt-modal";
    m.onclick = (e) => e.stopPropagation();
    const h3 = document.createElement("h3");
    h3.textContent = "📥 Importar de .md";
    m.appendChild(h3);

    const hint = document.createElement("div");
    hint.style.cssText = "font-size:12px;color:#6b7280;margin-bottom:8px;";
    hint.textContent =
      "Cole o conteúdo do .md. As entradas são MESCLADAS (não apagam as existentes).";
    m.appendChild(hint);

    const ta = document.createElement("textarea");
    ta.className = "imp";
    ta.placeholder = "Cole aqui o markdown do cofre…";
    const field = document.createElement("div");
    field.className = "vt-field";
    field.appendChild(ta);
    m.appendChild(field);

    const err = document.createElement("div");
    err.className = "vt-err";
    m.appendChild(err);

    const actions = document.createElement("div");
    actions.className = "vt-modal-actions";
    const cancel = document.createElement("button");
    cancel.className = "vt-btn close";
    cancel.textContent = "Cancelar";
    cancel.onclick = () => this.closeModal();
    const ok = document.createElement("button");
    ok.className = "vt-btn import";
    ok.textContent = "📥 Importar";
    ok.onclick = () => {
      const text = ta.value;
      if (!text.trim()) {
        err.textContent = "Cole o conteúdo do .md primeiro.";
        ta.focus();
        return;
      }
      this.room.send("vault:import", { text });
      this.closeModal();
    };
    actions.append(cancel, ok);
    m.appendChild(actions);
    this.modalBg.appendChild(m);
    this.modalBg.classList.add("open");
    ta.focus();
  }

  private closeModal() {
    this.modalBg.classList.remove("open");
    this.modalBg.innerHTML = "";
  }

  destroy() {
    document.removeEventListener("keydown", this.onKeydown);
    this.dismissPrompts(); // não deixa askText pendurado ao ser destruído no reconnect
    this.clearRevealed(); // segurança: nenhuma senha revelada sobrevive à destruição
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.overlay.remove();
    this.modalBg.remove();
    this.toastEl.remove();
  }
}
