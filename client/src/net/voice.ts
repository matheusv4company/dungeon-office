import { Room, RoomEvent, Track } from "livekit-client";
import type {
  LocalTrackPublication,
  RemoteAudioTrack,
  RemoteParticipant,
  RemoteTrack,
  RemoteVideoTrack,
} from "livekit-client";
import { SERVER_HTTP_URL } from "./room";
import { getFlags } from "./config";

export type Vec = { x: number; y: number };
export type MicDevice = { deviceId: string; label: string };

type ShareEntry = {
  track: RemoteVideoTrack;
  card: HTMLDivElement;
  video: HTMLVideoElement;
  title: HTMLSpanElement;
  name: string;
  visible: boolean;
  minimized: boolean;
};

const LS_MIC = "ev_micDeviceId";

/**
 * Voz por proximidade + compartilhamento de tela (LiveKit, sala unica).
 * - Audio: volume por distancia/zona; auto-mute fica a cargo da cena.
 * - Tela: painel flutuante (overlay); inclui a propria tela de quem compartilha.
 * - Microfone: device selecionavel (lembrado em localStorage).
 */
export class VoiceManager {
  private room?: Room;
  private tracks = new Map<string, RemoteAudioTrack>();
  private els = new Map<string, HTMLMediaElement>();
  private shares = new Map<string, ShareEntry>();
  // F3: áudio do compartilhamento de tela — FORA do fade de proximidade (toca cheio
  // pra quem está vendo o share; a entrega da track já é gated pelo motor da F1).
  private shareAudioEls = new Map<string, HTMLMediaElement>();
  private sharePanel?: HTMLDivElement;
  private selfShare?: { card: HTMLDivElement; video: HTMLVideoElement };
  private micDeviceId: string | undefined = (() => {
    try {
      return localStorage.getItem(LS_MIC) || undefined;
    } catch {
      return undefined;
    }
  })();
  connected = false;
  micEnabled = false;
  sharing = false;
  private connectedIdentity?: string; // identidade no LiveKit (= sessionId atual do Colyseus)
  /**
   * F1: chamado quando a voz fica pronta (connect E reconexões do LiveKit). A cena
   * usa pra mandar "voice:ready" pro servidor ressincronizar as assinaturas de áudio.
   */
  onReady?: () => void;

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
      if (track.source === Track.Source.ScreenShareAudio) {
        // F3: áudio do share — toca CHEIO (não passa pelo fade de proximidade da voz);
        // a entrega da track já é decidida pelo motor de audibilidade do servidor.
        const el = track.attach();
        el.style.display = "none";
        document.body.appendChild(el);
        this.shareAudioEls.set(p.identity, el);
        this.markShareAudio(p.identity, true);
      } else if (track.kind === Track.Kind.Audio) {
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
      if (track.source === Track.Source.ScreenShareAudio) {
        this.shareAudioEls.get(p.identity)?.remove();
        this.shareAudioEls.delete(p.identity);
        this.markShareAudio(p.identity, false);
      } else if (track.kind === Track.Kind.Audio) {
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
      this.shareAudioEls.get(p.identity)?.remove();
      this.shareAudioEls.delete(p.identity);
      this.removeShare(p.identity);
    });

