import { Room, RoomEvent, Track } from "livekit-client";
import type { RemoteAudioTrack, RemoteParticipant, RemoteTrack } from "livekit-client";
import { SERVER_HTTP_URL } from "./room";

export type Vec = { x: number; y: number };

/**
 * Voz por proximidade via LiveKit.
 * - Uma sala LiveKit unica ("office"); o volume de cada participante e
 *   calculado no cliente pela distancia entre os avatares (setVolume por faixa).
 */
export class VoiceManager {
  private room?: Room;
  private tracks = new Map<string, RemoteAudioTrack>();
  private els = new Map<string, HTMLMediaElement>();
  connected = false;
  muted = false;

  /** Conecta e publica o microfone. Deve ser chamado a partir de um clique (gesto). */
  async connect(identity: string, displayName: string): Promise<void> {
    const resp = await fetch(
      `${SERVER_HTTP_URL}/token?identity=${encodeURIComponent(identity)}&name=${encodeURIComponent(displayName)}`,
    );
    if (!resp.ok) throw new Error(`token HTTP ${resp.status}`);
    const data = (await resp.json()) as { token?: string; url?: string; error?: string };
    if (!data.token || !data.url) throw new Error(data.error ?? "token/url ausente");

    const room = new Room();

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant: RemoteParticipant) => {
      if (track.kind !== Track.Kind.Audio) return;
      const at = track as RemoteAudioTrack;
      this.tracks.set(participant.identity, at);
      const el = at.attach();
      el.style.display = "none";
      document.body.appendChild(el);
      this.els.set(participant.identity, el);
      at.setVolume(0); // comeca mudo; proximidade ajusta no proximo frame
    });

    const drop = (identity: string) => {
      const el = this.els.get(identity);
      if (el) el.remove();
      this.els.delete(identity);
      this.tracks.delete(identity);
    };
    room.on(RoomEvent.TrackUnsubscribed, (_t, _p, p: RemoteParticipant) => drop(p.identity));
    room.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => drop(p.identity));

    await room.connect(data.url, data.token);
    await room.localParticipant.setMicrophoneEnabled(true); // pede mic + publica
    this.room = room;
    this.connected = true;
  }

  async setMuted(m: boolean): Promise<void> {
    this.muted = m;
    if (this.room) await this.room.localParticipant.setMicrophoneEnabled(!m);
  }

  /** Aplica um volume (0..1) por participante, calculado pela cena (proximidade/zona). */
  applyGains(gainFor: (identity: string) => number): void {
    if (!this.connected) return;
    this.tracks.forEach((track, id) => {
      track.setVolume(Math.max(0, Math.min(1, gainFor(id))));
    });
  }

  /** Quem esta falando agora (identidades). */
  speakingIds(): Set<string> {
    const s = new Set<string>();
    if (this.room) {
      for (const p of this.room.remoteParticipants.values()) {
        if (p.isSpeaking) s.add(p.identity);
      }
      if (this.room.localParticipant.isSpeaking) s.add(this.room.localParticipant.identity);
    }
    return s;
  }

  disconnect(): void {
    try {
      this.room?.disconnect();
    } catch {
      /* ignore */
    }
    this.els.forEach((el) => el.remove());
    this.els.clear();
    this.tracks.clear();
    this.connected = false;
  }
}
