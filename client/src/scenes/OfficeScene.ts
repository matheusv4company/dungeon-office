import Phaser from "phaser";
import { charKey, ensureCharAnims, FRAME, loadSelection } from "../characters";
import { joinOffice, getStateCallbacks } from "../net/room";
import type { Room } from "../net/room";
import { VoiceManager } from "../net/voice";
import { KanbanBoard } from "../ui/kanban";
import { loadMember } from "../auth/login";
import { getFlags } from "../net/config";
import { daysToDue } from "../util/overdue";

const T = 32;
const COLS = 30;
const SPEED = 170;
const UI_DEPTH = 10000;

// ---- mapa em 3 andares (de cima pra baixo): praia · escritorio · cripta ----
const BEACH_ROWS = 16; // praia (topo)
const OFFICE_ROWS = 22; // escritorio (meio) — mantem o layout atual
const CRYPT_ROWS = 18; // cripta (baixo)
const OY = BEACH_ROWS + 1; // 1a linha do escritorio (= sua parede de cima)
const DIV1 = OY; // divisoria praia/escritorio
const DIV2 = OY + OFFICE_ROWS - 1; // divisoria escritorio/cripta
const CRYPT_Y0 = OY + OFFICE_ROWS; // 1a linha da cripta
const ROWS = CRYPT_Y0 + CRYPT_ROWS; // total de linhas
const W = COLS * T; // largura do mapa (px)
const H = ROWS * T; // altura do mapa (px)

// dir: 0=baixo, 1=cima, 2=esquerda, 3=direita
const DIR_NAME = ["down", "up", "left", "right"] as const;
const IDLE_FRAME = [FRAME.downIdle, FRAME.upIdle, FRAME.leftIdle, FRAME.rightIdle];

// chamas (tocha/braseiro): laranja padrao e verde amaldicoado (cripta)
type Flame = { glow: number; tints: [number, number, number] };
const FLAME_ORANGE: Flame = { glow: 0xff8a2e, tints: [0xfff3a0, 0xffb24d, 0xff6a2a] };
const FLAME_GREEN: Flame = { glow: 0x47ff9e, tints: [0xb6ffd8, 0x57ffb0, 0x23e57a] };

// voz: raios de proximidade (px) — queda quadratica (cai rapido com a distancia)
const VOICE_FULL = 40; // dentro disso: volume cheio (~1 tile)
const VOICE_MAX = 160; // alem disso: silencio (~5 tiles)
const VOICE_STALE_MS = 1500; // sem update de posicao ha mais que isso: nao confio (mudo)

// zonas de reuniao (px) — dentro de uma zona, so quem esta na MESMA zona se ouve.
// A posicao rastreada e o CENTRO do sprite, que fica ~0.6 tile ACIMA dos pes; por
// isso a zona sobe ate a parede de cima (OY) e encosta nas laterais — assim quem
// fica colado em qualquer parede continua dentro da bolha, e nada vaza pro lado de fora.
const MEETING_ZONES = [{ x1: 0, y1: OY * T, x2: 9 * T, y2: (OY + 7) * T }];
function zoneAt(x: number, y: number): number {
  for (let i = 0; i < MEETING_ZONES.length; i++) {
    const z = MEETING_ZONES[i];
    if (x >= z.x1 && x <= z.x2 && y >= z.y1 && y <= z.y2) return i;
  }
  return -1;
}

// qual andar um Y representa (0=praia, 1=escritorio, 2=cripta)
function floorOfY(y: number): number {
  if (y < OY * T) return 0;
  if (y < CRYPT_Y0 * T) return 1;
  return 2;
}

type Rect = { c: number; r: number; w: number; h: number };
type Decor = [col: number, row: number, key: string];
type Remote = {
  sprite: Phaser.GameObjects.Sprite;
  label: Phaser.GameObjects.Text;
  ring: Phaser.GameObjects.Ellipse;
  hand: Phaser.GameObjects.Text;
  hpBg: Phaser.GameObjects.Rectangle;
  hpFill: Phaser.GameObjects.Rectangle;
  hp: number;
  dmgAt: number; // quando levou dano por ultimo (ms da cena); 0 = nunca
};

export class OfficeScene extends Phaser.Scene {
  private player!: Phaser.Physics.Arcade.Sprite;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keys!: Record<"W" | "A" | "S" | "D", Phaser.Input.Keyboard.Key>;
  private obstacles: Phaser.GameObjects.GameObject[] = [];
  private charIndex = 0;
  private memberId = ""; // identidade durável de gamificação (vazio = convidado)
  private nameLabel!: Phaser.GameObjects.Text;

  // multiplayer
  private room?: Room;
  private remotes = new Map<string, Remote>();
  private lastSent = 0;
  private lastDir = 0;

  // voz
  private voice = new VoiceManager();
  private voiceBtn?: Phaser.GameObjects.Text;
  private shareBtn?: Phaser.GameObjects.Text;
  private micBtn?: Phaser.GameObjects.Text;
  private micMenu?: HTMLDivElement;
  private lastSharing = false;
  private voiceOn = false;
  private lastMic = false;
  private sessionId = "";
  private meetingBadge?: Phaser.GameObjects.Text;
  private rosterHeader?: Phaser.GameObjects.Text;
  private rosterRows: Phaser.GameObjects.Text[] = [];
  private localRing?: Phaser.GameObjects.Ellipse;
  private reconnectBadge?: Phaser.GameObjects.Text;
  private leaving = false;
  private reconnecting = false;

  // levantar a mao (pedir pra falar)
  private handBtn?: Phaser.GameObjects.Text;
  private handRaised = false;
  private handKey?: Phaser.Input.Keyboard.Key;
  private localHand?: Phaser.GameObjects.Text;
  private lastHandsSig = "";
  // F5 — visão própria do atraso (nuvem privada) + clima do escritório (agregado, sem nomes)
  private localCloud?: Phaser.GameObjects.Text; // nuvenzinha SÓ sobre o meu avatar (só eu vejo)
  private myOverdue = 0; // qtas tarefas MINHAS estão atrasadas (recalc por timer)
  private climateEl?: HTMLDivElement; // badge HUD do clima (DOM)
  private climateLabel?: HTMLSpanElement;
  private climateTimer?: ReturnType<typeof setInterval>;
  // F6 — HUD discreto do MEU progresso (nível/XP/% vs própria média)
  private progressEl?: HTMLDivElement;
  private prevHand = new Map<string, boolean>(); // sid -> mao levantada (p/ detectar a subida)

  // bola de fogo (espaco) — efeito efemero sincronizado
  private fireKey?: Phaser.Input.Keyboard.Key;
  private lastFire = 0;

  // ---- controles de toque (mobile) ----
  private isTouch = false;
  private joyBase?: Phaser.GameObjects.Arc;
  private joyThumb?: Phaser.GameObjects.Arc;
  private joyVec = { x: 0, y: 0 }; // direção analógica do joystick (-1..1)
  private joyId = -1; // pointer.id que controla o joystick (-1 = nenhum)
  private joyR = 56; // raio da base do joystick
  private fireBtn?: Phaser.GameObjects.Text;
  private pinchPrev = 0; // distância anterior entre 2 dedos (pinça)
  private voiceBgTimer?: ReturnType<typeof setInterval>; // recalcula proximidade com a aba oculta
  private lastPosAt = new Map<string, number>(); // sid -> ms do ultimo update de posicao (frescor)
  private lastVoiceRecalc = 0; // throttle do recalculo dirigido por update de posicao (WS)
  private kanban?: KanbanBoard; // gestor de tarefas (overlay)
  private gestorBtn?: Phaser.GameObjects.Text;

  // HP / dano / morte
  private dead = false;
  private myHpBg?: Phaser.GameObjects.Rectangle;
  private myHpFill?: Phaser.GameObjects.Rectangle;
  private myHp = 100;
  private myDmgAt = 0;
  private deathOverlay?: HTMLDivElement;

  // camera/zoom — HUD fica numa camera propria pra NAO escalar com o zoom
  private uiCam?: Phaser.Cameras.Scene2D.Camera;
  private hudLayer?: Phaser.GameObjects.Layer;
  private callToast?: HTMLDivElement;
  private onResizeRef?: (g: Phaser.Structs.Size) => void;

  // andares (0=praia, 1=escritorio, 2=cripta) — so o atual fica visivel.
  // Objetos ficam na lista da cena (nao em Layers) pra preservar o y-sort global.
  private floorObjs: Phaser.GameObjects.GameObject[][] = [];
  private currentFloor = 1;
  private stairs: Array<{ x1: number; y1: number; x2: number; y2: number; tx: number; ty: number }> = [];
  private stairLatch = false;
  private floorCdUntil = 0;

  // escuridao da cripta: overlay quase preto com "buracos" de luz (tochas + player)
  private darkRT?: Phaser.GameObjects.RenderTexture;
  private cryptLights: Array<{ x: number; y: number }> = [];

  constructor() {
    super("office");
  }

