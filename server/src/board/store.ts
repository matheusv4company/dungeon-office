import { promises as fs } from "fs";
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
};

// Em producao a CWD do servidor e /app (Dockerfile), entao /app/data — onde o
// Coolify monta o volume persistente. Em dev cai em <cwd>/data. Override por env.
const DIR = process.env.BOARD_DIR || path.join(process.cwd(), "data");
const FILE = path.join(DIR, "board.json");

/** Le o board do disco (board vazio se ainda nao existir). */
export async function loadTasks(): Promise<TaskData[]> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const data = JSON.parse(raw) as { tasks?: TaskData[] };
    return Array.isArray(data.tasks) ? data.tasks : [];
  } catch {
    return [];
  }
}

let timer: NodeJS.Timeout | null = null;
let pending: TaskData[] | null = null;

/** Salva o board com debounce (400ms) + escrita atomica (tmp + rename). */
export function saveTasks(tasks: TaskData[]): void {
  pending = tasks;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const data = pending;
    pending = null;
    if (!data) return;
    void (async () => {
      try {
        await fs.mkdir(DIR, { recursive: true });
        const tmp = `${FILE}.tmp`;
        await fs.writeFile(tmp, JSON.stringify({ tasks: data }, null, 2), "utf8");
        await fs.rename(tmp, FILE); // troca atomica: nunca deixa o board pela metade
      } catch (e) {
        console.error("[board] erro ao salvar:", e);
      }
    })();
  }, 400);
}
