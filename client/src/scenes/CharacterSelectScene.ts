import Phaser from "phaser";
import { CHARACTERS, FRAME, charKey, loadSelection, saveSelection } from "../characters";

/** Tela inicial: escolher 1 de 10 personagens + digitar o nome. */
export class CharacterSelectScene extends Phaser.Scene {
  private selected = 0;
  private highlight!: Phaser.GameObjects.Rectangle;
  private nameInput?: HTMLInputElement;
  private positions: Array<{ x: number; y: number }> = [];

  constructor() {
    super("select");
  }

  create() {
    const W = this.scale.width;
    const H = this.scale.height;
    this.cameras.main.setBackgroundColor("#15131d");

    this.add
      .text(W / 2, 40, "Escolha seu personagem", {
        fontFamily: "monospace",
        fontSize: "26px",
        color: "#f0e6c8",
      })
      .setOrigin(0.5);

    const saved = loadSelection();
    this.selected = saved.index;

    const cols = 5;
    const cellW = 134;
    const cellH = 164;
    const startX = W / 2 - (cols * cellW) / 2 + cellW / 2;
    const startY = 138;

    this.highlight = this.add
      .rectangle(0, 0, 104, 128, 0xffd36b, 0.12)
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
        .image(x, y, charKey(i), FRAME.downIdle)
        .setScale(1.8)
        .setDepth(1)
        .setInteractive({ useHandCursor: true });
      img.on("pointerover", () => img.setScale(1.95));
      img.on("pointerout", () => img.setScale(1.8));
      img.on("pointerdown", () => this.select(i));

      // nome ABAIXO do sprite, com folga
      this.add
        .text(x, y + 62, c.name, {
          fontFamily: "monospace",
          fontSize: "12px",
          color: "#cfc7b0",
          align: "center",
        })
        .setOrigin(0.5)
        .setDepth(2);
    });

    this.select(this.selected);

    // campo de nome (DOM via tag — mais confiavel que createFromHTML)
    this.add
      .text(W / 2, H - 150, "Seu nome:", {
        fontFamily: "monospace",
        fontSize: "16px",
        color: "#cfc7b0",
      })
      .setOrigin(0.5);

    const style =
      "width:300px;padding:11px 12px;font-family:monospace;font-size:16px;" +
      "border-radius:8px;border:2px solid #5a4a2a;background:#221c12;color:#f0e6c8;" +
      "text-align:center;outline:none;box-sizing:border-box;";
    const dom = this.add.dom(W / 2, H - 112, "input", style);
    const input = dom.node as HTMLInputElement;
    input.type = "text";
    input.maxLength = 16;
    input.id = "ev-name-input";
    input.placeholder = "Convidado";
    input.value = saved.name;
    input.autocomplete = "off";
    input.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") this.enter();
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
    btn.on("pointerdown", () => this.enter());
  }

  private select(i: number) {
    this.selected = i;
    const p = this.positions[i];
    if (p) this.highlight.setPosition(p.x, p.y + 6).setVisible(true);
  }

  private enter() {
    const fallback = document.getElementById("ev-name-input") as HTMLInputElement | null;
    const raw = this.nameInput?.value ?? fallback?.value ?? "";
    const name = raw.trim().slice(0, 16) || "Convidado";
    saveSelection(this.selected, name);
    this.scene.start("office");
  }
}
