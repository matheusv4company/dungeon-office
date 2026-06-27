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
  };
}
