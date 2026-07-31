/**
 * F8 (Update V2): captura de fala pro escriba de reuniões — Web Speech API.
 *
 * PRIVACIDADE: o áudio NUNCA sai do navegador. O reconhecimento roda local/no motor
 * do Chrome e só o TEXTO final é entregue ao onText (que a cena envia ao servidor).
 * Só fica ativo enquanto a cena mandar (dentro de sala de reunião, com voz ligada e
 * sem pausa manual). Suporte: Chrome/Edge (webkitSpeechRecognition); em navegadores
 * sem suporte, supported() = false e a cena avisa o usuário.
 */

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
};
type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0?: { transcript?: string } }>;
};

function recognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export class SpeechScribe {
  /** Recebe cada frase FINAL transcrita (a cena manda pro servidor). */
  onText?: (text: string) => void;
  private rec: SpeechRecognitionLike | null = null;
  private active = false;

  supported(): boolean {
    return recognitionCtor() !== null;
  }

  /** Liga/desliga a captura (idempotente). A cena chama conforme a elegibilidade. */
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    if (on) this.start();
    else this.stop();
  }

  isActive(): boolean {
    return this.active;
  }

  private start(): void {
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    let rec: SpeechRecognitionLike;
    try {
      rec = new Ctor();
    } catch {
      return;
    }
    rec.lang = "pt-BR";
    rec.continuous = true;
    rec.interimResults = false; // só frases FINAIS (menos ruído, menos tráfego)
    rec.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r?.isFinal) {
          const text = String(r[0]?.transcript ?? "").trim();
          if (text) this.onText?.(text);
        }
      }
    };
    // o motor para sozinho em silêncio longo — religa enquanto a cena quiser ativo
    rec.onend = () => {
      if (this.active && this.rec === rec) {
        try {
          rec.start();
        } catch {
          /* estado inválido momentâneo: o próximo setActive(true) da cena recomeça */
          this.rec = null;
          this.active = false;
        }
      }
    };
    rec.onerror = () => {
      /* onend cuida do restart; erros fatais derrubam via onend */
    };
    this.rec = rec;
    try {
      rec.start();
    } catch {
      this.rec = null;
      this.active = false;
    }
  }

  private stop(): void {
    const rec = this.rec;
    this.rec = null;
    if (rec) {
      rec.onend = null; // sem auto-restart
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    }
  }
}
