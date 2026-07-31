/**
 * F2 (Update V2): aviso sonoro de proximidade — "alguém chegou ao alcance da sua
 * voz" / "alguém saiu". Sons SINTETIZADOS via WebAudio (zero asset externo):
 * dois tons curtos subindo = chegou; descendo = saiu. Volume discreto.
 *
 * Autoplay: o AudioContext pode nascer "suspended" antes do 1º gesto do usuário.
 * Tentamos resume(); se não der (nenhuma interação ainda), o som é simplesmente
 * pulado — nunca enfileira nem lança erro.
 */

let ctx: AudioContext | null = null;

function ensureCtx(): AudioContext | null {
  if (!ctx) {
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      // gesto futuro destrava o contexto (uma vez só)
      const unlock = () => void ctx?.resume().catch(() => {});
      window.addEventListener("pointerdown", unlock, { once: true });
      window.addEventListener("keydown", unlock, { once: true });
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  return ctx.state === "running" ? ctx : null;
}

/** Um tom curto com envelope (sem clique). */
function tone(ac: AudioContext, freq: number, at: number, dur: number, vol: number): void {
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(vol, at + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(g).connect(ac.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

/** Toca o aviso: entered=true (chegou ao alcance) sobe; false (saiu) desce. */
export function playProxChime(entered: boolean): void {
  const ac = ensureCtx();
  if (!ac) return; // sem contexto destravado ainda — pula em silêncio
  const t0 = ac.currentTime + 0.01;
  const VOL = 0.11;
  if (entered) {
    tone(ac, 660, t0, 0.09, VOL);
    tone(ac, 880, t0 + 0.1, 0.12, VOL);
  } else {
    tone(ac, 880, t0, 0.09, VOL);
    tone(ac, 660, t0 + 0.1, 0.12, VOL);
  }
}