    room.on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
      if (pub.source === Track.Source.ScreenShare) {
        this.sharing = false;
        this.hideSelfShare();
      }
    });

    // reconexão do LiveKit (rede piscou): o servidor precisa re-aplicar as assinaturas
    room.on(RoomEvent.Reconnected, () => this.onReady?.());

    await room.connect(data.url, data.token);
    this.room = room;
    this.connected = true;
    this.connectedIdentity = identity;
    this.onReady?.();
  }

  getIdentity(): string | undefined {
    return this.connectedIdentity;
  }

  /** Reconecta a voz com uma nova identidade (apos o Colyseus trocar o sessionId). */
  async reconnect(identity: string, displayName: string): Promise<void> {
    this.disconnect();
    await this.connect(identity, displayName);
  }

  async setMicEnabled(on: boolean): Promise<void> {
    this.micEnabled = on;
    if (this.room) {
      await this.room.localParticipant.setMicrophoneEnabled(
        on,
        on && this.micDeviceId ? { deviceId: this.micDeviceId } : undefined,
      );
    }
  }

  /** Lista os microfones disponiveis (rotulos so aparecem apos permissao). */
  async listMics(): Promise<MicDevice[]> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter((d) => d.kind === "audioinput")
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microfone ${i + 1}` }));
    } catch {
      return [];
    }
  }

  getMicDeviceId(): string | undefined {
    return this.micDeviceId;
  }

  async setMicDevice(deviceId: string): Promise<void> {
    this.micDeviceId = deviceId;
    try {
      localStorage.setItem(LS_MIC, deviceId);
    } catch {
      /* ignore */
    }
    if (this.room) {
      try {
        await this.room.switchActiveDevice("audioinput", deviceId);
      } catch {
        /* ignore */
      }
    }
  }

  async startScreenShare(): Promise<boolean> {
    if (!this.room) return false;
    try {
      // Qualidade desde o 1o segundo (menos "pixelado por 10s"):
      // - contentHint "detail" → encoder prioriza nitidez (texto) em vez de fluidez;
      // - sem simulcast → publica direto na camada cheia (sem comecar na baixa);
      // - bitrate alto + maintain-resolution → preserva a resolucao sob banda apertada,
      //   derrubando FPS (tela e quase estatica) em vez de borrar a imagem.
      await this.room.localParticipant.setScreenShareEnabled(
        true,
        // F3: com o flag ligado, pede também o ÁUDIO (aba do Chrome / sistema no Windows).
        // Se o usuário não marcar "compartilhar áudio", só o vídeo é publicado — sem erro.
        { audio: getFlags().shareAudio, systemAudio: "include", contentHint: "detail" },
        {
          simulcast: false,
          degradationPreference: "maintain-resolution",
          screenShareEncoding: { maxBitrate: 4_000_000, maxFramerate: 15 },
        },
      );
      this.sharing = this.room.localParticipant.isScreenShareEnabled;
      if (this.sharing) this.showSelfShare();
      return this.sharing;
    } catch {
      this.sharing = false;
      return false;
    }
  }

  async stopScreenShare(): Promise<void> {
    if (this.room) await this.room.localParticipant.setScreenShareEnabled(false);
    this.sharing = false;
    this.hideSelfShare();
  }

  applyGains(gainFor: (identity: string) => number): void {
    if (!this.connected) return;
    this.tracks.forEach((track, id) => {
      track.setVolume(Math.max(0, Math.min(1, gainFor(id))));
    });
  }

  /**
   * Solta a faixa de um participante imediatamente (silencia + desanexa), sem
   * esperar o timeout do LiveKit. Usado quando o Colyseus ja removeu o jogador —
   * evita faixa-zumbi tocando depois que a pessoa saiu.
   */
  dropTrack(id: string): void {
    this.tracks.get(id)?.setVolume(0);
    this.els.get(id)?.remove();
    this.els.delete(id);
    this.tracks.delete(id);
    this.shareAudioEls.get(id)?.remove();
    this.shareAudioEls.delete(id);
  }

  applyShareVisibility(shouldShow: (identity: string) => boolean): void {
    this.shares.forEach((s, id) => {
      const show = shouldShow(id);
      if (show !== s.visible) {
        s.visible = show;
        s.card.style.display = show ? "block" : "none";
      }
    });
    // F3: "quem VÊ o share, ouve o share" — áudio do share muta junto com o card.
    this.shareAudioEls.forEach((el, id) => {
      const s = this.shares.get(id);
      (el as HTMLAudioElement).muted = !(s?.visible ?? false);
    });
    this.updatePanelDisplay();
  }

  /**
   * Algum compartilhamento de tela esta visivel E expandido? (pra bloquear cliques
   * "atras" no roster). Minimizado NAO conta — quem minimiza quer usar o escritorio.
   */
  hasVisibleShare(): boolean {
    for (const s of this.shares.values()) if (s.visible && !s.minimized) return true;
    return false;
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
    this.shareAudioEls.forEach((el) => el.remove());
    this.shareAudioEls.clear();
    this.shares.forEach((s) => {
      try {
        s.track.detach();
      } catch {
        /* ignore */
      }
      s.card.remove();
    });
    this.shares.clear();
    this.selfShare?.card.remove();
    this.selfShare = undefined;
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

  private updatePanelDisplay(): void {
    if (!this.sharePanel) return;
    const any = Array.from(this.shares.values()).some((s) => s.visible);
    this.sharePanel.style.display = any ? "flex" : "none";
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
    title.textContent =
      "🖥️ " + name + " está compartilhando" + (this.shareAudioEls.has(id) ? " 🔊" : "");
    const fsBtn = document.createElement("button");
    fsBtn.textContent = "⛶ Tela cheia";
    fsBtn.style.cssText =
      "font:12px monospace;cursor:pointer;background:#2a7a3a;color:#fff;border:none;" +
      "border-radius:6px;padding:4px 10px;";
    const video = track.attach() as HTMLVideoElement;
    video.muted = true;
    video.style.cssText =
      "display:block;width:760px;max-width:64vw;max-height:64vh;border-radius:6px;" +
      "background:#000;cursor:pointer;";
    // minimizar: quem ve pode encolher (some o video, fica so a barra do titulo)
    const minBtn = document.createElement("button");
    minBtn.textContent = "🗕";
    minBtn.title = "Minimizar";
    minBtn.style.cssText =
      "font:12px monospace;cursor:pointer;background:#3a3340;color:#fff;border:none;" +
      "border-radius:6px;padding:4px 10px;";
    minBtn.onclick = () => {
      const min = video.style.display !== "none"; // visivel agora -> vai minimizar
      video.style.display = min ? "none" : "block";
      fsBtn.style.display = min ? "none" : ""; // "tela cheia" nao faz sentido minimizado
      minBtn.textContent = min ? "🗖" : "🗕";
      minBtn.title = min ? "Expandir" : "Minimizar";
      const e = this.shares.get(id);
      if (e) e.minimized = min; // minimizado nao bloqueia cliques no roster (hasVisibleShare)
    };
    header.append(title, minBtn, fsBtn);
    const fs = () => {
      const pr = video.requestFullscreen?.();
      if (pr && typeof pr.catch === "function") pr.catch(() => {});
    };
    fsBtn.onclick = fs;
    video.onclick = fs;
    card.append(header, video);
    panel.appendChild(card);
    this.shares.set(id, { track, card, video, title, name, visible: false, minimized: false });
  }

  /** F3: liga/desliga o indicador 🔊 no card do share (áudio pode chegar antes/depois do vídeo). */
  private markShareAudio(id: string, hasAudio: boolean): void {
    const s = this.shares.get(id);
    if (!s) return;
    s.title.textContent = "🖥️ " + s.name + " está compartilhando" + (hasAudio ? " 🔊" : "");
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
    this.updatePanelDisplay();
  }

  // ---- self-view: quem compartilha ve a propria tela ----

  // PiP pequeno no canto: quem compartilha so precisa confirmar que esta no ar,
  // sem cobrir o escritorio (nao abre aba nem rouba o foco do trabalho).
  private showSelfShare(): void {
    const pub = this.room?.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    const track = pub?.videoTrack;
    if (!track) return;
    this.hideSelfShare();
    const card = document.createElement("div");
    card.style.cssText =
      "position:fixed;right:12px;bottom:12px;z-index:9998;background:#15131d;" +
      "border:2px solid #2a7a3a;border-radius:9px;padding:5px;box-shadow:0 4px 16px #000b;";
    const header = document.createElement("div");
    header.style.cssText =
      "font:10px monospace;color:#9fe6b0;margin-bottom:3px;text-align:center;";
    header.textContent = "🖥️ compartilhando";
    const video = track.attach() as HTMLVideoElement;
    video.muted = true;
    video.style.cssText =
      "display:block;width:180px;max-width:34vw;border-radius:4px;background:#000;";
    card.append(header, video);
    document.body.appendChild(card);
    this.selfShare = { card, video };
  }

  private hideSelfShare(): void {
    if (!this.selfShare) return;
    this.selfShare.card.remove();
    this.selfShare = undefined;
  }
}
