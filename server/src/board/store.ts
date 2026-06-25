import { promises as fs, mkdirSync, writeFileSync, renameSync } from "fs";
import * as path from "path";

/** Dados crus de um card persistido. */
export type TaskData = {
  id: string;
  title: string;
  desc: string;
  assignee: string;
  client: string;
  due: string;
  col: string;
  order: number;
  archived: boolean;
};

export type ClientColor = { name: string; color: string };
export type BoardData = { tasks: TaskData[]; clients: ClientColor[] };

// Em producao a CWD do servidor e /app (Dockerfile), entao /app/data — onde o
// Coolify monta o volume persistente. Em dev cai em <cwd>/data. Override por env.
const DIR = process.env.BOARD_DIR || path.join(process.cwd(), "data");
const FILE = path.join(DIR, "board.json");

/** Le o board do disco (board vazio se ainda nao existir). */
export async function loadBoard(): Promise<BoardData> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const data = JSON.parse(raw) as Partial<BoardData>;
    return {
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
      clients: Array.isArray(data.clients) ? data.clients : [],
    };
  } catch {
    return { tasks: [], clients: [] };
  }
}

let timer: NodeJS.Timeout | null = null;
let pending: BoardData | null = null;

/** Salva o board com debounce (400ms) + escrita atomica (tmp + rename). */
export function saveBoard(data: BoardData): void {
  pending = data;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const d = pending;
    pending = null;
    if (!d) return;
    void (async () => {
      try {
        await fs.mkdir(DIR, { recursive: true });
        const tmp = `${FILE}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(d, null, 2), "utf8");
        await fs.rename(tmp, FILE); // troca atomica: nunca deixa o board pela metade
      } catch (e) {
        console.error("[board] erro ao salvar:", e);
      }
    })();
  }, 400);
}

/**
 * Grava IMEDIATAMENTE (sincrono) o que estiver pendente no debounce.
 * Pra usar no shutdown da sala — senao as ultimas edicoes (dentro da janela
 * de 400ms) se perdem quando o processo reinicia (ex: redeploy do Coolify).
 */
export function flushBoardSync(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const d = pending;
  pending = null;
  if (!d) return;
  try {
    mkdirSync(DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(d, null, 2), "utf8");
    renameSync(tmp, FILE);
  } catch (e) {
    console.error("[board] erro ao salvar (flush):", e);
  }
}
