/**
 * Painel "📋 Atas" — as atas das reuniões moram AQUI (não viram card no gestor).
 * Lista as últimas reuniões com resumo, decisões, participantes e quantas tarefas 🤖
 * foram criadas. Overlay leve no padrão da casa (Esc fecha; onOpenChange avisa a cena
 * pra travar o input do Phaser, com o cuidado do delayedCall).
 */
import type { Room } from "../net/room";

export type AtaView = {
  startedAt: number;
  endedAt: number;
  zone: number;
  speakers: string[];
  utterances: number;
  ata: { resumo: string; decisoes: string[]; tarefas: { titulo: string; responsavel: string; cliente: string; due: string }[] } | null;
};

const STYLE_ID = "atas-styles";
const ZONE_NAMES = ["sala azul", "sala vermelha", "sala dourada"];

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
.at-overlay{position:fixed;inset:0;z-index:10000;display:none;flex-direction:column;
  background:#0b0a12ee;font-family:system-ui,Segoe UI,monospace;color:#e5e0d0;}
.at-overlay.open{display:flex;}
.at-top{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;}
.at-top h2{margin:0;font-size:17px;color:#f0e6c8;}
.at-close{font:13px monospace;background:#3a3340;color:#fff;border:none;border-radius:7px;
  padding:7px 14px;cursor:pointer;}
.at-list{flex:1;overflow-y:auto;padding:0 20px 20px;display:flex;flex-direction:column;
  gap:12px;max-width:860px;width:100%;margin:0 auto;box-sizing:border-box;}
.at-card{background:#15131d;border:1px solid #3a3550;border-radius:10px;padding:14px 16px;}
.at-card h3{margin:0 0 4px;font-size:14px;color:#ffd34d;}
.at-meta{font-size:12px;color:#9a93a8;margin-bottom:8px;}
.at-sec{font-size:12px;font-weight:700;color:#8fd3a0;margin:8px 0 3px;text-transform:uppercase;}
.at-body{font-size:13px;line-height:1.5;white-space:pre-line;color:#ddd6c6;}
.at-task{font-size:13px;color:#ddd6c6;padding:2px 0;}
.at-task .who{color:#7fb8ff;}
.at-empty{text-align:center;color:#9a93a8;font-size:14px;margin-top:60px;}
`;
  document.head.appendChild(s);
}

export class AtasPanel {
  onOpenChange?: (open: boolean) => void;
  private overlay: HTMLDivElement;
  private list: HTMLDivElement;
  private opened = false;

  constructor(private room: Room) {
    injectStyles();
    this.overlay = document.createElement("div");
    this.overlay.className = "at-overlay";
    const top = document.createElement("div");
    top.className = "at-top";
    const h2 = document.createElement("h2");
    h2.textContent = "📋 Atas das reuniões";
    const close = document.createElement("button");
    close.className = "at-close";
    close.textContent = "✕ Fechar";
    close.onclick = () => this.close();
    top.append(h2, close);
    this.list = document.createElement("div");
    this.list.className = "at-list";
    this.overlay.append(top, this.list);
    document.body.appendChild(this.overlay);
    document.addEventListener("keydown", this.onKeydown);
  }

  private onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.opened) this.close();
  };

  open(): void {
    if (this.opened) return;
    this.opened = true;
    this.overlay.classList.add("open");
    this.list.innerHTML = `<div class="at-empty">Carregando…</div>`;
    try {
      this.room.send("atas:list", {});
    } catch {
      /* reconectando */
    }
    this.onOpenChange?.(true);
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.overlay.classList.remove("open");
    this.onOpenChange?.(false);
  }

  toggle(): void {
    if (this.opened) this.close();
    else this.open();
  }

  isOpen(): boolean {
    return this.opened;
  }

  /** Resposta do servidor ("atas:list"). */
  onList(atas: AtaView[]): void {
    this.list.innerHTML = "";
    if (!atas.length) {
      const e = document.createElement("div");
      e.className = "at-empty";
      e.textContent =
        "Nenhuma ata ainda. Faça uma reunião (2+ membros numa sala, com voz) — a ata aparece aqui ~1 min depois que todos saírem.";
      this.list.appendChild(e);
      return;
    }
    const fmt = new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    for (const m of atas) {
      const card = document.createElement("div");
      card.className = "at-card";
      const h3 = document.createElement("h3");
      h3.textContent = `📋 ${fmt.format(new Date(m.startedAt))} — ${ZONE_NAMES[m.zone] ?? `sala ${m.zone}`}`;
      const meta = document.createElement("div");
      meta.className = "at-meta";
      const durMin = Math.max(1, Math.round((m.endedAt - m.startedAt) / 60000));
      meta.textContent = `${durMin} min · participantes: ${m.speakers.join(", ") || "—"} · ${m.utterances} falas`;
      card.append(h3, meta);
      if (!m.ata) {
        const b = document.createElement("div");
        b.className = "at-body";
        b.textContent = "⚠️ O resumo falhou nessa reunião (IA indisponível). O transcript bruto está guardado no servidor.";
        card.appendChild(b);
      } else {
        const sr = document.createElement("div");
        sr.className = "at-sec";
        sr.textContent = "Resumo";
        const body = document.createElement("div");
        body.className = "at-body";
        body.textContent = m.ata.resumo;
        card.append(sr, body);
        if (m.ata.decisoes.length) {
          const sd = document.createElement("div");
          sd.className = "at-sec";
          sd.textContent = "Decisões";
          const bd = document.createElement("div");
          bd.className = "at-body";
          bd.textContent = m.ata.decisoes.map((d) => `• ${d}`).join("\n");
          card.append(sd, bd);
        }
        if (m.ata.tarefas.length) {
          const st = document.createElement("div");
          st.className = "at-sec";
          st.textContent = `Tarefas criadas (${m.ata.tarefas.length})`;
          card.appendChild(st);
          for (const t of m.ata.tarefas) {
            const row = document.createElement("div");
            row.className = "at-task";
            // textContent SEMPRE (o título vem da IA sobre fala transcrita — nunca innerHTML)
            row.appendChild(document.createTextNode(`🤖 ${t.titulo} `));
            const who = document.createElement("span");
            who.className = "who";
            who.textContent = [t.responsavel && `→ ${t.responsavel}`, t.cliente && `(${t.cliente})`, t.due && `até ${t.due}`]
              .filter(Boolean)
              .join(" ");
            row.appendChild(who);
            card.appendChild(row);
          }
        }
      }
      this.list.appendChild(card);
    }
  }

  destroy(): void {
    document.removeEventListener("keydown", this.onKeydown);
    this.overlay.remove();
  }
}
