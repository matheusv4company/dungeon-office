import { Room, RoomEvent, Track } from "livekit-client";
import type {
  LocalTrackPublication,
  RemoteAudioTrack,
  RemoteParticipant,
  RemoteTrack,
  RemoteVideoTrack,
} from "livekit-client";
import { SERVER_HTTP_URL } from "./room";

export type Vec = { x: number; y: number };

type ShareEntry = {
  track: RemoteVideoTrack;
  card: HTMLDivElement;
  video: HTMLVideoElement;
  visible: boolean;
};

/**
 * Voz por proximidade + compartilhamento de tela (LiveKit, sala unica).
 * - Audio: volume por distancia/zona (setVolume por participante).
 * - Tela: painel flutuante (overlay), mostrado conforme a regra da cena.
 * - Conexao e microfone desacoplados: da pra compartilhar tela sem falar.
 */
export class VoiceManager {
  private room?: Room;
  private tracks = new Map<string, RemoteAudioTrack>();
  private els = new Map<string, HTMLMediaElement>();
  private shares = new Map<string, ShareEntry>();
  private sharePanel?: HTMLDivElement;
  connected = false;
  micEnabled = false;
  sharing = false;

  /** Conecta na sala LiveKit (sem ligar o microfone). */
  async connect(identity: string, displayName: string): Promise<void> {
    if (this.connected) return;
    const resp = await fetch(
      `${SERVER_HTTP_URL}/token?identity=${encodeURIComponent(identity)}&name=${encodeURIComponent(displayName)}`,
    );
    if (!resp.ok) throw new Error(`token HTTP ${resp.status}`);
    const data = (await resp.json()) as { token?: string; url?: string; error?: string };
    if (!data.token || !data.url) throw new Error(data.error ?? "token/url ausente");

    const room = new Room({ adaptiveStream: true, dynacast: true });

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, p: RemoteParticipant) => {
      if (track.kind === Track.Kind.Audio) {
        const at = track as RemoteAudioTrack;
        this.tracks.set(p.identity, at);
        const el = at.attach();
        el.style.display = "none";
        document.body.appendChild(el);
        this.els.set(p.identity, el);
        at.setVolume(0);
      } else if (track.kind === Track.Kind.Video && track.source === Track.Source.ScreenShare) {
        this.addShare(p.identity, p.name || "Alguém", track as RemoteVideoTrack);
      }
    });

    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _pub, p: RemoteParticipant) => {
      if (track.kind === Track.Kind.Audio) {
        this.els.get(p.identity)?.remove();
        this.els.delete(p.identity);
        this.tracks.delete(p.identity);
      } else if (track.source === Track.Source.ScreenShare) {
        this.removeShare(p.identity);
      }
    });

    room.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
      this.els.get(p.identity)?.remove();
      this.els.delete(p.identity);
      this.tracks.delete(p.identity);
      this.removeShare(p.identity);
    });

    room.on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
      if (pub.source === Track.Source.ScreenShare) this.sharing = false;
    });

    await room.connect(data.url, data.token);
    this.room = room;
    this.connected = true;
  }

  async setMicEnabled(on: boolean): Promise<void> {
    this.micEnabled = on;
    if (this.room) await this.room.localParticipant.setMicrophoneEnabled(on);
  }

  async startScreenShare(): Promise<boolean> {
    if (!this.room) return false;
    try {
      await this.room.localParticipant.setScreenShareEnabled(true, { audio: false });
      this.sharing = this.room.localParticipant.isScreenShareEnabled;
      return this.sharing;
    } catch {
      this.sharing = false;
      return false;
    }
  }

  async stopScreenShare(): Promise<void> {
    if (this.room) await this.room.localParticipant.setScreenShareEnabled(false);
    this.sharing = false;
  }

  /** Volume (0..1) por participante, calculado pela cena (proximidade/zona). */
  applyGains(gainFor: (identity: string) => number): void {
    if (!this.connected) return;
    this.tracks.forEach((track, id) => {
      track.setVolume(Math.max(0, Math.min(1, gainFor(id))));
    });
  }

  /** Mostra/esconde cada tela compartilhada conforme a regra da cena. */
  applyShareVisibility(shouldShow: (identity: string) => boolean): void {
    let any = false;
    this.shares.forEach((s, id) => {
      const show = shouldShow(id);
      if (show !== s.visible) {
        s.visible = show;
        s.card.style.display = show ? "block" : "none";
      }
      any = any || s.visible;
    });
    if (this.sharePanel) this.sharePanel.style.display = any ? "flex" : "none";
  }

  speakingIds(): Set<string> {
    const ids = new Set<string>();
    if (this.room) {
      for (const p of this.room.remoteParticipants.values()) if (p.isSpeaking) ids.add(p.identity);
      if (this.room.localParticipant.isSpeaking) ids.add(this.room.localParticipant.identity);
    }
    return ids;
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
    this.shares.forEach((s) => {
      try {
        s.track.detach();
      } catch {
        /* ignore */
      }
      s.card.remove();
    });
    this.shares.clear();
    this.sharePanel?.remove();
    this.sharePanel = undefined;
    this.connected = false;
    this.micEnabled = false;
    this.sharing = false;
  }

  // ---- painel de telas (overlay HTML) ----

  private ensureSharePanel(): HTMLDivElement {
    if (!this.sharePanel) {
      const p = document.createElement("div");
      p.style.cssText =
        "position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:9999;" +
        "display:none;flex-direction:column;align-items:center;max-width:66vw;";
      document.body.appendChild(p);
      this.sharePanel = p;
    }
    return this.sharePanel;
  }

  private addShare(id: string, name: string, track: RemoteVideoTrack): void {
    this.removeShare(id);
    const panel = this.ensureSharePanel();
    const card = document.createElement("div");
    card.style.cssText =
      "background:#15131d;border:2px solid #5a4a2a;border-radius:10px;padding:8px;" +
      "margin-bottom:8px;box-shadow:0 6px 24px #000c;display:none;";
    const header = document.createElement("div");
    header.style.cssText =
      "font:13px monospace;color:#f0e6c8;display:flex;justify-content:space-between;" +
      "align-items:center;gap:12px;margin-bottom:6px;";
    const title = document.createElement("span");
    title.textContent = "🖥️ " + name + " está compartilhando";
    const fsBtn = document.createElement("button");
    fsBtn.textContent = "⛶ Tela cheia";
    fsBtn.style.cssText =
      "font:12px monospace;cursor:pointer;background:#2a7a3a;color:#fff;border:none;" +
      "border-radius:6px;padding:4px 10px;";
    header.append(title, fsBtn);
    const video = track.attach() as HTMLVideoElement;
    video.muted = true;
    video.style.cssText =
      "display:block;width:760px;max-width:64vw;max-height:64vh;border-radius:6px;" +
      "background:#000;cursor:pointer;";
    const fs = () => {
      const pr = video.requestFullscreen?.();
      if (pr && typeof pr.catch === "function") pr.catch(() => {});
    };
    fsBtn.onclick = fs;
    video.onclick = fs;
    card.append(header, video);
    panel.appendChild(card);
    this.shares.set(id, { track, card, video, visible: false });
  }

  private removeShare(id: string): void {
    const s = this.shares.get(id);
    if (!s) return;
    try {
      s.track.detach();
    } catch {
      /* ignore */
    }
    s.card.remove();
    this.shares.delete(id);
    if (this.sharePanel) {
      const any = Array.from(this.shares.values()).some((x) => x.visible);
      this.sharePanel.style.display = any ? "flex" : "none";
    }
  }
}
