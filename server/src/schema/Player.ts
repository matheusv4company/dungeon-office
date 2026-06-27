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
  /**
   * carimbo de tempo (ms do servidor) do ultimo "move". Muda a CADA move (mesmo
   * parado), entao o cliente detecta posicao stale: se parou de chegar, a pessoa
   * congelou/caiu e nao da pra confiar na posicao dela pro audio por proximidade.
   */
  @type("number") t = 0;
  /** esta "streamando" o gestor de tarefas (quem esta perto ve/edita junto) */
  @type("boolean") streamingBoard = false;
  /** identidade duravel de gamificacao (nome do membro normalizado); "" = convidado */
  @type("string") memberId = "";
  // --- gamificacao F7: stats upside-only (derivados do nivel; baseline 100/20 sempre preservado) ---
  @type("uint8") maxHp = 100; // 100..120 (HP maximo do combate; barra passa a hp/maxHp)
  @type("uint8") dmg = 20; // 20..26 (dano da bola de fogo)
  @type("uint8") level = 1; // nivel re-hidratado no join (espelho pro combate/cosmeticos)
}
