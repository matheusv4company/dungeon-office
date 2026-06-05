import { Schema, type } from "@colyseus/schema";

/** Um jogador no escritorio. Posicao em pixels do mundo. */
export class Player extends Schema {
  @type("number") x = 320;
  @type("number") y = 320;
  /** 0=baixo, 1=cima, 2=esquerda, 3=direita (ultima direcao encarada) */
  @type("uint8") dir = 0;
  @type("boolean") moving = false;
  @type("string") name = "Convidado";
  /** indice do personagem escolhido (0..9) */
  @type("uint8") charId = 0;
  /** maozinha levantada (pedir pra falar) */
  @type("boolean") handRaised = false;
  /** vida 0..100 — morre em 0 (cada bola de fogo tira 20) */
  @type("uint8") hp = 100;
}
