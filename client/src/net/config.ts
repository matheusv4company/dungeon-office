// Feature flags da gamificacao, lidos do servidor (GET /config) uma vez no boot e
// guardados em memoria. Cada feature do cliente consulta getFlags() antes de agir; com o
// flag off, o comportamento volta ao anterior (sem residuo). Espelha o flags.ts do servidor.
import { SERVER_HTTP_URL } from "./room";

export type GamifFlags = {
  login: boolean; // F1 — tela de login por membro + PIN
  gate: boolean; // F2 — gate de entrega (Feito -> Entregue -> Verificado)
  aiReview: boolean; // F3 — nota da IA na entrega
  overdue: boolean; // F4 — chips de atraso amigaveis
  climate: boolean; // F5 — visao propria do atraso + clima do escritorio
  progression: boolean; // F6 — pontos de entrega / XP / nivel
  stats: boolean; // F7 — bonus de combate por nivel (so soma, nunca pune)
  cosmetics: boolean; // F8 — cosmeticos + celebracao
  social: boolean; // F9 — streak de time / cooperacao
  novaEra: boolean; // NE — mudanca estetica da nova fase (Nucleo, cripta ascendida, cristal)
};

// Default: tudo LIGADO (mesmo default do servidor). Se o /config falhar no boot, o jogo
// provavelmente nem conecta — entao manter tudo on evita sumir com features por um blip.
const TODOS_ON: GamifFlags = {
  login: true,
  gate: true,
  aiReview: true,
  overdue: true,
  climate: true,
  progression: true,
  stats: true,
  cosmetics: true,
  social: true,
  novaEra: true,
};

let flags: GamifFlags = { ...TODOS_ON };
let carregado = false;

/** Busca /config no servidor e guarda os flags. Chamar uma vez no boot (BootScene). */
export async function loadConfig(): Promise<GamifFlags> {
  try {
    // Timeout curto: nao pendurar o boot se o servidor estiver lento/fora.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(`${SERVER_HTTP_URL}/config`, { signal: ctrl.signal });
    clearTimeout(t);
    const data = (await r.json()) as { flags?: Partial<GamifFlags> };
    flags = { ...TODOS_ON, ...(data.flags ?? {}) };
    carregado = true;
  } catch {
    // Servidor fora do ar no boot -> mantem default (tudo on).
    flags = { ...TODOS_ON };
  }
  return flags;
}

/** Flags ja carregados (sincrono). Antes do loadConfig resolver, devolve tudo on. */
export function getFlags(): GamifFlags {
  return flags;
}

/** true depois que o /config respondeu com sucesso. */
export function configLoaded(): boolean {
  return carregado;
}
