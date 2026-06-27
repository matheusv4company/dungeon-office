import Phaser from "phaser";
import { CHARACTERS, FRAME, charKey, loadSelection, saveSelection } from "../characters";
import { getFlags } from "../net/config";
import {
  fetchMembers,
  login,
  loadMember,
  saveMember,
  clearMember,
  type SavedMember,
} from "../auth/login";

/** Tela inicial: escolher 1 de 10 personagens + se identificar (login por membro+PIN). */
export class CharacterSelectScene extends Phaser.Scene {
  private selected = 0;
  private highlight!: Phaser.GameObjects.Rectangle;
  private nameInput?: HTMLInputElement;
  private positions: Array<{ x: number; y: number }> = [];

  // ---- login (F1) ----
  private panelEl?: HTMLDivElement; // painel DOM do login
  private panelDom?: Phaser.GameObjects.DOMElement; // wrapper Phaser (pra reancorar no resize de conteúdo)
  private members: string[] = []; // nomes pro dropdown (carregados do servidor)
  private busy = false; // trava o botao durante a requisicao

  constructor() {
    super("select");
  }

  create() {
    const W = this.scale.width;
    const H = this.scale.height;
    const isPhone = W < 640; // celular em retrato
    this.cameras.main.setBackgroundColor("#15131d");

    const useLogin = getFlags().login; // F1 atrás do flag; off = campo de nome livre antigo

    const titleY = isPhone ? 26 : 40;
    this.add
      .text(W / 2, titleY, "Escolha seu personagem", {
        fontFamily: "monospace",
        fontSize: isPhone ? "18px" : "26px",
        color: "#f0e6c8",
      })
      .setOrigin(0.5);

    const saved = loadSelection();
    this.selected = saved.index;

    // grade responsiva: cabe na largura E na altura disponível.
    const cols = isPhone ? 3 : 5;
    const rows = Math.ceil(CHARACTERS.length / cols);
    const gridTop = titleY + (isPhone ? 30 : 58);
    // o painel de login ocupa mais espaço vertical que o campo de nome simples
    const bottomReserved = useLogin ? 250 : 168;
    const cellW = Math.min(134, (W - 24) / cols);
    const cellH = Math.min(164, Math.max(96, (H - bottomReserved - gridTop) / rows));
    const spriteScale = Math.max(1, Math.min(1.8, cellH / 92));
    const nameDY = cellH * 0.34;
    const startX = W / 2 - (cols * cellW) / 2 + cellW / 2;
    const startY = gridTop + cellH / 2;

    this.highlight = this.add
      .rectangle(0, 0, Math.max(72, 58 * spriteScale), cellH * 0.84, 0xffd36b, 0.12)
      .setStrokeStyle(3, 0xffd36b)
      .setVisible(false)
      .setDepth(0);

    CHARACTERS.forEach((c, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = startX + col * cellW;
      const y = startY + row * cellH;
      this.positions[i] = { x, y };

      const img = this.add
        .image(x, y - cellH * 0.08, charKey(i), FRAME.downIdle)
        .setScale(spriteScale)
        .setDepth(1)
        .setInteractive({ useHandCursor: true });
      img.on("pointerover", () => img.setScale(spriteScale * 1.08));
      img.on("pointerout", () => img.setScale(spriteScale));
      img.on("pointerdown", () => this.select(i));

      // nome ABAIXO do sprite
      this.add
        .text(x, y + nameDY, c.name, {
          fontFamily: "monospace",
          fontSize: isPhone ? "10px" : "12px",
          color: "#cfc7b0",
          align: "center",
        })
        .setOrigin(0.5)
        .setDepth(2);
    });

    this.select(this.selected);

    if (useLogin) this.buildLoginUI(W, H);
    else this.buildNameInput(W, H, saved.name);
  }

  private select(i: number) {
    this.selected = i;
    const p = this.positions[i];
    if (p) this.highlight.setPosition(p.x, p.y).setVisible(true);
  }

  // ===================== caminho SEM login (flag off) — comportamento antigo =====================

