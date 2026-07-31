/**
 * Aplicador de ASSINATURAS forçadas no LiveKit (F1 do Update V2).
 *
 * O RoomService do LiveKit permite o servidor assinar/desassinar tracks POR
 * PARTICIPANTE (updateSubscriptions). O OfficeRoom usa isso pra materializar o que
 * o motor de audibilidade decidiu: listener só RECEBE o áudio de quem pode ouvir.
 *
 * Segurança/robustez:
 * - Gerencia SÓ tracks de ÁUDIO (microfone e áudio de share). Vídeo/share visual
 *   ficam intocados (regras próprias no cliente).
 * - Toda chamada é try/catch: falha NUNCA derruba a sala; loga com throttle e o
 *   reconcile tenta de novo no próximo tick (auto-cura).
 * - Nunca loga chave/token — só identidades e contagens.
 * - Se a API estiver indisponível, o comportamento degrada pro atual (fade por
 *   distância no cliente) — funcional, e o problema aparece no log do boot.
 */
import { RoomServiceClient, TrackSource, TrackInfo } from "livekit-server-sdk";

const LK_ROOM = "office";

/** Converte a URL WS do LiveKit pra HTTP (RoomService fala HTTP). */
function httpUrl(wsUrl: string): string {
  return wsUrl.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
}

export type AudioSids = { sids: string[]; sig: string };

export class LkSubscriptions {
  private svc: RoomServiceClient | null = null;
  private lastErrAt = 0;

  constructor() {
    const url = process.env.LIVEKIT_URL;
    const key = process.env.LIVEKIT_API_KEY;
    const secret = process.env.LIVEKIT_API_SECRET;
    if (url && key && secret) this.svc = new RoomServiceClient(httpUrl(url), key, secret);
  }

  ready(): boolean {
    return this.svc !== null;
  }

  /** Log de erro com throttle (evita spam se o LiveKit cair). */
  private logErr(where: string, e: unknown): void {
    const now = Date.now();
    if (now - this.lastErrAt < 30_000) return;
    this.lastErrAt = now;
    console.error(`[audibility] ${where} falhou:`, String((e as Error)?.message ?? e).slice(0, 160));
  }

  /** Smoke test pro log do boot (confirma que o RoomService responde no deploy). */
  async smoke(): Promise<boolean> {
    if (!this.svc) return false;
    try {
      await this.svc.listRooms();
      return true;
    } catch (e) {
      this.logErr("smoke listRooms", e);
      return false;
    }
  }

  /**
   * Lista quem está na sala do LiveKit e devolve, por identidade, os SIDs das
   * tracks de ÁUDIO (mic + áudio de share). `sig` muda quando o conjunto muda —
   * o chamador usa isso pra invalidar o estado aplicado daquele publisher.
   */
  async audioSidsByIdentity(): Promise<Map<string, AudioSids> | null> {
    if (!this.svc) return null;
    try {
      const parts = await this.svc.listParticipants(LK_ROOM);
      const map = new Map<string, AudioSids>();
      for (const p of parts) {
        const sids = (p.tracks ?? [])
          .filter(
            (t: TrackInfo) =>
              t.source === TrackSource.MICROPHONE || t.source === TrackSource.SCREEN_SHARE_AUDIO,
          )
          .map((t) => t.sid)
          .sort();
        map.set(p.identity, { sids, sig: sids.join(",") });
      }
      return map;
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      // sala ainda não existe (ninguém na voz) = ZERO participantes — devolve Map VAZIO,
      // que flui pelo caminho normal de limpeza (zera lkSids/appliedSubs). null fica só
      // pra falha de TRANSPORTE (aí manter o estado atual é mais seguro que zerar às cegas).
      if (/not found|does not exist/i.test(msg)) return new Map();
      this.logErr("listParticipants", e);
      return null;
    }
  }

  /** Assina/desassina as tracks `sids` pro listener. true = aplicado com sucesso. */
  async apply(listener: string, sids: string[], subscribe: boolean): Promise<boolean> {
    if (!this.svc || sids.length === 0) return sids.length === 0;
    try {
      await this.svc.updateSubscriptions(LK_ROOM, listener, sids, subscribe);
      return true;
    } catch (e) {
      this.logErr(`updateSubscriptions(${listener.slice(0, 8)}…)`, e);
      return false;
    }
  }
}
