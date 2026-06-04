import Phaser from "phaser";
import { CHARACTERS, charKey } from "../characters";

const WEAPONS = [
  "long_sword1",
  "battle_axe1",
  "war_axe1",
  "mace1",
  "morningstar1",
  "scimitar1",
  "broad_axe1",
  "flail1",
];
const SHIELDS = ["buckler1", "kite_shield1", "tower_shield1"];

/** Pre-carrega assets (dungeon + 10 personagens) e entra na selecao. */
export class BootScene extends Phaser.Scene {
  constructor() {
    super("boot");
  }

  preload() {
    const { width, height } = this.scale;
    const label = this.add
      .text(width / 2, height / 2, "Carregando…", {
        fontFamily: "monospace",
        fontSize: "18px",
        color: "#ffffff",
      })
      .setOrigin(0.5);
    this.load.on("complete", () => label.destroy());

    // Dungeon (Dungeon Crawl Stone Soup, CC0)
    this.load.image("floor", "assets/dungeon/floor/pebble_brown0.png");
    this.load.image("wall", "assets/dungeon/wall/brick_dark_2_0.png");
    this.load.image("wall2", "assets/dungeon/wall/brick_dark_2_1.png");
    this.load.image("door_open", "assets/dungeon/door/open_door.png");
    WEAPONS.forEach((w) => this.load.image("w_" + w, `assets/dungeon/weapon/${w}.png`));
    SHIELDS.forEach((s) => this.load.image("s_" + s, `assets/dungeon/shield/${s}.png`));

    // Decoracao (DCSS, CC0): colunas, estatuas, fonte
    this.load.image("column", "assets/dungeon/decor/column.png");
    this.load.image("column2", "assets/dungeon/decor/column_crumbled.png");
    this.load.image("statue_sword", "assets/dungeon/decor/statue_sword.png");
    this.load.image("statue_axe", "assets/dungeon/decor/statue_axe.png");
    this.load.image("statue_dragon", "assets/dungeon/decor/statue_dragon.png");
    this.load.image("statue_angel", "assets/dungeon/decor/statue_angel.png");
    this.load.image("fountain", "assets/dungeon/decor/fountain.png");

    // Personagens (LPC, CC-BY-SA) — sheets 9x4 de 64px (caminhada nas 4 direcoes)
    CHARACTERS.forEach((c) =>
      this.load.spritesheet(charKey(c.index), `assets/chars/char${c.index}.png`, {
        frameWidth: 64,
        frameHeight: 64,
      }),
    );
  }

  create() {
    console.log("[BootScene] assets carregados -> seleção");
    this.scene.start("select");
  }
}
