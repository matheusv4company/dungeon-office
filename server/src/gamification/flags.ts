// Feature flags da gamificacao — lidas do ambiente, DEFAULT LIGADO quando a var nao existe.
// Cada feature so age (no servidor E no cliente) se o flag estiver on; o cliente le os
// flags do endpoint GET /config no boot. Assim o dono desliga qualquer coisa setando
// GAMIF_X=0 no Coolify (sem rebuild, sem reverter codigo) e o app volta ao comportamento
// anterior. Master GAMIF_ALL=0 e o kill switch que desliga a gamificacao inteira de uma vez.

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
  paintedMap: boolean; // re-skin: fundos pintados (nano banana) dos 3 andares no lugar dos tiles
  audioAuth: boolean; // F1 V2 — audibilidade server-side (assinaturas forcadas no LiveKit)
  proxSound: boolean; // F2 V2 — aviso sonoro de entrada/saida do alcance de voz
  shareAudio: boolean; // F3 V2 — compartilhamento de tela com AUDIO (aba/sistema)
  emotes: boolean; // F7 V2 — emoji flutuante em cima do personagem
  meetingScribe: boolean; // F8 V2 - transcricao/ata automatica das reunioes
};

// Desliga com "0", "false", "off" ou "no" (qualquer caixa); qualquer outro valor —
// inclusive a var ausente — deixa ligado. Tolerante de proposito: o dono seta isso na
// mao no Coolify, entao GAMIF_X=false tem que desligar como ele espera (e nao ficar on).
const DESLIGA = new Set(["0", "false", "off", "no"]);
function ligado(nome: string): boolean {
  const v = process.env[nome];
  if (v == null) return true;
  return !DESLIGA.has(v.trim().toLowerCase());
}

/** Le os flags do ambiente. GAMIF_ALL desligado e o kill switch mestre (desliga tudo). */
export function getFlags(): GamifFlags {
  const mestre = ligado("GAMIF_ALL");
  const f = (nome: string) => mestre && ligado(nome);
  return {
    login: f("GAMIF_LOGIN"),
    gate: f("GAMIF_GATE"),
    aiReview: f("GAMIF_AIREVIEW"),
    overdue: f("GAMIF_OVERDUE"),
    climate: f("GAMIF_CLIMATE"),
    progression: f("GAMIF_PROGRESSION"),
    stats: f("GAMIF_STATS"),
    cosmetics: f("GAMIF_COSMETICS"),
    social: f("GAMIF_SOCIAL"),
    novaEra: f("GAMIF_NOVA_ERA"),
    // visual, NÃO gated pelo GAMIF_ALL (toggle independente): desliga com PAINTED_MAP=0
    paintedMap: ligado("PAINTED_MAP"),
    // infra de VOZ, NÃO gated pelo GAMIF_ALL: desliga com AUDIO_AUTH=0 (volta ao fade-só-cliente)
    audioAuth: ligado("AUDIO_AUTH"),
    proxSound: ligado("PROX_SOUND"),
    shareAudio: ligado("SHARE_AUDIO"),
    emotes: ligado("EMOTES"),
    meetingScribe: ligado("MEETING_SCRIBE"),
  };
}
