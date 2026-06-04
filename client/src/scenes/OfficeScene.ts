import Phaser from "phaser";
import { charKey, ensureCharAnims, FRAME, loadSelection } from "../characters";
import { joinOffice, getStateCallbacks } from "../net/room";
import type { Room } from "../net/room";
import { VoiceManager } from "../net/voice";

const T = 32;
const COLS = 30;
const ROWS = 22;
const SPEED = 170;
const UI_DEPTH = 10000;

// dir: 0=baixo, 1=cima, 2=esquerda, 3=direita
const DIR_NAME = ["down", "up", "left", "right"] as const;
const IDLE_FRAME = [FRAME.downIdle, FRAME.upIdle, FRAME.leftIdle, FRAME.rightIdle];

// voz: raios de proximidade (px) — queda quadratica (cai rapido com a distancia)
const VOICE_FULL = 40; // dentro disso: volume cheio (~1 tile)
const VOICE_MAX = 160; // alem disso: silencio (~5 tiles)

// zonas de reuniao (px) — dentro de uma zona, so quem esta na MESMA zona se ouve.
const MEETING_ZONES = [{ x1: 1 * T, y1: 1 * T, x2: 9 * T, y2: 7 * T }];
function zoneAt(x: number, y: number): number {
  for (let i = 0; i < MEETING_ZONES.length; i++) {
    const z = MEETING_ZONES[i];
    if (x >= z.x1 && x <= z.x2 && y >= z.y1 && y <= z.y2) return i;
  }
  return -1;
}

type Rect = { c: number; r: number; w: number; h: number };
type Decor = [col: number, row: number, key: string];
type Remote = {
  sprite: Phaser.GameObjects.Sprite;
  label: Phaser.GameObjects.Text;
  ring: Phaser.GameObjects.Ellipse;
};

export class OfficeScene extends Phaser.Scene {
  private player!: Phaser.Physics.Arcade.Sprite;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keys!: Record<"W" | "A" | "S" | "D", Phaser.Input.Keyboard.Key>;
  private obstacles: Phaser.GameObjects.GameObject[] = [];
  private charIndex = 0;
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
  private lastSharing = false;
  private voiceOn = false;
  private lastMic = false;
  private sessionId = "";
  private meetingBadge?: Phaser.GameObjects.Text;
  private roster?: Phaser.GameObjects.Text;
  private localRing?: Phaser.GameObjects.Ellipse;
  private reconnectBadge?: Phaser.GameObjects.Text;
  private leaving = false;
  private reconnecting = false;

  constructor() {
    super("office");
  }