  private buildNameInput(W: number, H: number, savedName: string) {
    this.add
      .text(W / 2, H - 150, "Seu nome:", {
        fontFamily: "monospace",
        fontSize: "16px",
        color: "#cfc7b0",
      })
      .setOrigin(0.5);

    const inputW = Math.min(300, W - 40);
    const style =
      `width:${inputW}px;padding:11px 12px;font-family:monospace;font-size:16px;` +
      "border-radius:8px;border:2px solid #5a4a2a;background:#221c12;color:#f0e6c8;" +
      "text-align:center;outline:none;box-sizing:border-box;";
    const dom = this.add.dom(W / 2, H - 112, "input", style);
    const input = dom.node as HTMLInputElement;
    input.type = "text";
    input.maxLength = 16;
    input.id = "ev-name-input";
    input.placeholder = "Convidado";
    input.value = savedName;
    input.autocomplete = "off";
    input.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") this.enterFreeName();
    });
    this.nameInput = input;
    window.setTimeout(() => input.focus(), 60);

    const btn = this.add
      .text(W / 2, H - 52, "  Entrar no escritório  ", {
        fontFamily: "monospace",
        fontSize: "18px",
        color: "#15131d",
        backgroundColor: "#ffd36b",
        padding: { x: 10, y: 9 },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    btn.on("pointerover", () => btn.setBackgroundColor("#ffe49a"));
    btn.on("pointerout", () => btn.setBackgroundColor("#ffd36b"));
    btn.on("pointerdown", () => this.enterFreeName());
  }

  private enterFreeName() {
    const fallback = document.getElementById("ev-name-input") as HTMLInputElement | null;
    const raw = this.nameInput?.value ?? fallback?.value ?? "";
    const name = raw.trim().slice(0, 16) || "Convidado";
    saveSelection(this.selected, name);
    this.scene.start("office");
  }

  // ===================== caminho COM login (F1) =====================

  private buildLoginUI(W: number, H: number) {
    this.injectLoginStyles();
    const div = document.createElement("div");
    div.className = "ev-login";
    div.style.width = `${Math.min(340, W - 36)}px`;
    this.panelEl = div;
    // ancora o painel pela BASE (origin y=1): cresce pra cima conforme o modo, nunca corta embaixo
    this.panelDom = this.add.dom(W / 2, H - 20, div).setOrigin(0.5, 1);

    const saved = loadMember();
    if (saved) {
      // relogin automático neste device — entra direto, sem PIN.
      this.renderWelcome(saved);
    } else {
      // 1º acesso (ou trocou de pessoa): mostra o login. Busca a lista de membros.
      this.renderLogin();
      void fetchMembers().then((list) => {
        this.members = list;
        // só repinta se ainda estamos no painel de login (usuário pode ter ido pra convidado)
        if (this.panelEl?.isConnected && this.panelEl.dataset.mode === "login") this.renderLogin();
      });
    }
  }

  /** Modo BEM-VINDO DE VOLTA: nome salvo, entra direto. */
  private renderWelcome(m: SavedMember) {
    const div = this.panelEl;
    if (!div) return;
    div.dataset.mode = "welcome";
    div.innerHTML = `
      <div class="ev-welcome">Bem-vindo de volta,<br><b>${escapeHtml(m.displayName)}</b>!</div>
      <button class="ev-go" type="button">Entrar no escritório</button>
      <span class="ev-link ev-switch">Não é você? Trocar de pessoa</span>
    `;
    div.querySelector<HTMLButtonElement>(".ev-go")?.addEventListener("click", () =>
      this.enterAsMember(m),
    );
    div.querySelector<HTMLElement>(".ev-switch")?.addEventListener("click", () => {
      clearMember();
      this.renderLogin();
      // carrega a lista se ainda não veio
      if (this.members.length === 0) {
        void fetchMembers().then((list) => {
          this.members = list;
          if (this.panelEl?.isConnected && this.panelEl.dataset.mode === "login") this.renderLogin();
        });
      }
    });
    this.panelDom?.updateSize();
  }

  /** Modo LOGIN: dropdown de membro + PIN. */
  private renderLogin() {
    const div = this.panelEl;
    if (!div) return;
    div.dataset.mode = "login";
    const opts =
      this.members.length === 0
        ? `<option value="">(carregando membros…)</option>`
        : `<option value="">— escolha seu nome —</option>` +
          this.members.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
    div.innerHTML = `
      <div class="ev-hint">Quem é você?</div>
      <select class="ev-member">${opts}</select>
      <input class="ev-pin" type="password" inputmode="numeric" autocomplete="off"
             maxlength="8" placeholder="PIN (4 a 8 dígitos)" />
      <button class="ev-go" type="button">Entrar</button>
      <div class="ev-msg"></div>
      <span class="ev-link ev-guest">ou entrar como convidado →</span>
      <div class="ev-hint">1º acesso? Escolha seu nome e crie um PIN agora.</div>
    `;
    const sel = div.querySelector<HTMLSelectElement>(".ev-member");
    const pin = div.querySelector<HTMLInputElement>(".ev-pin");
    const go = div.querySelector<HTMLButtonElement>(".ev-go");
    go?.addEventListener("click", () => this.doLogin());
    pin?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.doLogin();
    });
    div.querySelector<HTMLElement>(".ev-guest")?.addEventListener("click", () => this.renderGuest());
    // só dígitos no PIN
    pin?.addEventListener("input", () => {
      pin.value = pin.value.replace(/\D/g, "").slice(0, 8);
    });
    this.panelDom?.updateSize();
    window.setTimeout(() => (this.members.length ? sel?.focus() : pin?.focus()), 60);
  }

  /** Modo CONVIDADO: nome livre, sem progresso. */
  private renderGuest() {
    const div = this.panelEl;
    if (!div) return;
    div.dataset.mode = "guest";
    div.innerHTML = `
      <div class="ev-hint">Entrar como convidado (sem progresso salvo)</div>
      <input class="ev-guest-name" type="text" maxlength="16" autocomplete="off" placeholder="Seu nome" />
      <button class="ev-go" type="button">Entrar no escritório</button>
      <span class="ev-link ev-back">← voltar pro login</span>
    `;
    const name = div.querySelector<HTMLInputElement>(".ev-guest-name");
    div.querySelector<HTMLButtonElement>(".ev-go")?.addEventListener("click", () =>
      this.enterAsGuest(name?.value ?? ""),
    );
    name?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.enterAsGuest(name.value);
    });
    div.querySelector<HTMLElement>(".ev-back")?.addEventListener("click", () => this.renderLogin());
    this.panelDom?.updateSize();
    window.setTimeout(() => name?.focus(), 60);
  }

  private setMsg(text: string, kind: "err" | "ok" | "") {
    const msg = this.panelEl?.querySelector<HTMLDivElement>(".ev-msg");
    if (!msg) return;
    msg.textContent = text;
    msg.className = `ev-msg${kind ? " " + kind : ""}`;
  }

  private async doLogin() {
    if (this.busy) return;
    const div = this.panelEl;
    if (!div) return;
    const member = div.querySelector<HTMLSelectElement>(".ev-member")?.value ?? "";
    const pin = div.querySelector<HTMLInputElement>(".ev-pin")?.value ?? "";
    if (!member) {
      this.setMsg("Escolha seu nome na lista 🙂", "err");
      return;
    }
    if (!/^\d{4,8}$/.test(pin)) {
      this.setMsg("O PIN tem de 4 a 8 dígitos.", "err");
      return;
    }
    const go = div.querySelector<HTMLButtonElement>(".ev-go");
    this.busy = true;
    if (go) {
      go.disabled = true;
      go.textContent = "Entrando…";
    }
    this.setMsg("", "");
    const res = await login(member, pin);
    this.busy = false;
    if (go) {
      go.disabled = false;
      go.textContent = "Entrar";
    }
    if (res.ok && res.member) {
      this.enterAsMember(res.member);
      return;
    }
    if (res.status === "wrong") this.setMsg("PIN incorreto — tenta de novo 🙂", "err");
    else if (res.status === "invalid") this.setMsg("Escolha um membro e um PIN de 4 a 8 dígitos.", "err");
    else this.setMsg("Servidor fora do ar. Tente entrar como convidado.", "err");
  }

  private enterAsMember(m: SavedMember) {
    saveMember(m);
    saveSelection(this.selected, m.displayName);
    this.scene.start("office");
  }

  private enterAsGuest(rawName: string) {
    const name = rawName.trim().slice(0, 16) || "Convidado";
    clearMember();
    saveSelection(this.selected, name);
    this.scene.start("office");
  }

  private injectLoginStyles() {
    if (document.getElementById("ev-login-styles")) return;
    const s = document.createElement("style");
    s.id = "ev-login-styles";
    s.textContent = `
      .ev-login { display:flex; flex-direction:column; gap:9px; align-items:stretch;
        font-family:monospace; color:#f0e6c8; text-align:center; }
      .ev-login select, .ev-login input { width:100%; box-sizing:border-box; padding:11px 12px;
        font-family:monospace; font-size:16px; border-radius:8px; border:2px solid #5a4a2a;
        background:#221c12; color:#f0e6c8; text-align:center; outline:none; }
      .ev-login button { padding:11px 12px; font-family:monospace; font-size:18px; font-weight:700;
        border:none; border-radius:8px; background:#ffd36b; color:#15131d; cursor:pointer; }
      .ev-login button:hover { background:#ffe49a; }
      .ev-login button:disabled { opacity:.6; cursor:default; }
      .ev-login .ev-link { color:#9ec9ff; font-size:13px; cursor:pointer; text-decoration:underline; }
      .ev-login .ev-hint { color:#cfc7b0; font-size:12px; }
      .ev-login .ev-welcome { color:#f0e6c8; font-size:16px; line-height:1.5; }
      .ev-login .ev-welcome b { color:#ffd36b; font-size:20px; }
      .ev-login .ev-msg { font-size:13px; min-height:16px; }
      .ev-login .ev-msg.err { color:#ff9a9a; }
      .ev-login .ev-msg.ok { color:#8fe9a0; }
    `;
    document.head.appendChild(s);
  }
}

/** Escapa texto pra interpolar com segurança em innerHTML (nomes de membros). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
