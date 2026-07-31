/**
 * Motor de AUDIBILIDADE (F1 do Update V2) — decide, NO SERVIDOR, quais pares de
 * jogadores podem se ouvir. Arquitetura inspirada no WorkAdventure (bolhas discretas
 * decididas pelo back; o front só se conecta a quem está na bolha): aqui o resultado
 * alimenta assinaturas forçadas no LiveKit (ver subscriptions.ts) — quem não deve
 * ouvir NEM RECEBE a track. O fade por distância no cliente vira só estética.
 *
 * Regras de um par (A,B):
 *  - andares diferentes  -> NUNCA audível;
 *  - um dos dois numa zona de reunião -> audível SÓ se os dois estão na MESMA zona
 *    (zona é conjunto fechado: de fora nunca se ouve quem está dentro, e vice-versa);
 *  - fora de zonas -> por distância com HISTERESE: entra a <= AUD_ENTER, sai a
 *    > AUD_EXIT (evita flap na fronteira; igual minDistance/groupRadius do WorkAdventure).
 *
 * Os raios são um SUPERSET do alcance audível do cliente (VOICE_MAX=160px): a track
 * é assinada a 200px — quando o fade começa (160px) o áudio já está pronto — e é
 * desassinada a 260px.
 *
 * Este módulo é PURO (sem I/O): fácil de testar e impossível de travar a sala.
 */

export type AudPoint = { id: string; x: number; y: number };
export type AudPair = { a: string; b: string };

/** Raio pra COMEÇAR a ouvir (assinar a track). Cliente faz fade a partir de 160px. */
export const AUD_ENTER = 200;
/** Raio pra PARAR de ouvir (desassinar). Maior que o de entrada = histerese. */
export const AUD_EXIT = 260;

// ---- geometria do mapa (ESPELHA client/src/scenes/OfficeScene.ts — manter em sincronia!) ----
// Derivada com as MESMAS fórmulas do cliente (nada de número mágico solto) pra qualquer
// divergência ficar evidente num diff lado a lado.
const T = 32;
const BEACH_ROWS = 16;
const OFFICE_ROWS = 22;
const OY = BEACH_ROWS + 1; // 17 — 1ª linha do escritório
const CRYPT_Y0 = OY + OFFICE_ROWS; // 39 — 1ª linha da cripta
const FLOOR1_Y = OY * T; // 544: acima é praia (andar 0)
const FLOOR2_Y = CRYPT_Y0 * T; // 1248: abaixo é cripta (andar 2)

/** Andar de uma coordenada Y do mundo (0=praia, 1=escritório, 2=cripta). */
export function floorOfY(y: number): number {
  if (y < FLOOR1_Y) return 0;
  if (y < FLOOR2_Y) return 1;
  return 2;
}

// Zonas de reunião (px do mundo) — ESPELHA MEETING_ZONES do OfficeScene.ts.
// y2 = TOPO da parede sul ((OY+19)*T), NÃO a base: o ponto rastreado é o CENTRO do sprite
// (~14-26px acima dos pés). Com y2 na base da parede, quem andava no CORREDOR público
// colado nela tinha o centro dentro da zona e o motor ASSINAVA a reunião fechada pra ele
// (vazamento CONFIRMADO no review V2). Interior segue 100% coberto: dentro, encostado na
// parede, o centro fica ≥26px acima do topo dela.
const ZONES = [
  { x1: 5 * T, y1: (OY + 13) * T, x2: 12 * T, y2: (OY + 19) * T }, // sala azul
  { x1: 18 * T, y1: (OY + 6) * T, x2: 26 * T, y2: (OY + 12) * T }, // sala vermelha
  { x1: 18 * T, y1: (OY + 13) * T, x2: 26 * T, y2: (OY + 19) * T }, // sala dourada
];

/** Índice da zona de reunião no ponto, ou -1 se fora de todas. */
export function zoneAt(x: number, y: number): number {
  for (let i = 0; i < ZONES.length; i++) {
    const z = ZONES[i];
    if (x >= z.x1 && x <= z.x2 && y >= z.y1 && y <= z.y2) return i;
  }
  return -1;
}

/** Chave canônica de um par (ordem independente). */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** true se o par deve FICAR/FICAR audível dado o estado atual (histerese). */
function pairAudible(a: AudPoint, b: AudPoint, wasAudible: boolean): boolean {
  if (floorOfY(a.y) !== floorOfY(b.y)) return false;
  const za = zoneAt(a.x, a.y);
  const zb = zoneAt(b.x, b.y);
  if (za >= 0 || zb >= 0) return za === zb; // zona fechada: só mesma zona
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  return d <= (wasAudible ? AUD_EXIT : AUD_ENTER);
}

/**
 * Mantém o conjunto de pares audíveis entre ticks (necessário pra histerese) e
 * devolve os DELTAS de cada recomputo — que viram assinaturas no LiveKit e os
 * eventos prox:enter/prox:leave (F2).
 */
export class AudibilityEngine {
  private audible = new Set<string>(); // pairKey dos pares atualmente audíveis

  /** Recomputa tudo. Devolve quais pares ENTRARAM e SAÍRAM da audibilidade. */
  tick(players: AudPoint[]): { enters: AudPair[]; leaves: AudPair[] } {
    const enters: AudPair[] = [];
    const leaves: AudPair[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const a = players[i];
        const b = players[j];
        const key = pairKey(a.id, b.id);
        seen.add(key);
        const was = this.audible.has(key);
        const is = pairAudible(a, b, was);
        if (is && !was) {
          this.audible.add(key);
          enters.push({ a: a.id, b: b.id });
        } else if (!is && was) {
          this.audible.delete(key);
          leaves.push({ a: a.id, b: b.id });
        }
      }
    }
    // pares com gente que saiu da sala: removidos (leave já foi tratado pelo dropId
    // ou o jogador simplesmente não está mais na lista — limpar evita lixo eterno)
    for (const key of [...this.audible]) {
      if (!seen.has(key)) this.audible.delete(key);
    }
    return { enters, leaves };
  }

  /** O par (a,b) está audível agora? */
  isAudible(a: string, b: string): boolean {
    return this.audible.has(pairKey(a, b));
  }

  /** Remove um jogador (saiu da sala); devolve com quem ele estava audível. */
  dropId(id: string): string[] {
    const others: string[] = [];
    for (const key of [...this.audible]) {
      const [a, b] = key.split("|");
      if (a === id || b === id) {
        this.audible.delete(key);
        others.push(a === id ? b : a);
      }
    }
    return others;
  }
}