  create() {
    const W = COLS * T;
    const H = ROWS * T;
    const sel = loadSelection();
    this.charIndex = sel.index;
    this.remotes.clear();
    this.room = undefined;
    this.obstacles = [];
    this.leaving = false;
    this.reconnecting = false;
    this.voiceBtn = undefined;
    this.shareBtn = undefined;
    this.lastSharing = false;
    this.voiceOn = false;
    this.lastMic = false;
    this.roster = undefined;
    this.localRing = undefined;
    this.meetingBadge = undefined;
    this.reconnectBadge = undefined;

    // ---- paredes ----
    const solid: boolean[][] = Array.from({ length: ROWS }, () =>
      Array<boolean>(COLS).fill(false),
    );
    const set = (c: number, r: number, v = true) => {
      if (r >= 0 && r < ROWS && c >= 0 && c < COLS) solid[r][c] = v;
    };
    for (let c = 0; c < COLS; c++) {
      set(c, 0);
      set(c, ROWS - 1);
    }
    for (let r = 0; r < ROWS; r++) {
      set(0, r);
      set(COLS - 1, r);
    }
    for (let r = 1; r <= 7; r++) set(9, r);
    for (let c = 1; c <= 9; c++) set(c, 7);
    set(4, 7, false);
    const entranceCol = 15;
    set(entranceCol, ROWS - 1, false);

    // ---- chao + tapetes ----
    this.add.tileSprite(0, 0, W, H, "floor").setOrigin(0).setDepth(0);
    this.cameras.main.setBackgroundColor("#0d0b14");
    this.addRug(4.7 * T, 3.4 * T, 7.2 * T, 5 * T, 0x5a1f1f);
    this.addRug(15.5 * T, 18.4 * T, 5 * T, 3 * T, 0x1f2f5a);

    // ---- paredes ----
    const walls = this.physics.add.staticGroup();
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (!solid[r][c]) continue;
        const key = (r * 7 + c) % 4 === 0 ? "wall2" : "wall";
        const w = walls.create(c * T + T / 2, r * T + T / 2, key) as Phaser.Physics.Arcade.Sprite;
        w.setDepth(1);
      }
    }

    // ---- portas ----
    this.add.image(4 * T + T / 2, 7 * T + T / 2, "door_open").setDepth(1);
    this.add.image(entranceCol * T + T / 2, (ROWS - 1) * T + T / 2, "door_open").setDepth(1);

    // ---- mesas + cadeiras ----
    const desks: Rect[] = [
      { c: 13, r: 4, w: 3, h: 1 },
      { c: 18, r: 4, w: 3, h: 1 },
      { c: 13, r: 9, w: 3, h: 1 },
      { c: 18, r: 9, w: 3, h: 1 },
      { c: 23, r: 6, w: 2, h: 1 },
      { c: 22, r: 13, w: 3, h: 1 },
      { c: 13, r: 14, w: 3, h: 1 },
      { c: 13, r: 18, w: 3, h: 1 },
    ];
    for (const d of desks) {
      this.addChair(d);
      this.addDesk(d);
    }
    this.addRoundTable(4.7 * T, 3.4 * T, 3.4 * T, 2.2 * T);

    // ---- decoracao de parede ----
    const decor: Decor[] = [
      [12, 0, "w_long_sword1"],
      [14, 0, "s_kite_shield1"],
      [16, 0, "w_battle_axe1"],
      [18, 0, "s_tower_shield1"],
      [20, 0, "w_war_axe1"],
      [22, 0, "s_buckler1"],
      [24, 0, "w_morningstar1"],
      [0, 11, "w_broad_axe1"],
      [0, 15, "s_kite_shield1"],
      [COLS - 1, 9, "w_mace1"],
      [COLS - 1, 13, "s_tower_shield1"],
      [2, 7, "s_buckler1"],
      [6, 7, "w_scimitar1"],
    ];
    for (const d of decor) this.addWallDecor(d);

    this.addBanner(8, 0x7a1f2a);
    this.addBanner(11, 0x1f3a7a);
    this.addBanner(28, 0x2a5a2a);

    // ---- colunas / estatuas / fonte ----
    this.addProp(11, 11, "column");
    this.addProp(11, 16, "column2");
    this.addProp(26, 6, "column");
    this.addProp(26, 16, "column2");
    this.addProp(2, 8, "statue_sword");
    this.addProp(6, 8, "statue_axe");
    this.addProp(4, 16, "statue_dragon");
    this.addProp(27, 3, "statue_angel");
    this.addProp(18, 18, "fountain");

    // ---- barris + bau ----
    this.addBarrel(26, 18);
    this.addBarrel(27, 18);
    this.addBarrel(26, 19);
    this.addChest(24, 19);

    // ---- braseiros + tochas ----
    this.makeFlameTexture();
    this.addBrazier(12, 20);
    this.addBrazier(18, 20);
    const torches: Array<[number, number]> = [
      [5, 0],
      [21, 0],
      [26, 0],
      [0, 5],
      [0, 18],
      [COLS - 1, 5],
      [COLS - 1, 18],
      [9, 3],
      [9, 6],
    ];
    for (const [c, r] of torches) this.addTorch(c, r);

    // ---- player ----
    ensureCharAnims(this, this.charIndex);
    const spawnX = entranceCol * T + T / 2;
    const spawnY = (ROWS - 4) * T + T / 2;
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

    // ---- camera + input + HUD ----
    const cam = this.cameras.main;
    cam.startFollow(this.player);
    cam.setBounds(0, 0, W, H);
    this.physics.world.setBounds(0, 0, W, H);

    const kb = this.input.keyboard!;
    this.cursors = kb.createCursorKeys();
    this.keys = {
      W: kb.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      A: kb.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      S: kb.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      D: kb.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };

    this.add
      .text(12, 12, "WASD / setas — andar", {
        fontFamily: "monospace",
        fontSize: "14px",
        color: "#ffffff",
        backgroundColor: "#000000aa",
        padding: { x: 8, y: 5 },
      })
      .setScrollFactor(0)
      .setDepth(UI_DEPTH);

    this.addRoomLabel("Sala de Reunião", 4.7 * T, 5.5 * T);
    this.addRoomLabel("Recepção", entranceCol * T, (ROWS - 2.2) * T);
    this.addRoomLabel("Área de Trabalho", 18.5 * T, 11 * T);

    // ---- multiplayer ----
    void this.connectMultiplayer(sel.name || "Convidado", spawnX, spawnY);
  }

  // ---------- multiplayer ----------

  private async connectMultiplayer(name: string, x: number, y: number) {
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.leaving = true;
      this.voice.disconnect();
      try {
        this.room?.leave();
      } catch {
        /* ignore */
      }
    });
    try {
      const room = await joinOffice({ name, charId: this.charIndex, x, y });
      this.setupVoiceButton();
      this.setupShareButton();
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
    const $ = getStateCallbacks(room) as (obj: unknown) => any;
    $(room.state).players.onAdd((player: any, sid: string) => {
      if (sid !== room.sessionId) this.addRemote(sid, player);
      this.refreshRoster();
    });
    $(room.state).players.onRemove((_p: any, sid: string) => {
      this.removeRemote(sid);
      this.refreshRoster();
    });
    room.onLeave(() => {
      if (this.leaving || this.room !== room) return;
      this.handleDisconnect(name, x, y);
    });
    this.refreshRoster();
    this.showReconnecting(false);
  }

  private handleDisconnect(name: string, x: number, y: number) {
    this.room = undefined;
    this.remotes.forEach((r) => {
      r.sprite.destroy();
      r.label.destroy();
      r.ring.destroy();
    });
    this.remotes.clear();
    this.refreshRoster();
    this.showReconnecting(true);
    this.scheduleReconnect(name, x, y);
  }

  private scheduleReconnect(name: string, x: number, y: number) {
    if (this.leaving || this.room || this.reconnecting) return;
    this.reconnecting = true;
    this.time.delayedCall(3000, async () => {
      this.reconnecting = false;
      if (this.leaving || this.room) return;
      try {
        const room = await joinOffice({ name, charId: this.charIndex, x, y });
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
    this.remotes.set(sessionId, { sprite, label, ring });
  }

  private removeRemote(sessionId: string) {
    const r = this.remotes.get(sessionId);
    if (r) {
      r.sprite.destroy();
      r.label.destroy();
      r.ring.destroy();
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
    } else if (!inMeeting && this.meetingBadge) {
      this.meetingBadge.destroy();
      this.meetingBadge = undefined;
    }
    if (this.meetingBadge) this.meetingBadge.setPosition(this.scale.width / 2, 12);
  }

  private refreshRoster() {
    const state = this.room?.state as unknown as
      | { players: { forEach(cb: (p: any, id: string) => void): void } }
      | undefined;
    let count = 0;
    const lines: string[] = [];
    if (state) {
      state.players.forEach((p: any, id: string) => {
        count++;
        lines.push((id === this.sessionId ? "» " : "  ") + String(p.name));
      });
    }
    const txt = `👥 Online: ${count}\n` + lines.join("\n");
    if (!this.roster) {
      this.roster = this.add
        .text(12, 44, txt, {
          fontFamily: "monospace",
          fontSize: "12px",
          color: "#e8e0c8",
          backgroundColor: "#000000aa",
          padding: { x: 8, y: 6 },
        })
        .setScrollFactor(0)
        .setDepth(UI_DEPTH);
    } else {
      this.roster.setText(txt);
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
    } else if (!on && this.reconnectBadge) {
      this.reconnectBadge.destroy();
      this.reconnectBadge = undefined;
    }
    if (this.reconnectBadge) {
      this.reconnectBadge.setPosition(this.scale.width / 2, this.scale.height - 30);
    }
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

  private addBrazier(c: number, r: number) {
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
      .setTint(0xff8a2e)
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
        tint: [0xfff3a0, 0xffb24d, 0xff6a2a],
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

  private addBanner(c: number, color: number) {
    const x = c * T + T / 2;
    const yTop = T * 0.85;
    const h = 34;
    this.add.rectangle(x, yTop + h / 2, 18, h, color).setStrokeStyle(1, 0x000000, 0.3).setDepth(2);
    this.add.rectangle(x, yTop + h / 2, 4, h, 0xcaa44a).setDepth(2);
    this.add.triangle(x, yTop + h, -9, 0, 9, 0, 0, 10, color).setDepth(2);
    this.add.rectangle(x, yTop + 12, 7, 7, 0xe8d8a0).setAngle(45).setDepth(2);
  }

  private addWallDecor([c, r, key]: Decor) {
    let x = c * T + T / 2;
    let y = r * T + T / 2;
    if (r === 0) y += T * 0.5 + 2;
    else if (r === ROWS - 1) y -= T * 0.5 + 2;
    if (c === 0) x += T * 0.5 + 2;
    else if (c === COLS - 1) x -= T * 0.5 + 2;
    this.add.image(x, y, key).setDepth(2).setScale(0.95);
  }

  private addTorch(c: number, r: number) {
    let x = c * T + T / 2;
    let y = r * T + T / 2;
    if (r === 0) y += T * 0.6;
    else if (r === ROWS - 1) y -= T * 0.6;
    if (c === 0) x += T * 0.6;
    else if (c === COLS - 1) x -= T * 0.6;

    this.add.rectangle(x, y + 9, 4, 13, 0x3a2a1a).setDepth(2);
    const glow = this.add
      .image(x, y, "flameDot")
      .setScale(2.6)
      .setTint(0xff8a2e)
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
        tint: [0xfff3a0, 0xffb24d, 0xff6a2a],
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

  update() {
    const body = this.player.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(0);

    const left = this.cursors.left.isDown || this.keys.A.isDown;
    const right = this.cursors.right.isDown || this.keys.D.isDown;
    const up = this.cursors.up.isDown || this.keys.W.isDown;
    const down = this.cursors.down.isDown || this.keys.S.isDown;

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

    // anel de "falando"
    const speaking = this.voice.connected ? this.voice.speakingIds() : null;
    if (this.localRing) {
      this.localRing
        .setPosition(this.player.x, this.player.y + 16)
        .setDepth(this.player.y - 1)
        .setVisible(!!speaking && speaking.has(this.sessionId));
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
      const state = this.room.state as unknown as { players: { get(id: string): any } };
      this.remotes.forEach((r, sid) => {
        const p = state.players.get(sid);
        if (!p) return;
        r.sprite.x += (p.x - r.sprite.x) * 0.25;
        r.sprite.y += (p.y - r.sprite.y) * 0.25;
        r.sprite.setDepth(r.sprite.y);
        const dn = DIR_NAME[p.dir] ?? "down";
        if (p.moving) r.sprite.anims.play(`c${p.charId}_${dn}`, true);
        else {
          r.sprite.anims.stop();
          r.sprite.setFrame(IDLE_FRAME[p.dir] ?? FRAME.downIdle);
        }
        r.label.setPosition(r.sprite.x, r.sprite.y - 30);
        r.ring
          .setPosition(r.sprite.x, r.sprite.y + 16)
          .setDepth(r.sprite.y - 1)
          .setVisible(!!speaking && speaking.has(sid));
      });

      // zona de reuniao + voz (proximidade ou bolha da sala)
      const self = { x: this.player.x, y: this.player.y };
      const myZone = zoneAt(self.x, self.y);
      this.updateMeetingBadge(myZone >= 0);
      if (this.voice.connected) {
        this.voice.applyGains((id) => {
          const p = state.players.get(id);
          if (!p) return 0;
          const tz = zoneAt(p.x, p.y);
          if (myZone >= 0 || tz >= 0) return myZone >= 0 && myZone === tz ? 1 : 0;
          const d = Math.hypot(p.x - self.x, p.y - self.y);
          const t = Math.max(0, Math.min(1, (VOICE_MAX - d) / (VOICE_MAX - VOICE_FULL)));
          return t * t; // queda quadratica
        });
        // tela compartilhada: visivel so pra quem esta na MESMA sala de reuniao
        this.voice.applyShareVisibility((id) => {
          const sp = state.players.get(id);
          if (!sp) return false;
          const sz = zoneAt(sp.x, sp.y);
          return sz >= 0 && sz === myZone;
        });

        // auto-mute por privacidade: so transmite se alguem pode te ouvir
        let audible = false;
        this.remotes.forEach((_r, sid) => {
          if (audible) return;
          const sp = state.players.get(sid);
          if (!sp) return;
          const sz = zoneAt(sp.x, sp.y);
          if (myZone >= 0) {
            if (sz === myZone) audible = true;
          } else if (sz < 0 && Math.hypot(sp.x - self.x, sp.y - self.y) < VOICE_MAX) {
            audible = true;
          }
        });
        const wantMic = this.voiceOn && audible;
        if (wantMic !== this.voice.micEnabled) void this.voice.setMicEnabled(wantMic);
        if (this.voice.micEnabled !== this.lastMic) {
          this.lastMic = this.voice.micEnabled;
          this.updateVoiceBtn();
        }
      }
    }

    if (this.voiceBtn) this.voiceBtn.setPosition(this.scale.width - 16, 16);
    if (this.shareBtn) this.shareBtn.setPosition(this.scale.width - 16, 52);
    if (this.voice.sharing !== this.lastSharing) {
      this.lastSharing = this.voice.sharing;
      this.updateShareBtn();
    }
    if (this.room && this.reconnectBadge) this.showReconnecting(false);
  }
}
