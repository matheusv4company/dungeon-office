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

export type AtaTarefa = { titulo: string; responsavel: string; due: string; cliente: string };
export type Ata = { resumo: string; decisoes: string[]; tarefas: AtaTarefa[] };

/**
 * Resume o transcript e extrai decisões + tarefas acionáveis. null em qualquer falha
 * (sem chave, API fora, parse) — quem chama simplesmente não cria a ata.
 * `knownMembers`/`knownClients` = nomes REGISTRADOS no quadro: o modelo só pode usar
 * esses (o servidor ainda revalida via normId — nome inventado vira vazio).
 */
export async function summarizeMeeting(
  utterances: Utterance[],
  knownMembers: string[] = [],
  knownClients: string[] = [],
): Promise<Ata | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });
    // teto de contexto: mantém o FIM (decisões/tarefas concentram no final da reunião)
    const transcript = utterances
      .map((u) => `${u.who}: ${u.text}`)
      .join("\n")
      .slice(-60_000);
    // âncora temporal no fuso do time: sem isso, "amanhã"/"sexta que vem" viram data
    // ALUCINADA pelo modelo (contra a regra da casa de nunca inventar premissa)
    const agora = new Date();
    const hojeISO = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(agora);
    const diaSemana = new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      weekday: "long",
    }).format(agora);
    const system =
      `HOJE e ${diaSemana}, ${hojeISO} (fuso America/Sao_Paulo). Use isso pra resolver prazos relativos ("amanha", "sexta"). ` +
      "Voce e a secretaria de atas de uma agencia de marketing brasileira. Recebe a transcricao " +
      "automatica (imperfeita) de uma reuniao por voz do time. Produza APENAS um JSON valido:\n" +
      '{"resumo": "resumo fiel em 3-6 frases", "decisoes": ["decisao tomada", ...], ' +
      '"tarefas": [{"titulo": "acao concreta e curta", "responsavel": "nome de quem ficou responsavel ou vazio", ' +
      '"cliente": "cliente da tarefa ou vazio", "due": "YYYY-MM-DD ou vazio"}]}\n' +
      `MEMBROS registrados (unicos valores validos pra "responsavel"): ${knownMembers.join(", ") || "(nenhum)"}. ` +
      `CLIENTES registrados (unicos valores validos pra "cliente"): ${knownClients.join(", ") || "(nenhum)"}.\n` +
      "REGRAS: so liste tarefas que alguem claramente se comprometeu a fazer (nao invente); " +
      "responsavel = o NOME dito na conversa (vazio se ambiguo); cliente SO se a tarefa foi claramente " +
      "associada a um cliente registrado na conversa (vazio se nao mencionaram cliente); " +
      "due so se uma data/prazo foi dito; " +
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
    const json = extractJson(text);
    if (!json) return null;
    const obj = JSON.parse(json) as Partial<Ata>;
    const tarefas = (Array.isArray(obj.tarefas) ? obj.tarefas : [])
      .map((t) => ({
        titulo: String((t as AtaTarefa)?.titulo ?? "").trim().slice(0, 180),
        responsavel: String((t as AtaTarefa)?.responsavel ?? "").trim().slice(0, 60),
        cliente: String((t as AtaTarefa)?.cliente ?? "").trim().slice(0, 60),
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

/**
 * Extrai o PRIMEIRO objeto JSON balanceado do texto (respeitando strings/escapes).
 * A regex gulosa antiga podia casar lixo entre duas chaves e quebrar o parse com
 * texto adversarial vindo da transcrição (review V2).
 */
function extractJson(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      if (inStr) esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
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
  /** null = o resumo falhou (IA fora/timeout) — nesse caso `raw` preserva o transcript. */
  ata: Ata | null;
  raw?: Utterance[]; // transcript bruto, gravado SÓ quando a ata falhou (nada se perde)
};

/** Lê as últimas `limit` atas do log (mais recentes primeiro). Falha -> []. */
export function readMeetingLog(limit = 50): MeetingLogEntry[] {
  try {
    const raw = readFileSync(FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as MeetingLogEntry[]).slice(-limit).reverse();
  } catch {
    return []; // sem arquivo ainda / corrompido
  }
}

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
