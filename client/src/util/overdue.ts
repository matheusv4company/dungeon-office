// Cálculo de prazo compartilhado entre o kanban (chips) e o mundo (nuvem/clima do F5),
// pra manter a regra de atraso num lugar só. Usa committedDue (prazo CONGELADO ao iniciar,
// anti-empurrar-prazo); se ainda não congelou, cai no due de planejamento.

/**
 * Dias até o prazo: >0 faltam, 0 é hoje, <0 atrasada. null = sem prazo / "feito" / "travado" (pausado).
 * `blockedMs` (tempo já parado em "Travado") ESTENDE o prazo congelado — pausa real do relógio,
 * pra um bloqueio externo (aguardando cliente) não virar atraso ao destravar.
 */
export function daysToDue(committedDue: number, due: string, col: string, blockedMs = 0): number | null {
  if (col === "feito" || col === "travado") return null;
  let deadline: number;
  if (committedDue && committedDue > 0) deadline = committedDue + (blockedMs || 0);
  else if (due) {
    deadline = Date.parse(`${due}T23:59:59`);
    if (Number.isNaN(deadline)) return null;
  } else return null;
  const dueDay = new Date(deadline);
  dueDay.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((dueDay.getTime() - today.getTime()) / 86400000);
}
