import Phaser from "phaser";

export type CharInfo = { index: number; id: string; name: string };

/** 10 personagens (ordem = char0..char9.png gerados pelo tools/build-characters.mjs). */
export const CHARACTERS: CharInfo[] = [
  { index: 0, id: "cavaleiro", name: "Cavaleiro" },
  { index: 1, id: "cav_dourado", name: "Cavaleiro Dourado" },
  { index: 2, id: "soldado", name: "Soldado" },
  { index: 3, id: "mago", name: "Mago" },
  { index: 4, id: "arqueiro", name: "Arqueiro" },
  { index: 5, id: "ladino", name: "Ladino" },
  { index: 6, id: "guerreiro", name: "Guerreiro" },
  { index: 7, id: "senhor_guerra", name: "Senhor de Guerra" },
  { index: 8, id: "clerigo", name: "Clérigo" },
  { index: 9, id: "elfo", name: "Elfo Sombrio" },
];

/** Frame parado (coluna 0) de cada direcao no sheet 9x4. */
export const FRAME = { upIdle: 0, leftIdle: 9, downIdle: 18, rightIdle: 27 };

export const charKey = (i: number) => `char${i}`;

/** Cria as animacoes de caminhada (4 direcoes) de um personagem, se ainda nao existirem. */
export function ensureCharAnims(scene: Phaser.Scene, i: number) {
  const key = charKey(i);
  const mk = (dir: string, base: number) => {
    const k = `c${i}_${dir}`;
    if (scene.anims.exists(k)) return;
    scene.anims.create({
      key: k,
      frames: scene.anims.generateFrameNumbers(key, {
        frames: [base + 1, base + 2, base + 3, base + 4, base + 5, base + 6, base + 7, base + 8],
      }),
      frameRate: 9,
      repeat: -1,
    });
  };
  mk("up", 0);
  mk("left", 9);
  mk("down", 18);
  mk("right", 27);
}

const LS_CHAR = "ev_charIndex";
const LS_NAME = "ev_name";

export function loadSelection(): { index: number; name: string } {
  let index = 0;
  let name = "";
  try {
    index = Math.max(0, Math.min(9, Number(localStorage.getItem(LS_CHAR) ?? 0) | 0));
    name = (localStorage.getItem(LS_NAME) ?? "").slice(0, 16);
  } catch {
    /* sem localStorage */
  }
  return { index, name };
}

export function saveSelection(index: number, name: string) {
  try {
    localStorage.setItem(LS_CHAR, String(index));
    localStorage.setItem(LS_NAME, name);
  } catch {
    /* ignora */
  }
}
