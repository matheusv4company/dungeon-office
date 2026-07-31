/**
 * F8 (Update V2): captura de fala pro escriba de reuniões — Web Speech API.
 *
 * PRIVACIDADE (dizendo a verdade): no Chrome/Edge a Web Speech API envia o áudio
 * captado pro serviço de fala do PRÓPRIO NAVEGADOR (Google/Microsoft) pra
 * reconhecimento — é assim que a API funciona. O que NUNCA acontece: áudio ir pro
 * NOSSO servidor — pra lá vai só o TEXTO final. A captura só fica ativa quando a
 * cena manda (dentro de sala de reunião, com voz ligada e sem pausa manual), e o
 * badge "🔴 transcrevendo" deixa o estado visível o tempo todo.
 *
 * Robustez: resultados finais de uma mesma rajada são JUNTADOS num único onText
 * (o servidor tem anti-flood — mandar N mensagens em ms perderia falas); o restart
 * automático usa backoff (300ms→5s) e erros fatais de permissão desligam de vez.
 */

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
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

// erros que não adianta re-tentar (permissão negada) — desliga até o usuário agir
const FATAL_ERRORS = new Set(["not-allowed", "service-not-allowed"]);

export class SpeechScribe {
  /** Recebe o texto FINAL transcrito (rajadas já vêm juntas numa string só). */
  onText?: (text: string) => void;
  private rec: SpeechRecognitionLike | null = null;
  private active = false;
  private restartDelay = 300; // backoff: 300ms → 5s; volta a 300ms quando chega texto
  private restartTimer: number | undefined;
  private fatal = false;

  supported(): boolean {
    return recognitionCtor() !== null;
  }

  /** Liga/desliga a captura (idempotente). A cena chama conforme a elegibilidade. */
  setActive(on: boolean): void {
    if (on === this.active) return;
    if (on && this.fatal) return; // permissão negada: não insiste (badge avisa via cena)
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
      this.restartDelay = 300; // fluindo de novo: zera o backoff
      // junta TODOS os finais da rajada num envio só (o anti-flood do servidor
      // descartaria mensagens em sequência de ms)
      const parts: string[] = [];
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r?.isFinal) {
          const text = String(r[0]?.transcript ?? "").trim();
          if (text) parts.push(text);
        }
      }
      if (parts.length) this.onText?.(parts.join(" "));
    };
    // o motor para sozinho (silêncio/erro) — religa com backoff enquanto ativo
    rec.onend = () => {
      if (!this.active || this.rec !== rec) return;
      this.rec = null;
      const delay = this.restartDelay;
      this.restartDelay = Math.min(this.restartDelay * 2, 5000);
      this.restartTimer = window.setTimeout(() => {
        this.restartTimer = undefined;
        if (this.active) this.start();
      }, delay);
    };
    rec.onerror = (ev) => {
      if (FATAL_ERRORS.has(String(ev?.error ?? ""))) {
        this.fatal = true;
        this.active = false;
        this.rec = null;
        try {
          rec.stop();
        } catch {
          /* ignore */
        }
      }
      /* demais erros: o onend cuida do restart com backoff */
    };
    this.rec = rec;
    try {
      rec.start();
    } catch {
      this.rec = null; // estado inválido momentâneo — onend/backoff não vai rodar; a
      this.active = false; // próxima avaliação da cena tenta de novo
    }
  }

  private stop(): void {
    if (this.restartTimer !== undefined) {
      window.clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
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
