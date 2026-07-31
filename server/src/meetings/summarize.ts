/**
 * F8 (Update V2): resumo da reunião + extração de tarefas via Haiku.
 * Mesma disciplina do aiReview: NUNCA lança, degrada devolvendo null, chave só do
 * ambiente e jamais logada. Também persiste um log das atas em meetings.json (volume),
 * com o mesmo padrão de escrita atômica do board.
 */
import { mkdirSync, writeFileSync, renameSync, readFileSync } from "fs";
import * as path from "path";
import type { Utterance } from "./scribe";

const MODEL = "claude-haiku-4-5-20251001"; // mesmo modelo aprovado do aiReview

export type AtaTarefa = { titulo: string; responsavel: string; due: string };
export type Ata = { resumo: string; decisoes: string[]; tarefas: AtaTarefa[] };

/**
 * Resume o transcript e extrai decisões + tarefas acionáveis. null em qualquer falha
 * (sem chave, API fora, parse) — quem chama simplesmente não cria a ata.
 */
export async function summarizeMeeting(utterances: Utterance[]): Promise<Ata | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });
    const transcript = utterances
      .map((u) => `${u.who}: ${u.text}`)
      .join("\n")
      .slice(0, 60_000); // teto de contexto (reunião muito longa é truncada do início... do fim não)
    const system =
      "Voce e a secretaria de atas de uma agencia de marketing brasileira. Recebe a transcricao " +
      "automatica (imperfeita) de uma reuniao por voz do time. Produza APENAS um JSON valido:\n" +
      '{"resumo": "resumo fiel em 3-6 frases", "decisoes": ["decisao tomada", ...], ' +
      '"tarefas": [{"titulo": "acao concreta e curta", "responsavel": "nome de quem ficou responsavel ou vazio", "due": "YYYY-MM-DD ou vazio"}]}\n' +
      "REGRAS: so liste tarefas que alguem claramente se comprometeu a fazer (nao invente); " +
      "responsavel = o NOME dito na conversa (vazio se ambigel); due so se uma data/prazo foi dito; " +
      "a transcricao tem erros de reconhecimento — interprete com bom senso; se a conversa nao foi " +
      'uma reuniao de trabalho, devolva {"resumo": "", "decisoes": [], "tarefas": []}.';
    const resp = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 900,
        system,
        messages: [{ role: "user", content: `Transcricao da reuniao:\n\n${transcript}` }],
      },
      { timeout: 30_000, maxRetries: 1 },
    );
    const text = resp.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]) as Partial<Ata>;
    const tarefas = (Array.isArray(obj.tarefas) ? obj.tarefas : [])
      .map((t) => ({
        titulo: String((t as AtaTarefa)?.titulo ?? "").trim().slice(0, 180),
        responsavel: String((t as AtaTarefa)?.responsavel ?? "").trim().slice(0, 60),
        due: /^\d{4}-\d{2}-\d{2}$/.test(String((t as AtaTarefa)?.due ?? "")) ? String((t as AtaTarefa).due) : "",
      }))
      .filter((t) => t.titulo);
    return {
      resumo: String(obj.resumo ?? "").slice(0, 2000),
      decisoes: (Array.isArray(obj.decisoes) ? obj.decisoes : []).map((d) => String(d).slice(0, 300)).slice(0, 12),
      tarefas: tarefas.slice(0, 12),
    };
  } catch (e) {
    console.warn("[scribe] resumo indisponivel (degradando):", (e as Error)?.message ?? "erro");
    return null;
  }
}

// ---- log das atas (auditoria) — mesmo volume/padrão atômico do board ----
const DIR = process.env.BOARD_DIR || path.join(process.cwd(), "data");
const FILE = path.join(DIR, "meetings.json");

export type MeetingLogEntry = {
  startedAt: number;
  endedAt: number;
  zone: number;
  speakers: string[];
  utterances: number;
  ata: Ata;
};

/** Anexa uma ata ao log (escrita atômica; falha só loga — ata já foi pro board). */
export function appendMeetingLog(entry: MeetingLogEntry): void {
  try {
    let list: MeetingLogEntry[] = [];
    try {
      const raw = readFileSync(FILE, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) list = parsed as MeetingLogEntry[];
    } catch {
      /* sem arquivo ainda */
    }
    list.push(entry);
    if (list.length > 500) list = list.slice(-500); // trava de crescimento
    mkdirSync(DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(list, null, 2), "utf8");
    renameSync(tmp, FILE);
  } catch (e) {
    console.error("[scribe] erro ao gravar meetings.json:", e);
  }
}