  create() {
    const sel = loadSelection();
    this.charIndex = sel.index;
    // Identidade de gamificação só quando o login está ligado; senão entra como convidado.
    this.memberId = getFlags().login ? (loadMember()?.memberId ?? "") : "";
    this.remotes.clear();
    this.room = undefined;
    this.obstacles = [];
    this.leaving = false;
    this.reconnecting = false;
    // F5 — reset defensivo do clima/nuvem (consistente com os demais campos efêmeros)
    if (this.climateTimer) clearInterval(this.climateTimer);
    this.climateTimer = undefined;
    this.climateEl?.remove();
    this.climateEl = undefined;
    this.climateLabel = undefined;
    this.localCloud = undefined;
    this.myOverdue = 0;
    this.progressEl?.remove();
    this.progressEl = undefined;
    this.voiceBtn = undefined;
    this.shareBtn = undefined;
    this.micBtn = undefined;
    this.micMenu?.remove();
    this.micMenu = undefined;
    this.callToast?.remove();
    this.callToast = undefined;
    this.uiCam = undefined;
    this.hudLayer = undefined;
    this.lastSharing = false;
    this.voiceOn = false;
    this.lastMic = false;
    this.rosterHeader = undefined;
    this.rosterRows = [];
    this.localRing = undefined;
    this.meetingBadge = undefined;
    this.reconnectBadge = undefined;
    this.handBtn = undefined;
    this.handRaised = false;
    this.localHand = undefined;
    this.lastHandsSig = "";
    this.lastFire = 0;
    this.joyVec = { x: 0, y: 0 };
    this.joyId = -1;
    this.joyBase = undefined;
    this.joyThumb = undefined;
    this.fireBtn = undefined;
    this.pinchPrev = 0;
    if (this.voiceBgTimer) clearInterval(this.voiceBgTimer);
    this.voiceBgTimer = undefined;
    this.lastPosAt.clear();
    this.prevHand.clear();
    this.personMenuClose?.(); // fecha + remove o listener (nao so o no DOM)
    this.kanban?.destroy();
    this.kanban = undefined;
    this.gestorBtn = undefined;
    this.dead = false;
    this.myHp = 100;
    this.myDmgAt = 0;
    this.myHpBg = undefined;
    this.myHpFill = undefined;
    this.deathOverlay?.remove();
    this.deathOverlay = undefined;
    this.floorObjs = [[], [], []];
    this.currentFloor = 1;
    this.stairs = [];
    this.stairLatch = false;
    this.floorCdUntil = 0;
    this.darkRT = undefined;
    this.cryptLights = [];

    // ---- grade de colisao (andares isolados; divisorias SEM passagem) ----
    const solid: boolean[][] = Array.from({ length: ROWS }, () =>
      Array<boolean>(COLS).fill(false),
    );
    const set = (c: number, r: number, v = true) => {
      if (r >= 0 && r < ROWS && c >= 0 && c < COLS) solid[r][c] = v;
    };
    for (let c = 0; c < COLS; c++) {
      set(c, 0);
      set(c, ROWS - 1);
      set(c, DIV1); // divisoria praia/escritorio (parede cheia)
      set(c, DIV2); // divisoria escritorio/cripta (parede cheia)
    }
    for (let r = 0; r < ROWS; r++) {
      set(0, r);
      set(COLS - 1, r);
    }
    // paredes internas do escritorio (sala de reuniao)
    for (let r = 1; r <= 7; r++) set(9, OY + r);
    for (let c = 1; c <= 9; c++) set(c, OY + 7);
    set(4, OY + 7, false);

    // ---- objetos por andar (visibilidade alternada; tudo na lista da cena) ----
    this.floorObjs = [[], [], []];

    // ---- paredes: fisica unica (sempre colide) + visual em cada andar ----
    const walls = this.physics.add.staticGroup();
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (!solid[r][c]) continue;
        const key = (r * 7 + c) % 4 === 0 ? "wall2" : "wall";
        const w = walls.create(c * T + T / 2, r * T + T / 2, key) as Phaser.Physics.Arcade.Sprite;
        w.setDepth(1);
        const fr = r < OY ? 0 : r <= DIV2 ? 1 : 2;
        if (fr === 0) w.setTint(0xcdb98a);
        else if (fr === 2) w.setTint(0x4a4660);
        this.floorObjs[fr].push(w);
      }
    }
    // copias visuais das divisorias, pra aparecerem tambem do andar vizinho
    this.addDividerCopy(solid, DIV1, 0, 0xcdb98a); // teto da praia
    this.addDividerCopy(solid, DIV2, 2, 0x4a4660); // teto da cripta

    // ---- fundo + decoracao de cada andar (capturado na sua camada) ----
    this.makeFlameTexture();
    this.makeLightTexture("lightBig", 300);
    this.makeLightTexture("lightSmall", 190);
    this.buildFloorInto(0, () => {
      this.add.tileSprite(0, 0, W, OY * T, "sand1").setOrigin(0).setDepth(0);
      this.buildBeach();
    });
    this.buildFloorInto(1, () => {
      this.add.tileSprite(0, OY * T, W, OFFICE_ROWS * T, "floor").setOrigin(0).setDepth(0);
      this.add.image(4 * T + T / 2, (OY + 7) * T + T / 2, "door_open").setDepth(1);
      this.buildOfficeDecor(OY);
    });
    this.buildFloorInto(2, () => {
      this.add.tileSprite(0, CRYPT_Y0 * T, W, (ROWS - CRYPT_Y0) * T, "crypt0").setOrigin(0).setDepth(0);
      this.buildCrypt();
    });

    // ---- player ----
    ensureCharAnims(this, this.charIndex);
    const spawnX = 16 * T + T / 2;
    const spawnY = (OY + 13) * T + T / 2;
    this.player = this.physics.add
      .sprite(spawnX, spawnY, charKey(this.charIndex), FRAME.downIdle)
      .setDepth(spawnY);
    this.player.setSize(16, 12).setOffset(24, 46);
    this.physics.add.collider(this.player, walls);
    this.physics.add.collider(this.player, this.obstacles);

    this.nameLabel = this.add
      .text(spawnX, spawnY - 30, sel.name || "Convidado", {
        fontFamily: "monospace",
        fontSize: "12px",
        color: "#ffffff",
        backgroundColor: "#00000099",
        padding: { x: 4, y: 2 },
      })
      .setOrigin(0.5)
      .setDepth(UI_DEPTH);

    this.localRing = this.add
      .ellipse(spawnX, spawnY + 16, 38, 18)
      .setStrokeStyle(3, 0x3aff6a)
      .setVisible(false)
      .setDepth(spawnY - 1);

    this.localHand = this.add
      .text(spawnX, spawnY - 60, "✋", { fontFamily: "monospace", fontSize: "18px" })
      .setOrigin(0.5)
      .setVisible(false)
      .setDepth(UI_DEPTH);

    // F5 — nuvenzinha PRIVADA do atraso: só sobre o MEU avatar e só eu vejo (não sincroniza,
    // não aparece em remotos). Estado do trabalho, nunca rótulo na pessoa. Criada aqui (antes
    // da uiCam) pra já entrar no snapshot que a câmera de HUD ignora.
    this.localCloud = this.add
      .text(spawnX, spawnY - 56, "🌧️", { fontFamily: "monospace", fontSize: "16px" })
      .setOrigin(0.5)
      .setVisible(false)
      .setDepth(UI_DEPTH);

    this.myHpBg = this.add
      .rectangle(spawnX, spawnY - 44, 32, 6, 0x000000, 0.6)
      .setOrigin(0.5)
      .setVisible(false)
      .setDepth(UI_DEPTH);
    this.myHpFill = this.add
      .rectangle(spawnX - 15, spawnY - 44, 30, 4, 0x3aff6a)
      .setOrigin(0, 0.5)
      .setVisible(false)
      .setDepth(UI_DEPTH);

    // ---- camera + input + HUD ----
    this.physics.world.setBounds(0, 0, W, H);
    this.cameras.main.startFollow(this.player, true); // segue o player — sempre no centro
    this.applyFloor(this.currentFloor); // mostra so o andar atual + cor de fundo

    const kb = this.input.keyboard!;
    this.cursors = kb.createCursorKeys();
    this.keys = {
      W: kb.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      A: kb.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      S: kb.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      D: kb.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };
    this.handKey = kb.addKey(Phaser.Input.Keyboard.KeyCodes.H); // levantar/baixar a mao
    this.fireKey = kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE); // bola de fogo

    // celular/tablet (ponteiro grosso) → habilita controles de toque
    this.isTouch = window.matchMedia("(pointer: coarse)").matches;
    const hint = this.isTouch
      ? "Arraste no canto ⬋ pra andar  ·  🔥 atira  ·  toque num nome — chamar/ir até"
      : "WASD/setas — andar · scroll — zoom · clique num nome — chamar/ir até · H — mão · espaço — 🔥";
    const instr = this.add
      .text(12, 12, hint, {
        fontFamily: "monospace",
        fontSize: this.isTouch ? "11px" : "14px",
        color: "#ffffff",
        backgroundColor: "#000000aa",
        padding: { x: 8, y: 5 },
      })
      .setScrollFactor(0)
      .setDepth(UI_DEPTH);

    // ---- HUD em camera propria + zoom no scroll ----
    this.setupUiCameraAndZoom([instr]);
    this.setupTouchControls(); // joystick + botão de fogo (só no toque)

    // ---- clima do escritório (F5) + progresso (F6) + multiplayer ----
    this.setupClimate();
    this.setupProgress();
    void this.connectMultiplayer(sel.name || "Convidado", spawnX, spawnY);
  }

  // ---------- multiplayer ----------

  private async connectMultiplayer(name: string, x: number, y: number) {
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.leaving = true;
      this.voice.disconnect();
      this.micMenu?.remove();
      this.micMenu = undefined;
      this.callToast?.remove();
      this.callToast = undefined;
      this.deathOverlay?.remove();
      this.deathOverlay = undefined;
      if (this.voiceBgTimer) clearInterval(this.voiceBgTimer);
      this.voiceBgTimer = undefined;
      if (this.climateTimer) clearInterval(this.climateTimer);
      this.climateTimer = undefined;
      this.climateEl?.remove();
      this.climateEl = undefined;
      this.progressEl?.remove();
      this.progressEl = undefined;
      this.kanban?.destroy();
      this.kanban = undefined;
      if (this.onResizeRef) {
        this.scale.off(Phaser.Scale.Events.RESIZE, this.onResizeRef);
        this.onResizeRef = undefined;
      }
      try {
        this.room?.leave();
      } catch {
        /* ignore */
      }
    });

    // Mantem a proximidade da voz viva mesmo com a aba em 2o plano: o loop do
    // jogo (RAF) congela quando oculto, mas este timer continua e recalcula
    // ~1x/s usando as posicoes que chegam pelo WebSocket — mata o vazamento
    // sem precisar mutar quem esta perto. No 1o plano o update() ja cuida.
    this.voiceBgTimer = setInterval(() => {
      if (!document.hidden) return;
      this.recomputeVoiceProximity(); // protege o OUVINTE (recalcula proximidade)
      // mantem a posicao do FALANTE fresca mesmo com a aba oculta (RAF congelado):
      // o servidor recarimba `t`, senao os outros o mutariam por staleness mesmo
      // estando presente. Combinado com a trava de frescor, fecha o vazamento.
      this.room?.send("move", {
        x: Math.round(this.player.x),
        y: Math.round(this.player.y),
        dir: this.lastDir,
        moving: false,
      });
    }, 700);

    try {
      const room = await joinOffice({ name, charId: this.charIndex, x, y, memberId: this.memberId });
      this.setupVoiceButton();
      this.setupShareButton();
      this.setupGestorButton();
      this.setupMicButton();
      this.setupHandButton();
      this.wireRoom(room, name, x, y);
      console.log("[net] conectado:", room.sessionId);
    } catch (e) {
      console.warn("[net] multiplayer indisponível (servidor offline?)", e);
      this.scheduleReconnect(name, x, y);
    }
  }

  private wireRoom(room: Room, name: string, x: number, y: number) {
    this.room = room;
    this.sessionId = room.sessionId;
    this.reconnecting = false;
    // Se a voz ja estava ligada e o sessionId mudou (reconexao), reconecta a voz
    // com a nova identidade — senao ela "some" pra todos por mismatch de ID.
    if (this.voice.connected && this.voice.getIdentity() !== room.sessionId) {
      void this.voice.reconnect(room.sessionId, name).catch(() => {});
    }
    this.setupKanban(room);
    const $ = getStateCallbacks(room) as (obj: unknown) => any;
    $(room.state).players.onAdd((player: any, sid: string) => {
      if (sid !== room.sessionId) this.addRemote(sid, player);
      // frescor da posicao: o servidor carimba `t` a cada move (mesmo parado),
      // entao `t` muda ~80ms enquanto a pessoa esta viva. Se parar de chegar, a
      // posicao dela esta stale e nao da pra confiar nela pro audio (vazamento).
      this.lastPosAt.set(sid, performance.now());
      $(player).listen("t", () => {
        this.lastPosAt.set(sid, performance.now());
        // FECHA O VAZAMENTO DE 2o PLANO: com a aba oculta o RAF (update) congela e
        // o setInterval do navegador e estrangulado (>=1s, ate ~60s), entao o audio
        // de quem se afastou continuava tocando ate o timer disparar. Os updates de
        // posicao chegam pelo WebSocket SEM esse throttle — entao recalculamos a
        // proximidade aqui e re-mutamos na hora quem saiu de perto.
        if (!document.hidden) return; // em 1o plano o update() ja recalcula por frame
        const now = performance.now();
        if (now - this.lastVoiceRecalc > 120) {
          this.lastVoiceRecalc = now;
          this.recomputeVoiceProximity();
        }
      });
      this.refreshRoster();
    });
    $(room.state).players.onRemove((_p: any, sid: string) => {
      this.lastPosAt.delete(sid);
      this.prevHand.delete(sid);
      this.voice.dropTrack(sid); // some a faixa de voz junto com o jogador
      this.removeRemote(sid);
      this.refreshRoster();
    });
    room.onLeave(() => {
      if (this.leaving || this.dead || this.room !== room) return;
      this.handleDisconnect(name, x, y);
    });
    room.onMessage("called", (m: { from: string; name: string; x: number; y: number }) => {
      if (this.room !== room) return;
      this.onCalled(m);
    });
    room.onMessage("fireball", (m: { x: number; y: number; dir: number }) => {
      if (this.room !== room) return;
      if (floorOfY(m.y) === this.currentFloor) this.spawnFireball(m.x, m.y, m.dir);
    });
    room.onMessage("died", () => {
      if (this.room === room) this.onDied();
    });
    // F3: feedback PRIVADO da IA sobre a MINHA entrega (só eu recebo). Toast acima do kanban.
    room.onMessage(
      "ai:feedback",
      (m: { status?: string; score?: number; note?: string }) => {
        if (this.room !== room) return;
        this.showAiFeedback(String(m?.status ?? ""), Number(m?.score ?? -1), String(m?.note ?? ""));
      },
    );
    // F5: alguém pediu reforço pro time (cooperação) — toast pra todos os outros.
    room.onMessage("help:called", (m: { name?: string }) => {
      if (this.room !== room) return;
      this.playBeep();
      this.showToast(`🆘 ${String(m?.name ?? "Alguém")} pediu reforço!`, "#b9892a", 3000);
    });
    // F6: meu progresso (privado) — re-hidratado no join e atualizado a cada entrega creditada.
    room.onMessage(
      "progress:self",
      (v: {
        level?: number;
        xpInLevel?: number;
        xpToNext?: number;
        weekPE?: number;
        baseline?: number;
        pct?: number;
        delivered?: number;
      }) => {
        if (this.room !== room) return;
        this.updateProgressHud({
          level: Number(v?.level ?? 1),
          xpInLevel: Number(v?.xpInLevel ?? 0),
          xpToNext: Number(v?.xpToNext ?? 0),
          weekPE: Number(v?.weekPE ?? 0),
          baseline: Number(v?.baseline ?? 0),
          pct: Number(v?.pct ?? 0),
          delivered: Number(v?.delivered ?? 0),
        });
      },
    );
    this.refreshRoster();
    this.showReconnecting(false);
  }

  /** (Re)cria o gestor de tarefas ligado a sala atual (rebind em reconexao). */
  private setupKanban(room: Room) {
    const wasOpen = this.kanban?.isOpen() ?? false;
    this.kanban?.destroy();
    this.kanban = new KanbanBoard(room);
    this.kanban.onStreamChange = (on) => {
      this.room?.send("board:stream", { on });
    };
    if (wasOpen) this.kanban.open(false);
  }

  private setupGestorButton() {
    if (this.gestorBtn) return;
    const btn = this.add
      .text(this.scale.width - 16, 88, "📋 Gestor de tarefas", {
        fontFamily: "monospace",
        fontSize: "14px",
        color: "#ffffff",
        backgroundColor: "#4a3a5a",
        padding: { x: 9, y: 6 },
      })
      .setOrigin(1, 0)
      .setScrollFactor(0)
      .setDepth(UI_DEPTH)
      .setInteractive({ useHandCursor: true });
    this.gestorBtn = btn;
    this.hudLayer?.add(btn);
    btn.on("pointerdown", () => this.kanban?.toggle());
  }

  private handleDisconnect(name: string, x: number, y: number) {
    this.room = undefined;
    this.remotes.forEach((r) => {
      r.sprite.destroy();
      r.label.destroy();
      r.ring.destroy();
      r.hand.destroy();
      r.hpBg.destroy();
      r.hpFill.destroy();
    });
    this.remotes.clear();
    this.refreshRoster();
    this.showReconnecting(true);
    this.scheduleReconnect(name, x, y);
  }

  private scheduleReconnect(name: string, x: number, y: number) {
    if (this.leaving || this.dead || this.room || this.reconnecting) return;
    this.reconnecting = true;
    this.time.delayedCall(3000, async () => {
      this.reconnecting = false;
      if (this.leaving || this.room) return;
      try {
        const room = await joinOffice({ name, charId: this.charIndex, x, y, memberId: this.memberId });
        if (this.leaving) {
          try {
            room.leave();
          } catch {
            /* ignore */
          }
          return;
        }
        this.wireRoom(room, name, x, y);
        console.log("[net] reconectado:", room.sessionId);
      } catch {
        this.scheduleReconnect(name, x, y);
      }
    });
  }

  private addRemote(sessionId: string, player: any) {
    ensureCharAnims(this, player.charId);
    const sprite = this.add
      .sprite(player.x, player.y, charKey(player.charId), FRAME.downIdle)
      .setDepth(player.y);
    const label = this.add
      .text(player.x, player.y - 30, player.name, {
        fontFamily: "monospace",
        fontSize: "12px",
        color: "#ffe9b0",
        backgroundColor: "#00000099",
        padding: { x: 4, y: 2 },
      })
      .setOrigin(0.5)
      .setDepth(UI_DEPTH);
    const ring = this.add
      .ellipse(player.x, player.y + 16, 38, 18)
      .setStrokeStyle(3, 0x3aff6a)
      .setVisible(false)
      .setDepth(player.y - 1);
    const hand = this.add
      .text(player.x, player.y - 60, "✋", { fontFamily: "monospace", fontSize: "18px" })
      .setOrigin(0.5)
      .setVisible(false)
      .setDepth(UI_DEPTH);
    const hpBg = this.add
      .rectangle(player.x, player.y - 44, 32, 6, 0x000000, 0.6)
      .setOrigin(0.5)
      .setVisible(false)
      .setDepth(UI_DEPTH);
    const hpFill = this.add
      .rectangle(player.x - 15, player.y - 44, 30, 4, 0x3aff6a)
      .setOrigin(0, 0.5)
      .setVisible(false)
      .setDepth(UI_DEPTH);
    // clicar no nome = chamar essa pessoa
    label.setInteractive({ useHandCursor: true });
    label.on("pointerover", () => label.setColor("#ffd34d"));
    label.on("pointerout", () => label.setColor("#ffe9b0"));
    label.on("pointerdown", () => this.callPlayer(sessionId));
    // remotos sao mundo: a camera do HUD nao deve desenha-los
    this.uiCam?.ignore([sprite, label, ring, hand, hpBg, hpFill]);
    this.remotes.set(sessionId, {
      sprite,
      label,
      ring,
      hand,
      hpBg,
      hpFill,
      hp: typeof player.hp === "number" ? player.hp : 100,
      dmgAt: 0,
    });
  }

  private removeRemote(sessionId: string) {
    const r = this.remotes.get(sessionId);
    if (r) {
      r.sprite.destroy();
      r.label.destroy();
      r.ring.destroy();
      r.hand.destroy();
      r.hpBg.destroy();
      r.hpFill.destroy();
      this.remotes.delete(sessionId);
    }
  }

  private setupVoiceButton() {
    if (this.voiceBtn) return;
    let busy = false;
    const btn = this.add
      .text(this.scale.width - 16, 16, "🎙️ Ativar voz", {
        fontFamily: "monospace",
        fontSize: "14px",
        color: "#ffffff",
        backgroundColor: "#2a7a3a",
        padding: { x: 9, y: 6 },
      })
      .setOrigin(1, 0)
      .setScrollFactor(0)
      .setDepth(UI_DEPTH)
      .setInteractive({ useHandCursor: true });
    this.voiceBtn = btn;
    this.hudLayer?.add(btn);
    btn.on("pointerdown", async () => {
      if (busy) return;
      busy = true;
      try {
        if (!this.voice.connected) {
          btn.setText("🎙️ conectando…").setBackgroundColor("#555");
          await this.voice.connect(this.sessionId, loadSelection().name || "Convidado");
        }
        this.voiceOn = !this.voiceOn;
        await this.voice.setMicEnabled(this.voiceOn);
      } catch (e) {
        console.warn("[voz] indisponível", e);
        btn.setText("🎙️ voz indisponível").setBackgroundColor("#7a2a2a");
        busy = false;
        return;
      }
      busy = false;
      this.lastMic = this.voice.micEnabled;
      this.updateVoiceBtn();
    });
  }

  private setupShareButton() {
    if (this.shareBtn) return;
    let busy = false;
    const btn = this.add
      .text(this.scale.width - 16, 52, "🖥️ Compartilhar tela", {
        fontFamily: "monospace",
        fontSize: "14px",
        color: "#ffffff",
        backgroundColor: "#33445a",
        padding: { x: 9, y: 6 },
      })
      .setOrigin(1, 0)
      .setScrollFactor(0)
      .setDepth(UI_DEPTH)
      .setInteractive({ useHandCursor: true });
    this.shareBtn = btn;
    this.hudLayer?.add(btn);
    btn.on("pointerdown", async () => {
      if (busy) return;
      busy = true;
      try {
        if (!this.voice.connected) {
          btn.setText("🖥️ conectando…").setBackgroundColor("#555");
          await this.voice.connect(this.sessionId, loadSelection().name || "Convidado");
        }
        if (!this.voice.sharing) await this.voice.startScreenShare();
        else await this.voice.stopScreenShare();
      } catch (e) {
        console.warn("[share] erro", e);
      }
      busy = false;
      this.lastSharing = this.voice.sharing;
      this.updateShareBtn();
    });
  }

  private updateShareBtn() {
    if (!this.shareBtn) return;
    if (this.voice.sharing) {
      this.shareBtn.setText("🖥️ Compartilhando — parar").setBackgroundColor("#2a7a3a");
    } else {
      this.shareBtn.setText("🖥️ Compartilhar tela").setBackgroundColor("#33445a");
    }
  }

  private updateVoiceBtn() {
    if (!this.voiceBtn) return;
    if (!this.voiceOn) {
      this.voiceBtn.setText("🎙️ Ativar voz").setBackgroundColor("#2a7a3a");
    } else if (this.voice.micEnabled) {
      this.voiceBtn.setText("🎙️ Voz ativa — transmitindo").setBackgroundColor("#2a7a3a");
    } else {
      this.voiceBtn.setText("🔈 Voz ativa — em espera (sozinho)").setBackgroundColor("#7a6a2a");
    }
  }

  private updateMeetingBadge(inMeeting: boolean) {
    if (inMeeting && !this.meetingBadge) {
      this.meetingBadge = this.add
        .text(this.scale.width / 2, 12, "🔒 Sala de Reunião — áudio privado", {
          fontFamily: "monospace",
          fontSize: "14px",
          color: "#ffffff",
          backgroundColor: "#5a1f1fcc",
          padding: { x: 10, y: 6 },
        })
        .setOrigin(0.5, 0)
        .setScrollFactor(0)
        .setDepth(UI_DEPTH);
      this.hudLayer?.add(this.meetingBadge);
    } else if (!inMeeting && this.meetingBadge) {
      this.meetingBadge.destroy();
      this.meetingBadge = undefined;
    }
    if (this.meetingBadge) this.meetingBadge.setPosition(this.scale.width / 2, 12);
  }

  // ---------- F5: clima do escritório (agregado, sem nomes) + chamar reforço ----------

  /** Cria o badge "Clima do Escritório" (DOM) + timer de recálculo. Só com o flag on. */
  private setupClimate() {
    if (!getFlags().climate || this.climateEl) return; // desligado -> sem badge nem nuvem
    const el = document.createElement("div");
    el.style.cssText =
      "position:fixed;top:40px;left:50%;transform:translateX(-50%);z-index:9998;display:flex;" +
      "align-items:center;gap:8px;background:#15131dcc;border:1px solid #3a3550;border-radius:999px;" +
      "padding:5px 12px;font:12px system-ui,Segoe UI;color:#e8e0c8;box-shadow:0 4px 16px #0007;";
    const label = document.createElement("span");
    label.textContent = "☀️ Escritório em dia";
    const btn = document.createElement("button");
    btn.textContent = "🆘 chamar reforço";
    btn.style.cssText =
      "font:11px system-ui;cursor:pointer;border:none;border-radius:999px;background:#b9892a;" +
      "color:#15131d;padding:4px 10px;font-weight:700;";
    btn.onclick = () => this.callBackup();
    el.append(label, btn);
    document.body.appendChild(el);
    this.climateEl = el;
    this.climateLabel = label;
    this.recomputeClimate();
    this.climateTimer = setInterval(() => this.recomputeClimate(), 3000);
  }

  /** Recalcula o atraso AGREGADO (sem nomes, pro clima) e o MEU atraso (pra nuvem privada). */
  private recomputeClimate() {
    const tasks = (this.room?.state as unknown as { tasks?: { forEach(cb: (t: any) => void): void } })
      ?.tasks;
    const myName = loadSelection().name;
    let total = 0;
    let mine = 0;
    tasks?.forEach((t: any) => {
      if (t.archived) return;
      const d = daysToDue(Number(t.committedDue) || 0, String(t.due || ""), String(t.col));
      if (d !== null && d < 0) {
        total++;
        if (myName && t.assignee === myName) mine++;
      }
    });
    this.myOverdue = mine; // alimenta a nuvem privada (update())
    if (this.climateLabel) {
      this.climateLabel.textContent =
        total === 0
          ? "☀️ Escritório em dia"
          : `🌧️ ${total} ${total === 1 ? "entrega" : "entregas"} pedindo reforço`;
    }
  }

  /** Chama reforço pro time inteiro (cooperação, não culpa) — broadcast via servidor. */
  private callBackup() {
    if (!this.room) return;
    this.room.send("help:call", {});
    this.showToast("🆘 Reforço chamado pro time!", "#b9892a", 1800);
  }

  // ---------- F6: HUD do meu progresso (privado, sem ranking) ----------

  /** Cria o pill discreto do meu progresso (canto inferior-esquerdo). Só com o flag on. */
  private setupProgress() {
    if (!getFlags().progression || this.progressEl) return;
    const el = document.createElement("div");
    el.style.cssText =
      "position:fixed;left:12px;bottom:12px;z-index:9998;background:#15131dcc;border:1px solid #3a3550;" +
      "border-radius:10px;padding:7px 11px;font:12px system-ui,Segoe UI;color:#e8e0c8;" +
      "box-shadow:0 4px 16px #0007;min-width:150px;max-width:230px;";
    el.innerHTML = `<div style="opacity:.6">⭐ seu progresso aparece aqui</div>`;
    document.body.appendChild(el);
    this.progressEl = el;
  }

  /**
   * Atualiza o HUD com o progresso vindo do servidor (mensagem privada "progress:self").
   * Todos os valores são NUMÉRICOS (sem string de usuário) — innerHTML aqui é seguro.
   * O "%" é contra a PRÓPRIA média (nunca ranking), e só aparece quando há base; nunca pune.
   */
  private updateProgressHud(v: {
    level: number;
    xpInLevel: number;
    xpToNext: number;
    weekPE: number;
    baseline: number;
    pct: number;
    delivered: number;
  }) {
    this.setupProgress();
    if (!this.progressEl) return;
    const barPct = v.xpToNext > 0 ? Math.min(100, Math.round((v.xpInLevel / v.xpToNext) * 100)) : 100;
    const next = v.xpToNext > 0 ? `${v.xpInLevel}/${v.xpToNext} XP` : "nível máximo ⭐";
    const base =
      v.baseline > 0 ? `📈 ${v.pct}% da sua média` : `${v.weekPE} PE esta semana`;
    this.progressEl.innerHTML =
      `<div style="font-weight:700;margin-bottom:3px;">⭐ Nível ${v.level} ` +
      `<span style="opacity:.6;font-weight:400">· ${v.delivered} entregas</span></div>` +
      `<div style="height:6px;background:#2a2636;border-radius:99px;overflow:hidden;margin:3px 0;">` +
      `<div style="height:100%;width:${barPct}%;background:#ffd36b;"></div></div>` +
      `<div style="opacity:.85;font-size:11px;">${next} · ${base}</div>`;
  }

  private refreshRoster() {
    const state = this.room?.state as unknown as
      | { players?: { forEach(cb: (p: any, id: string) => void): void } }
      | undefined;
    const players: Array<{ id: string; name: string; hand: boolean }> = [];
    // `state.players` pode ainda nao existir logo apos entrar (1o sync nao chegou).
    if (state?.players) {
      state.players.forEach((p: any, id: string) => {
        const hand = id === this.sessionId ? this.handRaised : !!p.handRaised;
        players.push({ id, name: String(p.name), hand });
      });
    }
    // cabecalho
    const headerTxt = `👥 Online: ${players.length}  ·  clique num nome pra chamar`;
    if (!this.rosterHeader) {
      this.rosterHeader = this.add
        .text(12, 44, headerTxt, {
          fontFamily: "monospace",
          fontSize: "12px",
          color: "#e8e0c8",
          backgroundColor: "#000000aa",
          padding: { x: 8, y: 5 },
        })
        .setScrollFactor(0)
        .setDepth(UI_DEPTH);
      this.hudLayer?.add(this.rosterHeader);
    } else {
      this.rosterHeader.setText(headerTxt);
    }
    // uma linha clicavel por pessoa (clicar = chamar; ✋ = mao levantada)
    this.rosterRows.forEach((t) => t.destroy());
    this.rosterRows = [];
    let y = 70;
    for (const pl of players) {
      const me = pl.id === this.sessionId;
      const hand = pl.hand ? "✋ " : "";
      const txt = me ? `» ${hand}${pl.name} (você)` : `📣 ${hand}${pl.name}`;
      const row = this.add
        .text(14, y, txt, {
          fontFamily: "monospace",
          fontSize: "12px",
          color: me ? "#9fe6b0" : "#e8e0c8",
          backgroundColor: "#000000aa",
          padding: { x: 6, y: 3 },
        })
        .setScrollFactor(0)
        .setDepth(UI_DEPTH);
      this.hudLayer?.add(row);
      if (!me) {
        row.setInteractive({ useHandCursor: true });
        row.on("pointerover", () => row.setColor("#ffd34d"));
        row.on("pointerout", () => row.setColor("#e8e0c8"));
        row.on("pointerdown", () => {
          // com um compartilhamento de tela na frente, clicar "atras" no nome
          // chamava a pessoa sem querer (enquanto tentava maximizar). Ignora.
          if (this.voice.hasVisibleShare()) return;
          this.openPersonMenu(pl.id, pl.name);
        });
      }
      this.rosterRows.push(row);
      y += 22;
    }
  }

  private showReconnecting(on: boolean) {
    if (on && !this.reconnectBadge) {
      this.reconnectBadge = this.add
        .text(this.scale.width / 2, this.scale.height - 30, "🔌 Reconectando…", {
          fontFamily: "monospace",
          fontSize: "14px",
          color: "#ffffff",
          backgroundColor: "#7a5a1fcc",
          padding: { x: 10, y: 6 },
        })
        .setOrigin(0.5, 1)
        .setScrollFactor(0)
        .setDepth(UI_DEPTH);
      this.hudLayer?.add(this.reconnectBadge);
    } else if (!on && this.reconnectBadge) {
      this.reconnectBadge.destroy();
      this.reconnectBadge = undefined;
    }
    if (this.reconnectBadge) {
      this.reconnectBadge.setPosition(this.scale.width / 2, this.scale.height - 30);
    }
  }

  // ---------- camera de HUD + zoom ----------

  /**
   * O mundo fica na camera principal (com zoom no scroll). O HUD vai numa
   * camera propria (uiCam), que nunca aplica zoom — assim os botoes/labels
   * fixos nao incham nem encolhem. Os nomes flutuantes seguem o mundo.
   */
  private setupUiCameraAndZoom(initialHud: Phaser.GameObjects.GameObject[]) {
    const layer = this.add.layer().setDepth(UI_DEPTH);
    initialHud.forEach((o) => layer.add(o));
    this.hudLayer = layer;

    const ui = this.cameras.add(0, 0, this.scale.width, this.scale.height);
    this.uiCam = ui;
    this.cameras.main.ignore(layer); // principal nao desenha o HUD
    const layerObj = layer as unknown as Phaser.GameObjects.GameObject;
    const world = this.children.list.filter((o) => o !== layerObj);
    ui.ignore(world); // HUD nao desenha o mundo

    this.input.on(
      Phaser.Input.Events.POINTER_WHEEL,
      (_p: Phaser.Input.Pointer, _o: Phaser.GameObjects.GameObject[], _dx: number, dy: number) => {
        const cam = this.cameras.main;
        const next = dy > 0 ? cam.zoom * 0.9 : cam.zoom / 0.9;
        cam.setZoom(Phaser.Math.Clamp(next, 0.6, 2.2));
      },
    );

    this.onResizeRef = (g: Phaser.Structs.Size) => ui.setSize(g.width, g.height);
    this.scale.on(Phaser.Scale.Events.RESIZE, this.onResizeRef);
  }

  // ---------- controles de toque (joystick + fogo + pinça) ----------

  private setupTouchControls() {
    if (!this.isTouch) return;
    this.input.addPointer(2); // multitouch: joystick + 2o dedo (pinça)
    const W = this.scale.width;
    const H = this.scale.height;
    const r = this.joyR;

    this.joyBase = this.add
      .circle(22 + r, H - 22 - r, r, 0xffffff, 0.1)
      .setStrokeStyle(2, 0xffffff, 0.35)
      .setScrollFactor(0)
      .setDepth(UI_DEPTH)
      .setVisible(false);
    this.joyThumb = this.add
      .circle(22 + r, H - 22 - r, r * 0.44, 0xffd36b, 0.5)
      .setStrokeStyle(2, 0xffd36b, 0.9)
      .setScrollFactor(0)
      .setDepth(UI_DEPTH + 1)
      .setVisible(false);
    this.hudLayer?.add(this.joyBase);
    this.hudLayer?.add(this.joyThumb);

    // botão de fogo (substitui o ESPAÇO no celular)
    this.fireBtn = this.add
      .text(W - 22, H - 22, "🔥", { fontSize: "40px" })
      .setOrigin(1, 1)
      .setScrollFactor(0)
      .setDepth(UI_DEPTH + 1)
      .setInteractive({ useHandCursor: true });
    this.hudLayer?.add(this.fireBtn);
    this.fireBtn.on(
      "pointerdown",
      (_p: Phaser.Input.Pointer, _x: number, _y: number, ev?: Phaser.Types.Input.EventData) => {
        ev?.stopPropagation();
        this.castFireball();
      },
    );

    this.input.on("pointerdown", this.onTouchDown, this);
    this.input.on("pointermove", this.onTouchMove, this);
    this.input.on("pointerup", this.onTouchUp, this);
    this.input.on("pointerupoutside", this.onTouchUp, this);
  }

  private onTouchDown(p: Phaser.Input.Pointer) {
    // só ativa o joystick no canto inferior-esquerdo (longe dos botões/roster/fogo)
    if (this.joyId !== -1 || !this.joyBase) return;
    if (p.x > this.scale.width * 0.55 || p.y < this.scale.height * 0.4) return;
    this.joyId = p.id;
    this.joyBase.setPosition(p.x, p.y).setVisible(true);
    this.joyThumb?.setPosition(p.x, p.y).setVisible(true);
  }

  private onTouchMove(p: Phaser.Input.Pointer) {
    if (p.id !== this.joyId || !this.joyBase) return;
    const dx = p.x - this.joyBase.x;
    const dy = p.y - this.joyBase.y;
    const d = Math.hypot(dx, dy) || 1;
    const clamped = Math.min(d, this.joyR);
    const nx = dx / d;
    const ny = dy / d;
    this.joyThumb?.setPosition(this.joyBase.x + nx * clamped, this.joyBase.y + ny * clamped);
    this.joyVec = { x: (nx * clamped) / this.joyR, y: (ny * clamped) / this.joyR };
  }

  private onTouchUp(p: Phaser.Input.Pointer) {
    if (p.id !== this.joyId) return;
    this.joyId = -1;
    this.joyVec = { x: 0, y: 0 };
    this.joyBase?.setVisible(false);
    this.joyThumb?.setVisible(false);
  }

  /** Pinça de 2 dedos = zoom (equivalente ao scroll no desktop). */
  private handlePinch() {
    const pts = [this.input.pointer1, this.input.pointer2].filter(
      (p) => p && p.isDown && p.id !== this.joyId,
    );
    if (pts.length < 2) {
      this.pinchPrev = 0;
      return;
    }
    const dist = Phaser.Math.Distance.Between(pts[0].x, pts[0].y, pts[1].x, pts[1].y);
    if (this.pinchPrev > 0 && dist > 0) {
      const cam = this.cameras.main;
      cam.setZoom(Phaser.Math.Clamp((cam.zoom * dist) / this.pinchPrev, 0.6, 2.2));
    }
    this.pinchPrev = dist;
  }

  // ---------- selecao de microfone ----------

  private setupMicButton() {
    if (this.micBtn) return;
    const btn = this.add
      .text(this.scale.width - 16, 124, "⚙️ Microfone", {
        fontFamily: "monospace",
        fontSize: "14px",
        color: "#ffffff",
        backgroundColor: "#444",
        padding: { x: 9, y: 6 },
      })
      .setOrigin(1, 0)
      .setScrollFactor(0)
      .setDepth(UI_DEPTH)
      .setInteractive({ useHandCursor: true });
    this.micBtn = btn;
    this.hudLayer?.add(btn);
    btn.on("pointerdown", () => void this.toggleMicMenu());
  }

  private setupHandButton() {
    if (this.handBtn) return;
    const btn = this.add
      .text(this.scale.width - 16, 160, "✋ Levantar a mão", {
        fontFamily: "monospace",
        fontSize: "14px",
        color: "#ffffff",
        backgroundColor: "#4a4a6a",
        padding: { x: 9, y: 6 },
      })
      .setOrigin(1, 0)
      .setScrollFactor(0)
      .setDepth(UI_DEPTH)
      .setInteractive({ useHandCursor: true });
    this.handBtn = btn;
    this.hudLayer?.add(btn);
    btn.on("pointerdown", () => this.toggleHand());
  }

  /** Alterna "mao levantada" e avisa o servidor (todos veem). */
  private toggleHand() {
    this.handRaised = !this.handRaised;
    this.room?.send("hand", { raised: this.handRaised });
    this.updateHandBtn();
  }

  private updateHandBtn() {
    if (!this.handBtn) return;
    if (this.handRaised) {
      this.handBtn.setText("✋ Baixar a mão").setBackgroundColor("#2a7a3a");
    } else {
      this.handBtn.setText("✋ Levantar a mão").setBackgroundColor("#4a4a6a");
    }
  }

  private async toggleMicMenu() {
    if (this.micMenu) {
      this.micMenu.remove();
      this.micMenu = undefined;
      return;
    }
    const mics = await this.voice.listMics();
    if (this.micMenu) return; // corrida: outro clique ja abriu
    const menu = document.createElement("div");
    menu.style.cssText =
      "position:fixed;top:124px;right:16px;z-index:9999;background:#15131d;" +
      "border:2px solid #5a4a2a;border-radius:10px;padding:8px;min-width:240px;" +
      "max-width:80vw;font:13px monospace;color:#f0e6c8;box-shadow:0 6px 24px #000c;";
    const title = document.createElement("div");
    title.textContent = "🎙️ Escolha o microfone";
    title.style.cssText = "margin-bottom:6px;color:#9fe6b0;";
    menu.appendChild(title);
    const current = this.voice.getMicDeviceId();
    if (!mics.length) {
      const empty = document.createElement("div");
      empty.textContent = "Ative a voz para liberar a lista de microfones.";
      empty.style.cssText = "opacity:.7;padding:4px;";
      menu.appendChild(empty);
    }
    for (const m of mics) {
      const sel = m.deviceId === current || (!current && m.deviceId === "default");
      const row = document.createElement("div");
      row.textContent = (sel ? "● " : "○ ") + m.label;
      row.style.cssText =
        "padding:6px 8px;border-radius:6px;cursor:pointer;white-space:nowrap;" +
        "overflow:hidden;text-overflow:ellipsis;" +
        (sel ? "background:#2a7a3a;" : "");
      row.onmouseenter = () => {
        if (!sel) row.style.background = "#2a2636";
      };
      row.onmouseleave = () => {
        if (!sel) row.style.background = "";
      };
      row.onclick = () => {
        void this.voice.setMicDevice(m.deviceId);
        this.micMenu?.remove();
        this.micMenu = undefined;
        const short = m.label.length > 16 ? m.label.slice(0, 16) + "…" : m.label;
        this.micBtn?.setText("⚙️ " + short);
      };
      menu.appendChild(row);
    }
    document.body.appendChild(menu);
    this.micMenu = menu;
  }

  // ---------- chamar alguem ----------

  private callPlayer(sid: string) {
    if (!this.room || sid === this.sessionId) return;
    this.room.send("call", { to: sid });
    this.showToast("📣 Chamando…", "#33445a", 1400);
  }

  private personMenu?: HTMLDivElement;
  private personMenuClose?: () => void;

  /** Menu ao clicar num nome do roster: Chamar (avisa) ou Ir até (me teleporto). */
  private openPersonMenu(sid: string, name: string) {
    if (!this.room || sid === this.sessionId) return;
    this.personMenuClose?.(); // fecha o anterior DE VERDADE (tira o listener tambem)
    const box = document.createElement("div");
    box.style.cssText =
      "position:fixed;left:16px;top:118px;z-index:10000;background:#15131d;" +
      "border:2px solid #caa44a;border-radius:12px;padding:10px 12px;min-width:190px;" +
      "font:13px monospace;color:#f0e6c8;box-shadow:0 8px 30px #000d;";
    const title = document.createElement("div");
    title.textContent = name;
    title.style.cssText =
      "font-weight:bold;margin-bottom:8px;max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    const close = () => {
      box.remove();
      if (this.personMenu === box) this.personMenu = undefined;
      this.personMenuClose = undefined;
      document.removeEventListener("pointerdown", onOutside, true);
    };
    const mkBtn = (label: string, bg: string, fn: () => void) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText =
        "display:block;width:100%;text-align:left;font:13px monospace;cursor:pointer;" +
        `background:${bg};color:#fff;border:none;border-radius:8px;padding:8px 10px;margin-bottom:6px;`;
      b.onclick = () => {
        fn();
        close();
      };
      return b;
    };
    const call = mkBtn("📣 Chamar", "#33445a", () => this.callPlayer(sid));
    const go = mkBtn("🏃 Ir até ele", "#2a7a3a", () => this.goToPlayer(sid));
    const cancel = mkBtn("✕ Cancelar", "#3a3340", () => {});
    box.append(title, call, go, cancel);
    document.body.appendChild(box);
    this.personMenu = box;
    this.personMenuClose = close;
    const onOutside = (e: PointerEvent) => {
      if (!box.contains(e.target as Node)) close();
    };
    setTimeout(() => document.addEventListener("pointerdown", onOutside, true), 0);
  }

  /** Teleporta o meu personagem pra perto do alvo (troca de andar se necessario). */
  private goToPlayer(sid: string) {
    const state = this.room?.state as unknown as
      | { players?: { get(id: string): { x: number; y: number } | undefined } }
      | undefined;
    const tp = state?.players?.get(sid);
    if (!tp) return;
    const f = floorOfY(tp.y);
    if (f !== this.currentFloor) {
      this.currentFloor = f;
      this.applyFloor(f);
    }
    this.teleportNear(tp.x, tp.y);
  }

  private onCalled(m: { name: string; x: number; y: number }) {
    this.playBeep();
    this.callToast?.remove();
    const box = document.createElement("div");
    box.style.cssText =
      "position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:10000;" +
      "background:#15131d;border:2px solid #caa44a;border-radius:12px;padding:12px 16px;" +
      "font:14px monospace;color:#f0e6c8;box-shadow:0 8px 30px #000d;text-align:center;";
    const msg = document.createElement("div");
    msg.textContent = `📣 ${m.name} está te chamando!`;
    msg.style.cssText = "margin-bottom:10px;";
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:8px;justify-content:center;";
    const go = document.createElement("button");
    go.textContent = "🏃 Ir até";
    go.style.cssText =
      "font:14px monospace;cursor:pointer;background:#2a7a3a;color:#fff;border:none;" +
      "border-radius:8px;padding:7px 14px;";
    const dismiss = document.createElement("button");
    dismiss.textContent = "Dispensar";
    dismiss.style.cssText =
      "font:14px monospace;cursor:pointer;background:#3a3340;color:#ddd;border:none;" +
      "border-radius:8px;padding:7px 14px;";
    const close = () => {
      box.remove();
      if (this.callToast === box) this.callToast = undefined;
    };
    go.onclick = () => {
      this.teleportNear(m.x, m.y);
      close();
    };
    dismiss.onclick = close;
    actions.append(go, dismiss);
    box.append(msg, actions);
    document.body.appendChild(box);
    this.callToast = box;
    this.time.delayedCall(20000, close);
  }

  private teleportNear(x: number, y: number) {
    const margin = T;
    const tx = Phaser.Math.Clamp(x + 44, margin, COLS * T - margin);
    const ty = Phaser.Math.Clamp(y, margin, ROWS * T - margin);
    this.player.setPosition(tx, ty);
    this.nameLabel.setPosition(tx, ty - 30);
    this.cameras.main.centerOn(tx, ty);
    this.room?.send("move", {
      x: Math.round(tx),
      y: Math.round(ty),
      dir: this.lastDir,
      moving: false,
    });
  }

  private showToast(text: string, bg: string, ms: number) {
    const t = document.createElement("div");
    t.textContent = text;
    t.style.cssText =
      "position:fixed;left:50%;bottom:84px;transform:translateX(-50%);z-index:9999;" +
      `background:${bg};color:#fff;font:14px monospace;padding:8px 14px;border-radius:8px;` +
      "box-shadow:0 6px 24px #000a;pointer-events:none;";
    document.body.appendChild(t);
    this.time.delayedCall(ms, () => t.remove());
  }

  /**
   * F3 — feedback PRIVADO da IA sobre a minha entrega. Banner no topo, acima do kanban
   * (z-index alto), cor por status, sumindo em ~10s ou ao clicar. Só EU recebo (vergonha
   * privada): nota baixa/parcial nunca aparece pra ninguém além do responsável.
   */
  private showAiFeedback(status: string, score: number, note: string) {
    const meta: Record<string, { bg: string; icon: string; head: string }> = {
      verified: { bg: "#15803d", icon: "✅", head: "IA aprovou sua entrega" },
      partial: { bg: "#b45309", icon: "🛠️", head: "Quase lá — a IA achou que falta um pouco" },
      low: { bg: "#9f5fb0", icon: "✋", head: "A IA achou que falta bastante (só você vê isto)" },
      unavailable: { bg: "#475569", icon: "📤", head: "Entregue! Avaliação da IA indisponível agora" },
    };
    const m = meta[status] ?? meta.unavailable;
    const scoreStr = score >= 0 ? ` (${score}/10)` : "";
    const body =
      status === "unavailable"
        ? "Sua entrega ficou registrada. Peça uma verificação manual a alguém do time."
        : note || "(sem comentário)";
    const el = document.createElement("div");
    el.style.cssText =
      "position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:10080;max-width:min(440px,92vw);" +
      `background:${m.bg};color:#fff;font:13px/1.45 system-ui,Segoe UI;padding:12px 16px;border-radius:10px;` +
      "box-shadow:0 8px 30px #000b;cursor:pointer;";
    const h = document.createElement("div");
    h.style.cssText = "font-weight:700;margin-bottom:3px;";
    h.textContent = `${m.icon} ${m.head}${scoreStr}`;
    const p = document.createElement("div");
    p.textContent = body;
    const tip = document.createElement("div");
    tip.style.cssText = "font-size:11px;opacity:.75;margin-top:5px;";
    tip.textContent = "clique para fechar";
    el.append(h, p, tip);
    el.onclick = () => el.remove();
    document.body.appendChild(el);
    this.time.delayedCall(10000, () => el.remove());
  }

  private playBeep() {
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      const t0 = ctx.currentTime;
      osc.frequency.setValueAtTime(880, t0);
      osc.frequency.setValueAtTime(660, t0 + 0.12);
      gain.gain.setValueAtTime(0.001, t0);
      gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.4);
      osc.start(t0);
      osc.stop(t0 + 0.42);
      osc.onended = () => void ctx.close();
    } catch {
      /* sem audio disponivel */
    }
  }

  /** Beep curto e suave (grave) — usado quando alguem perto levanta a mao. */
  private playHandBeep() {
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      const t0 = ctx.currentTime;
      osc.frequency.setValueAtTime(523, t0); // do5 — discreto, tipo Meet/Gather
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.1, t0 + 0.02); // baixo
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
      osc.start(t0);
      osc.stop(t0 + 0.32);
      osc.onended = () => void ctx.close();
    } catch {
      /* sem audio disponivel */
    }
  }

  // ---------- bola de fogo (espaco) ----------

  private castFireball() {
    if (this.dead) return;
    const now = this.time.now;
    if (now - this.lastFire < 500) return; // cooldown
    this.lastFire = now;
    // "pulo": esticada rapida do boneco
    this.tweens.add({
      targets: this.player,
      scaleY: 1.22,
      scaleX: 0.9,
      duration: 110,
      yoyo: true,
      ease: "Quad.out",
    });
    const x = this.player.x;
    const y = this.player.y;
    const dir = this.lastDir;
    this.spawnFireball(x, y, dir, true); // fromMe: a minha bola detecta o acerto e reporta o dano
    this.room?.send("fireball", { x: Math.round(x), y: Math.round(y), dir });
  }

  /** Orbe de fogo que voa 5 quadrados na direcao encarada e explode (no 1o alvo, se fromMe). */
  private spawnFireball(x: number, y: number, dir: number, fromMe = false) {
    const dx = dir === 2 ? -1 : dir === 3 ? 1 : 0;
    const dy = dir === 0 ? 1 : dir === 1 ? -1 : 0;
    const dist = 5 * T;
    const D = 9600; // acima de tudo no mundo (inclusive da escuridao da cripta)
    const glow = this.add
      .ellipse(x, y, 34, 34, 0xff6a2a, 0.5)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(D - 1);
    const orb = this.add.ellipse(x, y, 18, 18, 0xff8a2e).setStrokeStyle(2, 0xffd27a).setDepth(D);
    const core = this.add.ellipse(x, y, 9, 9, 0xfff3a0).setDepth(D + 1);
    const trail = this.add
      .particles(x, y, "flameDot", {
        speed: 0,
        scale: { start: 0.5, end: 0 },
        alpha: { start: 0.8, end: 0 },
        lifespan: 280,
        frequency: 18,
        tint: [0xfff3a0, 0xffb24d, 0xff6a2a],
        blendMode: "ADD",
      })
      .setDepth(D - 2);
    this.uiCam?.ignore([glow, orb, core, trail]);
    const tx = x + dx * dist;
    const ty = y + dy * dist;
    let done = false;
    const finish = (ex: number, ey: number) => {
      if (done) return;
      done = true;
      tween.stop();
      trail.stop();
      glow.destroy();
      orb.destroy();
      core.destroy();
      this.time.delayedCall(320, () => trail.destroy());
      this.explodeAt(ex, ey);
    };
    const tween = this.tweens.add({
      targets: [glow, orb, core, trail],
      x: tx,
      y: ty,
      duration: 360,
      ease: "Linear",
      onUpdate: () => {
        if (!fromMe || done) return;
        // quem lancou detecta o acerto (so nos remotos do MESMO andar, que estao visiveis)
        for (const [sid, r] of this.remotes) {
          if (!r.sprite.visible) continue;
          if (Math.hypot(orb.x - r.sprite.x, orb.y - r.sprite.y) < 24) {
            this.room?.send("hit", { target: sid });
            finish(orb.x, orb.y);
            return;
          }
        }
      },
      onComplete: () => finish(tx, ty),
    });
  }

  private explodeAt(x: number, y: number) {
    const D = 9600;
    const ring = this.add.ellipse(x, y, 14, 14, 0x000000, 0).setStrokeStyle(4, 0xffb24d).setDepth(D);
    this.uiCam?.ignore(ring);
    this.tweens.add({
      targets: ring,
      scaleX: 6,
      scaleY: 6,
      alpha: { from: 0.9, to: 0 },
      duration: 380,
      ease: "Quad.out",
      onComplete: () => ring.destroy(),
    });
    const burst = this.add
      .particles(x, y, "flameDot", {
        speed: { min: 60, max: 190 },
        angle: { min: 0, max: 360 },
        scale: { start: 0.7, end: 0 },
        alpha: { start: 1, end: 0 },
        lifespan: { min: 280, max: 560 },
        tint: [0xfff3a0, 0xffb24d, 0xff6a2a],
        blendMode: "ADD",
        emitting: false,
      })
      .setDepth(D + 1);
    this.uiCam?.ignore(burst);
    burst.explode(26);
    this.time.delayedCall(650, () => burst.destroy());
  }

  // ---------- HP / dano / morte ----------

  private updateHpBar(
    bg: Phaser.GameObjects.Rectangle,
    fill: Phaser.GameObjects.Rectangle,
    x: number,
    y: number,
    hp: number,
    dmgAt: number,
    now: number,
    baseVis: boolean,
  ) {
    const show = baseVis && dmgAt > 0 && now - dmgAt < 60000; // some 1min apos o ultimo dano
    bg.setVisible(show);
    fill.setVisible(show);
    if (!show) return;
    bg.setPosition(x, y);
    fill.setPosition(x - 15, y).setScale(Math.max(0, hp) / 100, 1);
    fill.setFillStyle(hp > 50 ? 0x3aff6a : hp > 20 ? 0xffcc3a : 0xff4a4a);
  }

  private onDied() {
    if (this.dead) return;
    this.dead = true;
    this.voice.disconnect();
    try {
      this.room?.leave();
    } catch {
      /* ignore */
    }
    this.room = undefined;
    this.kanban?.close(); // fecha o board (se aberto) — libera o teclado/overlay
    const ov = document.createElement("div");
    ov.style.cssText =
      "position:fixed;inset:0;z-index:10001;display:flex;flex-direction:column;" +
      "align-items:center;justify-content:center;gap:18px;background:#0a0008ee;" +
      "color:#fff;font-family:monospace;text-align:center;padding:20px;";
    const t = document.createElement("div");
    t.style.cssText = "font-size:44px;";
    t.textContent = "💀 Você morreu!";
    const sub = document.createElement("div");
    sub.style.cssText = "font-size:15px;opacity:.85;";
    sub.textContent = "Uma bola de fogo te derrubou. Volte com a vida cheia.";
    const btn = document.createElement("button");
    btn.textContent = "↻ Voltar ao escritório";
    btn.style.cssText =
      "font:16px monospace;cursor:pointer;background:#2a7a3a;color:#fff;border:none;" +
      "border-radius:10px;padding:12px 22px;";
    btn.onclick = () => location.reload();
    ov.append(t, sub, btn);
    document.body.appendChild(ov);
    this.deathOverlay = ov;
  }

  // ---------- decoracao helpers ----------

  private addDesk(d: Rect) {
    const x = d.c * T + (d.w * T) / 2;
    const y = d.r * T + (d.h * T) / 2;
    const w = d.w * T - 6;
    const h = d.h * T - 6;
    const base = this.add.rectangle(x, y, w, h, 0x5a3a1e).setStrokeStyle(2, 0x281709).setDepth(y);
    this.add.rectangle(x, y - 2, w - 8, h - 12, 0x7a5230).setDepth(y);
    this.physics.add.existing(base, true);
    this.obstacles.push(base);
  }

  private addChair(d: Rect) {
    const x = d.c * T + (d.w * T) / 2;
    const y = d.r * T + d.h * T + 12;
    this.add.rectangle(x, y, 16, 14, 0x4a3018).setStrokeStyle(1, 0x281709).setDepth(y);
    this.add.rectangle(x, y + 6, 16, 4, 0x33220f).setDepth(y);
  }

  private addRoundTable(x: number, y: number, w: number, h: number) {
    const tbl = this.add.ellipse(x, y, w, h, 0x5a3a1e).setStrokeStyle(2, 0x281709).setDepth(y);
    this.add.ellipse(x, y - 2, w - 14, h - 14, 0x7a5230).setDepth(y);
    this.physics.add.existing(tbl, true);
    (tbl.body as Phaser.Physics.Arcade.StaticBody).setSize(w * 0.85, h * 0.85);
    this.obstacles.push(tbl);
  }

  private addProp(c: number, r: number, key: string) {
    const x = c * T + T / 2;
    const y = r * T + T / 2;
    const img = this.add.image(x, y, key).setDepth(y);
    this.physics.add.existing(img, true);
    (img.body as Phaser.Physics.Arcade.StaticBody).setSize(T * 0.7, T * 0.6);
    this.obstacles.push(img);
  }

  private addBarrel(c: number, r: number) {
    const x = c * T + T / 2;
    const y = r * T + T / 2;
    const e = this.add.ellipse(x, y, 22, 22, 0x6b4a2a).setStrokeStyle(2, 0x3a2614).setDepth(y);
    this.add.ellipse(x, y, 15, 15).setStrokeStyle(1, 0x3a2614, 0.7).setDepth(y);
    this.add.ellipse(x, y, 8, 8, 0x553a1f).setDepth(y);
    this.physics.add.existing(e, true);
    (e.body as Phaser.Physics.Arcade.StaticBody).setSize(20, 20);
    this.obstacles.push(e);
  }

  private addChest(c: number, r: number) {
    const x = c * T + T / 2;
    const y = r * T + T / 2;
    this.add.rectangle(x, y + 3, 24, 14, 0x5a3a1e).setStrokeStyle(2, 0x281709).setDepth(y);
    this.add.rectangle(x, y - 5, 24, 9, 0x6b4a2a).setStrokeStyle(2, 0x281709).setDepth(y);
    this.add.rectangle(x, y, 24, 4, 0xcaa44a).setDepth(y);
    this.add.rectangle(x, y, 6, 6, 0xcaa44a).setStrokeStyle(1, 0x6b4a2a).setDepth(y);
    const hb = this.add.rectangle(x, y, 22, 18).setVisible(false);
    this.physics.add.existing(hb, true);
    this.obstacles.push(hb);
  }

  private addBrazier(c: number, r: number, pal: Flame = FLAME_ORANGE) {
    const x = c * T + T / 2;
    const y = r * T + T / 2;
    this.add.rectangle(x, y + 9, 8, 8, 0x2e2620).setDepth(y);
    this.add.ellipse(x, y, 22, 12, 0x55555f).setStrokeStyle(2, 0x33333a).setDepth(y);
    const hb = this.add.rectangle(x, y, 16, 12).setVisible(false);
    this.physics.add.existing(hb, true);
    this.obstacles.push(hb);
    const glow = this.add
      .image(x, y - 2, "flameDot")
      .setScale(3)
      .setTint(pal.glow)
      .setAlpha(0.35)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(y + 1);
    this.tweens.add({
      targets: glow,
      alpha: { from: 0.25, to: 0.45 },
      scale: { from: 2.8, to: 3.4 },
      duration: 700,
      yoyo: true,
      repeat: -1,
      ease: "Sine.inOut",
    });
    this.add
      .particles(x, y - 4, "flameDot", {
        speedY: { min: -50, max: -26 },
        speedX: { min: -7, max: 7 },
        scale: { start: 0.5, end: 0 },
        alpha: { start: 0.9, end: 0 },
        lifespan: { min: 350, max: 600 },
        frequency: 40,
        quantity: 1,
        tint: pal.tints,
        blendMode: "ADD",
      })
      .setDepth(y + 2);
  }

  private addRug(cx: number, cy: number, w: number, h: number, fill: number) {
    this.add.rectangle(cx, cy, w, h, fill, 0.92).setStrokeStyle(3, 0x9a7b2a).setDepth(0.4);
    this.add.rectangle(cx, cy, w - 12, h - 12).setStrokeStyle(1, 0x9a7b2a, 0.55).setDepth(0.4);
    this.add
      .rectangle(cx, cy, Math.min(w, h) * 0.32, Math.min(w, h) * 0.32, 0x9a7b2a, 0.22)
      .setAngle(45)
      .setDepth(0.4);
  }

  private addBanner(c: number, color: number, oy = 0) {
    const x = c * T + T / 2;
    const yTop = oy * T + T * 0.85;
    const h = 34;
    this.add.rectangle(x, yTop + h / 2, 18, h, color).setStrokeStyle(1, 0x000000, 0.3).setDepth(2);
    this.add.rectangle(x, yTop + h / 2, 4, h, 0xcaa44a).setDepth(2);
    this.add.triangle(x, yTop + h, -9, 0, 9, 0, 0, 10, color).setDepth(2);
    this.add.rectangle(x, yTop + 12, 7, 7, 0xe8d8a0).setAngle(45).setDepth(2);
  }

  private addWallDecor([c, r, key]: Decor) {
    let x = c * T + T / 2;
    let y = r * T + T / 2;
    if (r === 0 || r === DIV1) y += T * 0.5 + 2; // pendurado virado pra dentro do andar
    else if (r === ROWS - 1 || r === DIV2) y -= T * 0.5 + 2;
    if (c === 0) x += T * 0.5 + 2;
    else if (c === COLS - 1) x -= T * 0.5 + 2;
    this.add.image(x, y, key).setDepth(2).setScale(0.95);
  }

  private addTorch(c: number, r: number, pal: Flame = FLAME_ORANGE) {
    let x = c * T + T / 2;
    let y = r * T + T / 2;
    if (r === 0 || r === DIV1) y += T * 0.6;
    else if (r === ROWS - 1 || r === DIV2) y -= T * 0.6;
    if (c === 0) x += T * 0.6;
    else if (c === COLS - 1) x -= T * 0.6;

    this.add.rectangle(x, y + 9, 4, 13, 0x3a2a1a).setDepth(2);
    const glow = this.add
      .image(x, y, "flameDot")
      .setScale(2.6)
      .setTint(pal.glow)
      .setAlpha(0.3)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(2);
    this.tweens.add({
      targets: glow,
      alpha: { from: 0.22, to: 0.38 },
      scale: { from: 2.4, to: 3.0 },
      duration: 700,
      yoyo: true,
      repeat: -1,
      ease: "Sine.inOut",
    });
    this.add
      .particles(x, y - 4, "flameDot", {
        speedY: { min: -42, max: -20 },
        speedX: { min: -6, max: 6 },
        scale: { start: 0.38, end: 0 },
        alpha: { start: 0.85, end: 0 },
        lifespan: { min: 300, max: 520 },
        frequency: 55,
        quantity: 1,
        tint: pal.tints,
        blendMode: "ADD",
      })
      .setDepth(3);
  }

  private addRoomLabel(text: string, x: number, y: number) {
    this.add
      .text(x, y, text, {
        fontFamily: "monospace",
        fontSize: "12px",
        color: "#e8d8a0",
        backgroundColor: "#00000066",
        padding: { x: 4, y: 2 },
      })
      .setOrigin(0.5)
      .setDepth(0.6);
  }

  private makeFlameTexture() {
    if (this.textures.exists("flameDot")) return;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    for (let i = 8; i > 0; i--) {
      g.fillStyle(0xffffff, (i / 8) * 0.18);
      g.fillCircle(16, 16, i * 2);
    }
    g.generateTexture("flameDot", 32, 32);
    g.destroy();
  }

  /** Textura radial branca (centro solido -> borda transparente) usada como "luz". */
  private makeLightTexture(key: string, size: number) {
    if (this.textures.exists(key)) return;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    const R = size / 2;
    const steps = 16;
    for (let i = steps; i >= 1; i--) {
      g.fillStyle(0xffffff, 0.11);
      g.fillCircle(R, R, (i / steps) * R);
    }
    g.fillStyle(0xffffff, 1);
    g.fillCircle(R, R, R * 0.5); // nucleo solido revela bem o centro
    g.generateTexture(key, size, size);
    g.destroy();
  }

  // ---------- andar: escritorio (deslocado por oy) ----------

  private buildOfficeDecor(oy: number) {
    const o = oy * T;
    this.addRug(4.7 * T, 3.4 * T + o, 7.2 * T, 5 * T, 0x5a1f1f);
    this.addRug(15.5 * T, 18.4 * T + o, 5 * T, 3 * T, 0x1f2f5a);

    const desks: Rect[] = [
      { c: 13, r: oy + 4, w: 3, h: 1 },
      { c: 18, r: oy + 4, w: 3, h: 1 },
      { c: 13, r: oy + 9, w: 3, h: 1 },
      { c: 18, r: oy + 9, w: 3, h: 1 },
      { c: 23, r: oy + 6, w: 2, h: 1 },
      { c: 22, r: oy + 13, w: 3, h: 1 },
      { c: 13, r: oy + 14, w: 3, h: 1 },
      { c: 13, r: oy + 18, w: 3, h: 1 },
    ];
    for (const d of desks) {
      this.addChair(d);
      this.addDesk(d);
    }
    this.addRoundTable(4.7 * T, 3.4 * T + o, 3.4 * T, 2.2 * T);

    const decor: Decor[] = [
      [12, oy, "w_long_sword1"],
      [14, oy, "s_kite_shield1"],
      [16, oy, "w_battle_axe1"],
      [18, oy, "s_tower_shield1"],
      [20, oy, "w_war_axe1"],
      [22, oy, "s_buckler1"],
      [24, oy, "w_morningstar1"],
      [0, oy + 11, "w_broad_axe1"],
      [0, oy + 15, "s_kite_shield1"],
      [COLS - 1, oy + 9, "w_mace1"],
      [COLS - 1, oy + 13, "s_tower_shield1"],
      [2, oy + 7, "s_buckler1"],
      [6, oy + 7, "w_scimitar1"],
    ];
    for (const d of decor) this.addWallDecor(d);

    this.addBanner(8, 0x7a1f2a, oy);
    this.addBanner(11, 0x1f3a7a, oy);
    this.addBanner(28, 0x2a5a2a, oy);

    this.addProp(11, oy + 11, "column");
    this.addProp(11, oy + 16, "column2");
    this.addProp(26, oy + 6, "column");
    this.addProp(26, oy + 16, "column2");
    this.addProp(2, oy + 8, "statue_sword");
    this.addProp(6, oy + 8, "statue_axe");
    this.addProp(4, oy + 16, "statue_dragon");
    this.addProp(27, oy + 3, "statue_angel");
    this.addProp(18, oy + 18, "fountain");

    this.addBarrel(26, oy + 18);
    this.addBarrel(27, oy + 18);
    this.addBarrel(26, oy + 19);
    this.addChest(24, oy + 19);

    this.addBrazier(12, oy + 20);
    this.addBrazier(18, oy + 20);
    for (const c of [5, 21, 26]) this.addTorch(c, oy);
    this.addTorch(0, oy + 5);
    this.addTorch(0, oy + 16);
    this.addTorch(COLS - 1, oy + 5);
    this.addTorch(COLS - 1, oy + 16);
    this.addTorch(9, oy + 3);
    this.addTorch(9, oy + 6);

    this.addRoomLabel("Sala de Reunião", 4.7 * T, (5.5 + oy) * T);
    this.addRoomLabel("Área de Trabalho", 18.5 * T, (11 + oy) * T);
    this.addStaircase(16, oy + 2, true, "▲ Praia", 16, 13); // sobe pra praia
    this.addStaircase(16, oy + 17, false, "▼ Cripta", 16, 42); // desce pra cripta
  }

  // ---------- andar: praia ensolarada (topo) ----------

  private buildBeach() {
    const oceanTop = 1 * T;
    const oceanH = 3.5 * T;
    // agua DCSS animada (profunda no topo, rasa na orla; frames alternam)
    const deepH = 2 * T;
    const deep = this.add.tileSprite(0, oceanTop, W, deepH, "water_deep").setOrigin(0).setDepth(0.3);
    const shallow = this.add
      .tileSprite(0, oceanTop + deepH, W, oceanH - deepH, "water_shallow")
      .setOrigin(0)
      .setDepth(0.3);
    let wf = 0;
    this.time.addEvent({
      delay: 520,
      loop: true,
      callback: () => {
        wf ^= 1;
        deep.setTexture(wf ? "water_deep2" : "water_deep");
        shallow.setTexture(wf ? "water_shallow2" : "water_shallow");
      },
    });
    // reflexo do sol na agua
    this.add
      .ellipse(W - 4 * T, oceanTop + oceanH * 0.55, 6.5 * T, oceanH * 0.8, 0xffffff, 0.14)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(0.32);
    // cintilancia do sol na agua
    this.add
      .particles(0, 0, "flameDot", {
        x: { min: 0, max: W },
        y: { min: oceanTop + 6, max: oceanTop + oceanH - 8 },
        scale: { start: 0.2, end: 0 },
        alpha: { start: 0.9, end: 0 },
        lifespan: 1100,
        frequency: 90,
        quantity: 1,
        tint: 0xffffff,
        blendMode: "ADD",
      })
      .setDepth(0.34);
    // espuma da orla
    this.add.rectangle(0, oceanTop + oceanH, W, 7, 0xffffff, 0.6).setOrigin(0).setDepth(0.35);
    // colisao: nao entra no mar
    const sea = this.add.rectangle(W / 2, oceanTop + oceanH / 2, W, oceanH, 0x000000, 0).setDepth(0);
    this.physics.add.existing(sea, true);
    this.obstacles.push(sea);

    this.addSun(W - 4 * T, 2.6 * T);

    // variacao na areia (manchas de outros tiles)
    const sandVar = ["sand2", "sand3", "sand4"];
    for (let i = 0; i < 18; i++) {
      const c = 1 + Math.floor(Math.random() * (COLS - 2));
      const rr = 5 + Math.floor(Math.random() * (OY - 6));
      this.add.image(c * T + T / 2, rr * T + T / 2, sandVar[i % 3]).setDepth(0.05);
    }

    const palms: Array<[number, number]> = [
      [3, 7],
      [7, 9],
      [12, 11],
      [20, 12],
      [24, 8],
      [26, 13],
      [5, 14],
    ];
    for (const [c, r] of palms) this.addPalm(c, r);

    this.addUmbrella(10, 13, 0xe23b3b);
    this.addUmbrella(18, 10, 0x2a8ae2);
    this.addBeachTowel(14, 14, 0xffd23b);

    const stars: Array<[number, number]> = [
      [15, 16],
      [9, 12],
      [22, 15],
      [6, 11],
    ];
    for (const [c, r] of stars) this.addStarfish(c, r);

    // glints de sol flutuando pela areia (vida/movimento)
    this.add
      .particles(0, 0, "flameDot", {
        x: { min: T, max: W - T },
        y: { min: oceanTop + oceanH, max: OY * T - T / 2 },
        speedY: { min: -12, max: -4 },
        speedX: { min: -5, max: 5 },
        scale: { start: 0.13, end: 0 },
        alpha: { start: 0.75, end: 0 },
        lifespan: 2400,
        frequency: 200,
        quantity: 1,
        tint: [0xfff6c8, 0xffffff],
        blendMode: "ADD",
      })
      .setDepth(0.9);
    // luz quente do dia (gradiente: mais forte no topo, perto do sol)
    for (let i = 0; i < 4; i++) {
      this.add
        .rectangle(0, (i * OY * T) / 4, W, (OY * T) / 4 + 1, 0xfff2c0, 0.08 - i * 0.017)
        .setOrigin(0)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(0.95);
    }

    this.addRoomLabel("☀️ Praia ensolarada", 15 * T, 8 * T);
    this.addStaircase(16, 14, false, "▼ Escritório", 16, 20); // desce pro escritorio
  }

  private addSun(x: number, y: number) {
    const halo = this.add
      .ellipse(x, y, 230, 230, 0xffe27a, 0.22)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(0.5);
    this.add
      .ellipse(x, y, 130, 130, 0xffe9a0, 0.5)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(0.5);
    for (let i = 0; i < 6; i++) {
      this.add
        .rectangle(x, y, 7, 270, 0xffe9a0, 0.4)
        .setAngle(i * 30)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(0.45);
    }
    this.add.ellipse(x, y, 76, 76, 0xfff4c2).setDepth(0.6);
    this.tweens.add({
      targets: halo,
      scale: { from: 0.9, to: 1.12 },
      alpha: { from: 0.16, to: 0.3 },
      duration: 2400,
      yoyo: true,
      repeat: -1,
      ease: "Sine.inOut",
    });
  }

  private addPalm(c: number, r: number) {
    const x = c * T + T / 2;
    const base = r * T + T / 2 + 8;
    for (let i = 0; i < 5; i++) {
      this.add
        .rectangle(x + i * 2, base - i * 9, 8 - i * 0.5, 11, 0x9a6a3a)
        .setStrokeStyle(1, 0x5a3a1e)
        .setDepth(base);
    }
    const topx = x + 10;
    const topy = base - 46;
    const frondCols = [0x2e8b3a, 0x37a847, 0x227a30];
    const angs = [-150, -110, -70, -30, 20, 60];
    for (let i = 0; i < angs.length; i++) {
      const a = (angs[i] * Math.PI) / 180;
      const frond = this.add
        .ellipse(topx + Math.cos(a) * 18, topy + Math.sin(a) * 18, 42, 13, frondCols[i % 3])
        .setAngle(angs[i])
        .setDepth(base + 1);
      this.tweens.add({
        targets: frond,
        angle: { from: angs[i] - 3, to: angs[i] + 3 },
        duration: 1800 + i * 120,
        yoyo: true,
        repeat: -1,
        ease: "Sine.inOut",
      });
    }
    this.add.ellipse(topx - 4, topy + 5, 9, 9, 0x6b4a2a).setStrokeStyle(1, 0x3a2614).setDepth(base + 2);
    this.add.ellipse(topx + 6, topy + 6, 9, 9, 0x6b4a2a).setStrokeStyle(1, 0x3a2614).setDepth(base + 2);
    this.add.ellipse(x + 4, base + 8, 36, 11, 0x000000, 0.14).setDepth(base - 1);
  }

  private addUmbrella(c: number, r: number, color: number) {
    const x = c * T + T / 2;
    const y = r * T + T / 2;
    const R = 26;
    const oct = (rr: number): Array<[number, number]> => {
      const pts: Array<[number, number]> = [];
      for (let i = 0; i < 8; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 4;
        pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr]);
      }
      return pts;
    };
    this.add.ellipse(x, y + 5, 2 * R, R * 0.85, 0x000000, 0.12).setDepth(y - 1); // sombra
    const g = this.add.graphics().setDepth(y);
    const rings = 5;
    for (let k = rings; k >= 1; k--) {
      g.fillStyle(k % 2 ? color : 0xffffff, 1); // aneis concentricos cor/branco
      g.beginPath();
      const pts = oct((R * k) / rings);
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.closePath();
      g.fillPath();
    }
    g.lineStyle(1, 0x000000, 0.15); // gomos
    for (let i = 0; i < 8; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 4;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(a) * R, y + Math.sin(a) * R);
      g.strokePath();
    }
    this.add.ellipse(x, y, 5, 5, 0x8a7a5a).setDepth(y + 0.1); // ponta central
  }

  private addBeachTowel(c: number, r: number, color: number) {
    const x = c * T + T / 2;
    const y = r * T + T / 2;
    this.add.rectangle(x, y, 2 * T, 1.3 * T, color, 0.95).setStrokeStyle(2, 0xffffff, 0.7).setDepth(0.4);
    this.add.rectangle(x, y, 2 * T - 10, 1.3 * T - 10).setStrokeStyle(1, 0xffffff, 0.45).setDepth(0.4);
  }

  private addStarfish(c: number, r: number) {
    const x = c * T + T / 2;
    const y = r * T + T / 2;
    const col = 0xe8843b;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
      this.add
        .ellipse(x + Math.cos(a) * 7, y + Math.sin(a) * 7, 6, 13, col)
        .setAngle((a * 180) / Math.PI + 90)
        .setStrokeStyle(1, 0x9a4a1e)
        .setDepth(y);
    }
    this.add.ellipse(x, y, 9, 9, col).setStrokeStyle(1, 0x9a4a1e).setDepth(y);
  }

  // ---------- andar: cripta amaldicoada (baixo) ----------

  private buildCrypt() {
    const cy = CRYPT_Y0;
    const top = cy * T;
    const ch = (ROWS - cy) * T;
    // bruma + brilhos amaldicoados
    this.add.rectangle(0, top, W, ch, 0x05040a, 0.4).setOrigin(0).setDepth(0.2);
    for (const [gx, gy, gc] of [
      [6, 4, 0x1f8a4a],
      [23, 7, 0x5a2a8a],
      [14, 13, 0x2a5a8a],
    ] as Array<[number, number, number]>) {
      this.add
        .ellipse(gx * T, top + gy * T, 200, 140, gc, 0.14)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(0.25);
    }
    // pentagramas (marcacoes de ritual no chao)
    this.addPentagram(9 * T, top + 7 * T, 46);
    this.addPentagram(23 * T, top + 12 * T, 40);
    // ritual: altar do deus da morte + dragao esqueletico (centro)
    this.addMon("altar_death", 9, cy + 7, 1.7);
    this.addMon("m_bone_dragon", 15, cy + 9, 2.6);
    // liches, esqueletos, mumia e carrasco
    this.addMon("m_lich", 7, cy + 6, 1.4);
    this.addMon("m_ancient_lich", 11, cy + 6, 1.4);
    this.addMon("m_skeletal_warrior", 21, cy + 12, 1.4);
    this.addMon("m_mummy", 25, cy + 12, 1.4);
    this.addMon("m_skeletal_warrior", 12, cy + 15, 1.3);
    this.addMon("m_executioner", 27, cy + 15, 1.5);
    // ceifador
    this.addMon("m_reaper", 24, cy + 5, 1.8);
    // caveiras flutuantes
    this.addMon("m_curse_skull", 5, cy + 11, 1.2, true);
    this.addMon("m_laughing_skull", 27, cy + 4, 1.2, true);
    this.addMon("m_curse_skull", 18, cy + 3, 1.1, true);
    // fantasmas que pairam
    this.addMon("m_wraith", 8, cy + 4, 1.4, true);
    this.addMon("m_phantom", 22, cy + 10, 1.4, true);
    this.addMon("m_eidolon", 14, cy + 4, 1.4, true);
    // lapides + ossos
    this.addTombstone(4, cy + 5);
    this.addTombstone(28, cy + 9);
    this.addTombstone(8, cy + 16);
    this.addBonePile(20, cy + 13);
    this.addBonePile(11, cy + 9);
    // tochas + braseiros verdes (fontes de luz)
    this.addTorch(0, cy + 4, FLAME_GREEN);
    this.addTorch(COLS - 1, cy + 4, FLAME_GREEN);
    this.addTorch(0, cy + 12, FLAME_GREEN);
    this.addTorch(COLS - 1, cy + 12, FLAME_GREEN);
    this.addBrazier(11, ROWS - 3, FLAME_GREEN);
    this.addBrazier(19, ROWS - 3, FLAME_GREEN);

    this.addRoomLabel("💀 Cripta Amaldiçoada", 7 * T, (cy + 2) * T);
    this.addStaircase(16, cy + 2, true, "▲ Escritório", 16, 32);

    // luzes (tochas/braseiros) que o sistema de escuridao revela
    const lt = (c: number, r: number) => {
      const x =
        c === 0
          ? T * 0.5 + T * 0.6
          : c === COLS - 1
            ? (COLS - 1) * T + T / 2 - T * 0.6
            : c * T + T / 2;
      this.cryptLights.push({ x, y: r * T + T / 2 });
    };
    lt(0, cy + 4);
    lt(COLS - 1, cy + 4);
    lt(0, cy + 12);
    lt(COLS - 1, cy + 12);
    this.cryptLights.push({ x: 11 * T + T / 2, y: (ROWS - 3) * T + T / 2 });
    this.cryptLights.push({ x: 19 * T + T / 2, y: (ROWS - 3) * T + T / 2 });
    this.darkRT = this.add.renderTexture(0, 0, W, H).setOrigin(0).setDepth(9500);
  }

  /** Coloca um sprite DCSS (monstro/altar) num tile, com leve flutuacao opcional. */
  private addMon(key: string, c: number, r: number, scale: number, float = false) {
    const x = c * T + T / 2;
    const y = r * T + T / 2;
    const s = this.add.image(x, y, key).setScale(scale).setDepth(y + 8);
    if (float) {
      this.tweens.add({
        targets: s,
        y: { from: y - 5, to: y + 5 },
        duration: 1500 + ((c * 7) % 5) * 160,
        yoyo: true,
        repeat: -1,
        ease: "Sine.inOut",
      });
    }
  }

  private addTombstone(c: number, r: number) {
    const x = c * T + T / 2;
    const y = r * T + T / 2;
    const d = y;
    this.add.ellipse(x, y - 8, 28, 26, 0x565160).setDepth(d);
    this.add.rectangle(x, y, 28, 26, 0x565160).setStrokeStyle(2, 0x2c2836).setDepth(d);
    this.add.rectangle(x, y - 2, 16, 3, 0x2c2836).setDepth(d + 0.1);
    this.add.rectangle(x, y + 4, 11, 3, 0x2c2836).setDepth(d + 0.1);
    const hb = this.add.rectangle(x, y, 26, 22).setVisible(false);
    this.physics.add.existing(hb, true);
    this.obstacles.push(hb);
  }

  private addBonePile(c: number, r: number) {
    const x = c * T + T / 2;
    const y = r * T + T / 2;
    const d = y;
    const bone = 0xcfc8b4;
    const dk = 0x8a8470;
    for (const [dx, dy, ang] of [
      [-6, 2, 30],
      [5, -2, -20],
      [0, 5, 80],
      [-2, -4, 150],
    ] as Array<[number, number, number]>) {
      const rad = (ang * Math.PI) / 180;
      this.add.rectangle(x + dx, y + dy, 3, 18, bone).setStrokeStyle(1, dk).setAngle(ang).setDepth(d);
      this.add.ellipse(x + dx + Math.cos(rad) * 8, y + dy + Math.sin(rad) * 8, 5, 5, bone).setDepth(d);
      this.add.ellipse(x + dx - Math.cos(rad) * 8, y + dy - Math.sin(rad) * 8, 5, 5, bone).setDepth(d);
    }
  }

  private addPentagram(x: number, y: number, R: number) {
    this.add
      .ellipse(x, y, R * 3, R * 3, 0x8a1f3a, 0.12)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(0.45);
    const g = this.add.graphics().setDepth(0.5);
    g.lineStyle(2, 0xb02a44, 0.9);
    g.strokeCircle(x, y, R);
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
      pts.push([x + Math.cos(a) * R, y + Math.sin(a) * R]);
    }
    const order = [0, 2, 4, 1, 3, 0];
    g.beginPath();
    g.moveTo(pts[order[0]][0], pts[order[0]][1]);
    for (let i = 1; i < order.length; i++) g.lineTo(pts[order[i]][0], pts[order[i]][1]);
    g.strokePath();
  }

  // ---------- andares: camadas, camera e escadas ----------

  /** Executa fn e marca tudo que ela criar como pertencente ao andar f. */
  private buildFloorInto(f: number, fn: () => void) {
    const before = this.children.list.length;
    fn();
    for (const o of this.children.list.slice(before)) this.floorObjs[f].push(o);
  }

  /** Copia visual de uma divisoria pra ela aparecer tambem do andar vizinho. */
  private addDividerCopy(solid: boolean[][], row: number, floor: number, tint: number) {
    for (let c = 0; c < COLS; c++) {
      if (!solid[row][c]) continue;
      const key = (row * 7 + c) % 4 === 0 ? "wall2" : "wall";
      const img = this.add.image(c * T + T / 2, row * T + T / 2, key).setTint(tint).setDepth(1);
      this.floorObjs[floor].push(img);
    }
  }

  /** Mostra so o andar f (esconde os outros) e ajusta a cor de fundo da camera. */
  private applyFloor(f: number) {
    for (let i = 0; i < this.floorObjs.length; i++) {
      const vis = i === f;
      for (const o of this.floorObjs[i]) {
        (o as unknown as { setVisible(v: boolean): void }).setVisible(vis);
      }
    }
    const cam = this.cameras.main;
    cam.removeBounds(); // sem travar nos limites: o player fica sempre centralizado
    if (f === 0) cam.setBackgroundColor("#2f7fae");
    else if (f === 1) cam.setBackgroundColor("#07060d");
    else cam.setBackgroundColor("#050409");
  }

  /**
   * Regra UNICA de "esse player remoto me alcanca" (a mesma do audio de proximidade):
   * frescor da posicao + mesmo andar + (mesma sala de reuniao OU, fora de sala,
   * dentro de VOICE_MAX). Centraliza num so lugar pra audio/tela/stream-do-board/beep
   * nunca divergirem — divergencia aqui ja causou vazamento de voz no passado.
   */
  private canReach(
    sid: string,
    sp: { x: number; y: number },
    self: { x: number; y: number },
    myZone: number,
    requireFresh = true,
  ): boolean {
    // posicao stale (aba congelada / caiu) = nao confio — trava de frescor nas vias
    // de ENTRADA (tela/stream/beep). NAO no auto-mute (saida): travar o proprio mic
    // por frescor cortaria minha voz se a MINHA conexao engasgasse (todos ficam stale
    // de uma vez). O vazamento de saida ja e barrado no ganho do ouvinte.
    if (requireFresh && performance.now() - (this.lastPosAt.get(sid) ?? 0) > VOICE_STALE_MS) return false;
    if (floorOfY(sp.y) !== this.currentFloor) return false;
    const sz = zoneAt(sp.x, sp.y);
    return myZone >= 0 ? sz === myZone : sz < 0 && Math.hypot(sp.x - self.x, sp.y - self.y) < VOICE_MAX;
  }

  private useStair(tx: number, ty: number) {
    this.player.setPosition(tx, ty);
    (this.player.body as Phaser.Physics.Arcade.Body).reset(tx, ty);
    this.floorCdUntil = this.time.now + 600;
    const f = floorOfY(ty);
    this.currentFloor = f;
    this.applyFloor(f);
    this.cameras.main.centerOn(tx, ty);
    this.nameLabel.setPosition(tx, ty - 30);
    this.room?.send("move", {
      x: Math.round(tx),
      y: Math.round(ty),
      dir: this.lastDir,
      moving: false,
    });
  }

  private checkStairs() {
    if (!this.stairs.length) return;
    const px = this.player.x;
    const py = this.player.y;
    const now = this.time.now;
    let on = false;
    for (const s of this.stairs) {
      if (px >= s.x1 && px <= s.x2 && py >= s.y1 && py <= s.y2) {
        on = true;
        if (!this.stairLatch && now > this.floorCdUntil) {
          this.stairLatch = true;
          this.useStair(s.tx, s.ty);
        }
        break;
      }
    }
    if (!on) this.stairLatch = false;
  }

  /** Desenha uma escada e registra a zona que leva ao andar vizinho. */
  private addStaircase(col: number, row: number, up: boolean, label: string, tcol: number, trow: number) {
    const x = col * T + T / 2;
    const y = row * T + T / 2;
    this.add.image(x, y, up ? "stairs_up" : "stairs_down").setScale(1.5).setDepth(y);
    this.add
      .text(x, y + 26, label, {
        fontFamily: "monospace",
        fontSize: "10px",
        color: "#fff7d8",
        backgroundColor: "#000000aa",
        padding: { x: 4, y: 1 },
      })
      .setOrigin(0.5)
      .setDepth(9700); // placa sempre visivel (acima da escuridao da cripta)
    this.stairs.push({
      x1: (col - 1) * T,
      y1: row * T - 4,
      x2: (col + 2) * T,
      y2: (row + 1) * T + 4,
      tx: tcol * T + T / 2,
      ty: trow * T + T / 2,
    });
  }

  /**
   * Recalcula o volume por proximidade de cada faixa de voz. Roda no loop (1o
   * plano) E num timer enquanto a aba esta oculta. As posicoes continuam
   * chegando pelo WebSocket mesmo com a aba em 2o plano (so o requestAnimationFrame
   * congela), entao da pra atenuar quem se afasta (sem vazar) e manter quem esta
   * perto audivel — sem precisar mutar tudo.
   */
  private recomputeVoiceProximity() {
    if (!this.voice.connected) return;
    const state = this.room?.state as unknown as { players?: { get(id: string): any } } | undefined;
    if (!this.room || !state?.players) {
      // sem estado confiavel (reconectando / antes do 1o sync): silencio total em vez
      // de deixar os ultimos volumes tocando — fail-safe de privacidade.
      this.voice.applyGains(() => 0);
      return;
    }
    const self = { x: this.player.x, y: this.player.y };
    const myZone = zoneAt(self.x, self.y);
    const now = performance.now();
    this.voice.applyGains((id) => {
      const p = state.players?.get(id);
      if (!p) return 0;
      // FAIL-SAFE de privacidade: se a posicao parou de atualizar (a pessoa
      // congelou a aba / caiu / lag), NAO confio nela -> silencio. Sem isso, uma
      // posicao stale (perto/na-sala) ficava com volume alto mesmo com a pessoa
      // longe = vazamento esporadico de voz.
      if (now - (this.lastPosAt.get(id) ?? 0) > VOICE_STALE_MS) return 0;
      if (floorOfY(p.y) !== this.currentFloor) return 0;
      const tz = zoneAt(p.x, p.y);
      if (myZone >= 0 || tz >= 0) return myZone >= 0 && myZone === tz ? 1 : 0;
      const d = Math.hypot(p.x - self.x, p.y - self.y);
      const t = Math.max(0, Math.min(1, (VOICE_MAX - d) / (VOICE_MAX - VOICE_FULL)));
      return t * t;
    });
  }

  update() {
    const body = this.player.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(0);

    // com o gestor de tarefas aberto, o teclado e do board (nao move o boneco)
    const uiOpen = this.kanban?.isOpen() ?? false;
    const jx = uiOpen ? 0 : this.joyVec.x;
    const jy = uiOpen ? 0 : this.joyVec.y;
    const J = 0.28; // zona morta do joystick
    const left = !uiOpen && (this.cursors.left.isDown || this.keys.A.isDown || jx < -J);
    const right = !uiOpen && (this.cursors.right.isDown || this.keys.D.isDown || jx > J);
    const up = !uiOpen && (this.cursors.up.isDown || this.keys.W.isDown || jy < -J);
    const down = !uiOpen && (this.cursors.down.isDown || this.keys.S.isDown || jy > J);

    // com o board aberto, libera o teclado pros inputs do DOM (Phaser captura
    // SPACE/WASD/setas com preventDefault, o que impediria de digitar).
    const kbd = this.input.keyboard;
    if (kbd && kbd.enabled === uiOpen) {
      kbd.enabled = !uiOpen;
      if (uiOpen) kbd.disableGlobalCapture();
      else kbd.enableGlobalCapture();
    }

    if (left) body.setVelocityX(-SPEED);
    else if (right) body.setVelocityX(SPEED);
    if (up) body.setVelocityY(-SPEED);
    else if (down) body.setVelocityY(SPEED);
    body.velocity.normalize().scale(SPEED);

    const moving = left || right || up || down;
    let dir = this.lastDir;
    if (left) dir = 2;
    else if (right) dir = 3;
    else if (up) dir = 1;
    else if (down) dir = 0;
    this.lastDir = dir;

    const i = this.charIndex;
    if (moving) this.player.anims.play(`c${i}_${DIR_NAME[dir]}`, true);
    else {
      this.player.anims.stop();
      this.player.setFrame(IDLE_FRAME[dir]);
    }
    this.player.setDepth(this.player.y);
    this.nameLabel.setPosition(this.player.x, this.player.y - 30);
    // F5 — nuvem privada do atraso segue o avatar (visível só pra mim, só com o flag on)
    if (this.localCloud) {
      this.localCloud.setPosition(this.player.x + 22, this.player.y - 52).setDepth(this.player.y + 1);
      this.localCloud.setVisible(getFlags().climate && this.myOverdue > 0);
    }

    // troca de andar (deduzida pelo Y) + gatilho das escadas
    const fNow = floorOfY(this.player.y);
    if (fNow !== this.currentFloor) {
      this.currentFloor = fNow;
      this.applyFloor(fNow);
    }
    this.checkStairs();

    // anel de "falando"
    const speaking = this.voice.connected ? this.voice.speakingIds() : null;
    if (this.localRing) {
      this.localRing
        .setPosition(this.player.x, this.player.y + 16)
        .setDepth(this.player.y - 1)
        .setVisible(!!speaking && speaking.has(this.sessionId));
    }

    // levantar a mao (tecla H) + ✋ acima do proprio personagem
    if (this.handKey && Phaser.Input.Keyboard.JustDown(this.handKey)) this.toggleHand();
    this.localHand?.setPosition(this.player.x, this.player.y - 48).setVisible(this.handRaised);

    // bola de fogo (espaco)
    if (this.fireKey && Phaser.Input.Keyboard.JustDown(this.fireKey)) this.castFireball();

    // minha barra de HP (so aparece quando levo dano)
    if (this.myHpBg && this.myHpFill) {
      this.updateHpBar(
        this.myHpBg,
        this.myHpFill,
        this.player.x,
        this.player.y - 44,
        this.myHp,
        this.myDmgAt,
        this.time.now,
        true,
      );
    }

    // envia minha posicao (throttle ~80ms)
    const now = this.time.now;
    if (this.room && now - this.lastSent > 80) {
      this.lastSent = now;
      this.room.send("move", {
        x: Math.round(this.player.x),
        y: Math.round(this.player.y),
        dir,
        moving,
      });
    }

    // atualiza remotos (interpolacao)
    if (this.room) {
      // ATENCAO: logo apos entrar/reconectar, `this.room` ja existe mas
      // `state.players` ainda pode ser undefined por alguns frames ate o 1o sync
      // chegar (a janela e ~0 em localhost, mas varios frames com latencia de
      // rede). Por isso TODO acesso a `state.players` usa `?.` — sem isso, um
      // `state.players.get(...)` lancava a cada frame e CONGELAVA o jogo (parecia
      // "nao da pra andar" pra quem estava online de verdade).
      const state = this.room.state as unknown as { players?: { get(id: string): any } };
      // meu HP (detecta dano pra mostrar a barra)
      const meState = state.players?.get(this.sessionId);
      if (meState && typeof meState.hp === "number") {
        if (meState.hp < this.myHp) this.myDmgAt = this.time.now;
        this.myHp = meState.hp;
      }
      this.remotes.forEach((r, sid) => {
        const p = state.players?.get(sid);
        if (!p) return;
        const vis = floorOfY(p.y) === this.currentFloor; // so vejo quem esta no meu andar
        r.sprite.x += (p.x - r.sprite.x) * 0.25;
        r.sprite.y += (p.y - r.sprite.y) * 0.25;
        r.sprite.setDepth(r.sprite.y).setVisible(vis);
        const dn = DIR_NAME[p.dir] ?? "down";
        if (p.moving) r.sprite.anims.play(`c${p.charId}_${dn}`, true);
        else {
          r.sprite.anims.stop();
          r.sprite.setFrame(IDLE_FRAME[p.dir] ?? FRAME.downIdle);
        }
        r.label.setPosition(r.sprite.x, r.sprite.y - 30).setVisible(vis);
        r.ring
          .setPosition(r.sprite.x, r.sprite.y + 16)
          .setDepth(r.sprite.y - 1)
          .setVisible(vis && !!speaking && speaking.has(sid));
        r.hand.setPosition(r.sprite.x, r.sprite.y - 60).setVisible(vis && !!p.handRaised);
        // HP do remoto (detecta dano + desenha a barra)
        if (typeof p.hp === "number") {
          if (p.hp < r.hp) r.dmgAt = this.time.now;
          r.hp = p.hp;
        }
        this.updateHpBar(r.hpBg, r.hpFill, r.sprite.x, r.sprite.y - 44, r.hp, r.dmgAt, this.time.now, vis);
      });

      // se alguem levantou/baixou a mao, atualiza o roster (sem refazer a cada frame)
      let handsSig = this.handRaised ? "me," : "";
      this.remotes.forEach((_r, sid) => {
        const p = state.players?.get(sid);
        if (p?.handRaised) handsSig += sid + ",";
      });
      if (handsSig !== this.lastHandsSig) {
        this.lastHandsSig = handsSig;
        this.refreshRoster();
      }

      // zona de reuniao + voz (proximidade ou bolha da sala)
      const self = { x: this.player.x, y: this.player.y };
      const myZone = zoneAt(self.x, self.y);
      this.updateMeetingBadge(myZone >= 0);

      // beep baixo quando alguem PERTO (mesma distancia do audio) levanta a mao
      this.remotes.forEach((_r, sid) => {
        const sp = state.players?.get(sid);
        if (!sp) return;
        const raised = !!sp.handRaised;
        const was = this.prevHand.get(sid);
        this.prevHand.set(sid, raised);
        if (was === undefined || !raised || was) return; // 1a vez vista, ou nao e subida
        if (this.canReach(sid, sp, self, myZone)) this.playHandBeep();
      });

      // "stream" do gestor: se alguem perto esta streamando, auto-abre o board;
      // ao se afastar, fecha (a menos que eu tenha aberto na mao).
      let nearBoardStream = false;
      this.remotes.forEach((_r, sid) => {
        if (nearBoardStream) return;
        const sp = state.players?.get(sid);
        if (!sp || !sp.streamingBoard) return;
        if (this.canReach(sid, sp, self, myZone)) nearBoardStream = true;
      });
      if (this.kanban) {
        if (nearBoardStream) {
          if (!this.kanban.isOpen()) this.kanban.open(true); // open() respeita o "dispensar"
        } else {
          this.kanban.clearStreamDismiss(); // saiu de perto: pode reabrir no futuro
          if (this.kanban.isStreamOpened()) this.kanban.close(false);
        }
      }

      if (this.voice.connected) {
        this.recomputeVoiceProximity();
        // tela compartilhada: mesma logica do audio de proximidade —
        // dentro de uma sala de reuniao so vejo telas da MESMA sala; fora dela,
        // vejo a tela de quem estiver perto (mesma distancia do audio: VOICE_MAX).
        this.voice.applyShareVisibility((id) => {
          const sp = state.players?.get(id);
          return !!sp && this.canReach(id, sp, self, myZone);
        });

        // auto-mute por privacidade: so transmite se alguem pode te ouvir
        let audible = false;
        this.remotes.forEach((_r, sid) => {
          if (audible) return;
          const sp = state.players?.get(sid);
          // saida (meu mic): SEM trava de frescor — ver canReach. Um engasgo na minha
          // conexao nao pode me silenciar pra quem esta do meu lado.
          if (sp && this.canReach(sid, sp, self, myZone, false)) audible = true;
        });
        // enquanto eu apresento o board (stream), mantenho o mic ligado mesmo que o
        // auto-mute nao detecte alguem "alcancavel" — quem esta longe ainda e barrado
        // no ganho do ouvinte. Sem isso, clicar em "stream" no gestor me mutava.
        const streamingBoard = this.kanban?.isStreaming() ?? false;
        const wantMic = this.voiceOn && (audible || streamingBoard);
        if (wantMic !== this.voice.micEnabled) void this.voice.setMicEnabled(wantMic);
        if (this.voice.micEnabled !== this.lastMic) {
          this.lastMic = this.voice.micEnabled;
          this.updateVoiceBtn();
        }
      }
    } else if (this.voice.connected) {
      // Sem estado do jogo (reconectando ao Colyseus): NAO congelar os volumes.
      // Silencia todo mundo ate o jogo voltar — senao a voz de quem estava perto
      // "vaza" pelo ambiente inteiro durante o blip de reconexao (bug intermitente).
      this.voice.applyGains(() => 0);
    }

    if (this.voiceBtn) this.voiceBtn.setPosition(this.scale.width - 16, 16);
    if (this.shareBtn) this.shareBtn.setPosition(this.scale.width - 16, 52);
    if (this.gestorBtn) this.gestorBtn.setPosition(this.scale.width - 16, 88);
    if (this.micBtn) this.micBtn.setPosition(this.scale.width - 16, 124);
    if (this.handBtn) this.handBtn.setPosition(this.scale.width - 16, 160);
    if (this.fireBtn) this.fireBtn.setPosition(this.scale.width - 22, this.scale.height - 22);
    if (this.isTouch) this.handlePinch();
    if (this.voice.sharing !== this.lastSharing) {
      this.lastSharing = this.voice.sharing;
      this.updateShareBtn();
    }
    if (this.room && this.reconnectBadge) this.showReconnecting(false);

    // escuridao da cripta: quase tudo preto, revelando so ao redor das luzes
    if (this.currentFloor === 2 && this.darkRT) {
      const rt = this.darkRT;
      rt.clear();
      rt.fill(0x020109, 0.96);
      rt.erase("lightBig", this.player.x - 150, this.player.y - 150);
      for (const L of this.cryptLights) rt.erase("lightSmall", L.x - 95, L.y - 95);
      this.remotes.forEach((r, sid) => {
        const p = (this.room?.state as unknown as { players?: { get(id: string): any } } | undefined)
          ?.players?.get(sid);
        if (p && floorOfY(p.y) === 2) rt.erase("lightSmall", r.sprite.x - 95, r.sprite.y - 95);
      });
    }
  }
}
