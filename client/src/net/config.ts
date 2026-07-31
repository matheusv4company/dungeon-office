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
  paintedMap: boolean; // re-skin: fundos pintados dos 3 andares
  audioAuth: boolean; // F1 V2 — audibilidade server-side (assinaturas forcadas no LiveKit)
  proxSound: boolean; // F2 V2 — aviso sonoro de entrada/saida do alcance de voz
  shareAudio: boolean; // F3 V2 — compartilhamento de tela com AUDIO (aba/sistema)
  emotes: boolean; // F7 V2 — emoji flutuante em cima do personagem
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
  paintedMap: true,
  audioAuth: true,
  proxSound: true,
  shareAudio: true,
  emotes: true,
};

let flags: GamifFlags = { ...TODOS_ON };
let carregado = false;
let approver = ""; // memberId de quem aprova entregas "sem comprovação" (vazio = qualquer um)
let vaultEnabled = false; // Central de Senhas operável no servidor (VAULT_KEY presente). Default OFF.

/** memberId (nome de login normalizado) do aprovador de entregas sem comprovação. */
export function getApprover(): string {
  return approver;
}

/** true se o cofre (Central de Senhas) está operável no servidor (VAULT_KEY válida). */
export function getVaultEnabled(): boolean {
  return vaultEnabled;
}

/**
 * Busca /config no servidor e guarda os flags. Chamar uma vez no boot (BootScene).
 * Tenta 3x com backoff curto: um blip no fetch não pode deixar o cliente divergir do
 * servidor (renderizar controle de feature que o servidor tem OFF, virando botão "morto").
 */
export async function loadConfig(): Promise<GamifFlags> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Timeout curto: nao pendurar o boot se o servidor estiver lento/fora.
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(`${SERVER_HTTP_URL}/config`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error(`status ${r.status}`);
      const data = (await r.json()) as { flags?: Partial<GamifFlags>; approver?: string; vault?: boolean };
      flags = { ...TODOS_ON, ...(data.flags ?? {}) };
      approver = typeof data.approver === "string" ? data.approver : "";
      vaultEnabled = data.vault === true; // só liga o cofre se o servidor confirmar (default false)
      carregado = true;
      return flags;
    } catch {
      if (attempt < 2) await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
    }
  }
  // 3 tentativas falharam -> mantém default (tudo on); configLoaded() segue false pra quem quiser tratar.
  flags = { ...TODOS_ON };
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
