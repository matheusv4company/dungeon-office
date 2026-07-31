/**
 * F8 (Update V2): sessões de TRANSCRIÇÃO de reunião por zona.
 *
 * Uma sessão abre quando ≥2 jogadores estão na mesma zona de reunião e fecha quando a
 * zona ESVAZIA por 60s (grace — sair pra pegar água não encerra a reunião). As falas
 * chegam já transcritas do navegador (Web Speech API — SÓ TEXTO sai do cliente, nunca
 * áudio). Ao fechar com conteúdo mínimo, o OfficeRoom manda o transcript pro resumo.
 *
 * Módulo PURO (sem I/O) — o OfficeRoom injeta tempo/contagens e consome as sessões
 * fechadas. Fácil de testar; impossível travar a sala.
 */

export type Utterance = { ts: number; who: string; text: string };

export type MeetingSession = {
  zone: number;
  startedAt: number;
  utterances: Utterance[];
  speakers: Set<string>; // quem falou (nome de exibição)
  emptySince: number; // 0 = tem gente; senão, desde quando a zona está vazia
};

const GRACE_MS = 60_000; // zona vazia por isso => sessão fecha
const MAX_UTTERANCES = 3000; // trava de memória (~reunião de horas)

export class MeetingScribe {
  private sessions = new Map<number, MeetingSession>();

  /** Registra uma fala na sessão da zona (se aberta). true = aceita. */
  say(zone: number, who: string, text: string, now: number): boolean {
    const s = this.sessions.get(zone);
    if (!s) return false; // sem sessão aberta (menos de 2 pessoas ainda) — fala é descartada
    if (s.utterances.length >= MAX_UTTERANCES) return false;
    s.utterances.push({ ts: now, who, text });
    s.speakers.add(who);
    return true;
  }

  /** true se a zona tem sessão aberta (pro cliente saber que está "gravando"). */
  isOpen(zone: number): boolean {
    return this.sessions.has(zone);
  }

  /**
   * Atualiza o ciclo de vida com a contagem de jogadores por zona. Devolve as sessões
   * que FECHARAM neste tick (pro chamador resumir/persistir).
   */
  tick(counts: Map<number, number>, now: number): MeetingSession[] {
    const closed: MeetingSession[] = [];
    // abre sessão nova onde há reunião de verdade (≥2 pessoas)
    for (const [zone, n] of counts) {
      if (n >= 2 && !this.sessions.has(zone)) {
        this.sessions.set(zone, {
          zone,
          startedAt: now,
          utterances: [],
          speakers: new Set(),
          emptySince: 0,
        });
      }
    }
    // fecha as que esvaziaram além do grace
    for (const [zone, s] of [...this.sessions]) {
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
}
