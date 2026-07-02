// Cálculo de prazo compartilhado entre o kanban (chips) e o mundo (nuvem/clima do F5).
// Usa o `due` ATUAL (a data que a pessoa vê e edita) — assim mudar o prazo atualiza o chip na
// hora, e o score do servidor usa a MESMA data (nunca divergem).

/**
 * Dias até o prazo: >0 faltam, 0 é hoje, <0 atrasada. null = sem prazo / "feito" / "travado" (pausado).
 * `blockedMs` (tempo já parado em "Travado") ESTENDE o prazo — pausa real do relógio, pra um
 * bloqueio externo (aguardando cliente) não virar atraso ao destravar.
 */
export function daysToDue(due: string, col: string, blockedMs = 0): number | null {
  if (col === "feito" || col === "travado") return null;
  if (!due) return null;
  let deadline = Date.parse(`${due}T23:59:59`);
  if (Number.isNaN(deadline)) return null;
  deadline += blockedMs || 0;
  const dueDay = new Date(deadline);
  dueDay.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((dueDay.getTime() - today.getTime()) / 86400000);
}
