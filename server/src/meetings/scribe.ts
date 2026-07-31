/**
 * F8 (Update V2): sessões de TRANSCRIÇÃO de reunião por zona.
 *
 * Uma sessão abre quando ≥2 MEMBROS estão na mesma zona de reunião (o chamador filtra
 * quem conta) e fecha quando: (a) a zona esvazia por 60s (grace — sair pra pegar água
 * não encerra), OU (b) ninguém fala há 15min mesmo com gente parada na sala (avatar
 * AFK não pode prender a sessão pra sempre — senão reuniões consecutivas se fundem e
 * a ata nunca sai). As falas chegam já transcritas do navegador.
 *
 * Módulo quase-puro (só loga o estouro de capacidade) — o OfficeRoom injeta
 * tempo/contagens e consome as sessões fechadas.
 */

export type Utterance = { ts: number; who: string; text: string };

export type MeetingSession = {
  zone: number;
  startedAt: number;
  utterances: Utterance[];
  speakers: Set<string>; // quem falou (nome de exibição)
  emptySince: number; // 0 = tem gente; senão, desde quando a zona está vazia
  lastSayAt: number; // última fala (base do fechamento por inatividade)
  capWarned: boolean; // já logamos o estouro do teto de falas desta sessão?
};

const GRACE_MS = 60_000; // zona vazia por isso => sessão fecha
const IDLE_MS = 15 * 60_000; // sem NENHUMA fala por isso => fecha mesmo com gente na sala
const MAX_UTTERANCES = 3000; // trava de memória (~reunião de horas)

export class MeetingScribe {
  private sessions = new Map<number, MeetingSession>();

  /** Registra uma fala na sessão da zona (se aberta). true = aceita. */
  say(zone: number, who: string, text: string, now: number): boolean {
    const s = this.sessions.get(zone);
    if (!s) return false; // sem sessão aberta (menos de 2 membros ainda) — fala é descartada
    if (s.utterances.length >= MAX_UTTERANCES) {
      if (!s.capWarned) {
        s.capWarned = true;
        console.warn(`[scribe] sessão da zona ${zone} bateu o teto de ${MAX_UTTERANCES} falas — descartando as próximas`);
      }
      return false;
    }
    s.utterances.push({ ts: now, who, text });
    s.speakers.add(who);
    s.lastSayAt = now;
    return true;
  }

  /** true se a zona tem sessão aberta (pro cliente saber que está "gravando"). */
  isOpen(zone: number): boolean {
    return this.sessions.has(zone);
  }

  /**
   * Atualiza o ciclo de vida com a contagem de MEMBROS por zona. Devolve as sessões
   * que FECHARAM neste tick (pro chamador resumir/persistir).
   */
  tick(counts: Map<number, number>, now: number): MeetingSession[] {
    const closed: MeetingSession[] = [];
    for (const [zone, n] of counts) {
      if (n >= 2 && !this.sessions.has(zone)) {
        this.sessions.set(zone, {
          zone,
          startedAt: now,
          utterances: [],
          speakers: new Set(),
          emptySince: 0,
          lastSayAt: now,
          capWarned: false,
        });
      }
    }
    for (const [zone, s] of [...this.sessions]) {
      // inatividade: 15min sem fala fecha a sessão mesmo com gente parada na sala
      if (now - Math.max(s.lastSayAt, s.startedAt) >= IDLE_MS) {
        this.sessions.delete(zone);
        closed.push(s);
        continue;
      }
      const n = counts.get(zone) ?? 0;
      if (n > 0) {
        s.emptySince = 0;
        continue;
      }
      if (s.emptySince === 0) s.emptySince = now;
      else if (now - s.emptySince >= GRACE_MS) {
        this.sessions.delete(zone);
        closed.push(s);
      }
    }
    return closed;
  }

  /** Fecha e devolve TODAS as sessões abertas (chamado no dispose da sala — nada se perde). */
  drain(): MeetingSession[] {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    return all;
  }
}
