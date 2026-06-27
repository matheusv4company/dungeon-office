import { promises as fs, mkdirSync, writeFileSync, renameSync, readFileSync } from "fs";
import * as path from "path";
import { scryptSync, randomBytes, timingSafeEqual } from "crypto";

/**
 * Progresso de gamificacao por MEMBRO (chave estavel = nome normalizado), persistido
 * em progress.json no mesmo volume do board. Sobrevive a reconexao (sessionId muda).
 * Inclui o PIN (hash scrypt) pra identidade duravel sem texto plano.
 */
export type MemberProgress = {
  memberId: string; // chave normalizada (trim + lowercase do nome)
  displayName: string;
  pinHash: string; // "salt:hash" (scrypt); "" = ainda sem PIN
  xp: number;
  level: number;
  createdAt: number;
  lastLoginAt: number;
  schemaVersion: number;
};

type ProgressData = { members: Record<string, MemberProgress> };

const DIR = process.env.BOARD_DIR || path.join(process.cwd(), "data");
const FILE = path.join(DIR, "progress.json");
const SCHEMA_VERSION = 1;

let cache: ProgressData | null = null;

function load(): ProgressData {
  if (cache) return cache;
  try {
    const raw = readFileSync(FILE, "utf8");
    const data = JSON.parse(raw) as Partial<ProgressData>;
    cache = { members: data.members ?? {} };
  } catch {
    cache = { members: {} };
  }
  return cache;
}

// ---- gravacao com debounce + escrita atomica (mesmo padrao do board) ----
let timer: NodeJS.Timeout | null = null;
function scheduleSave() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    writeNow();
  }, 400);
}
function writeNow() {
  if (!cache) return;
  try {
    mkdirSync(DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
    renameSync(tmp, FILE);
  } catch (e) {
    console.error("[progress] erro ao salvar:", e);
  }
}
/** Grava na hora o que estiver pendente — chamar no onDispose (redeploy). */
export function flushProgressSync() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  writeNow();
}

// ---- PIN (scrypt salgado) ----
export function hashPin(pin: string): string {
  const salt = randomBytes(16).toString("hex");
  const h = scryptSync(pin, salt, 32).toString("hex");
  return `${salt}:${h}`;
}
function checkPin(stored: string, pin: string): boolean {
  const [salt, h] = stored.split(":");
  if (!salt || !h) return false;
  try {
    const c = scryptSync(pin, salt, 32).toString("hex");
    return timingSafeEqual(Buffer.from(h, "hex"), Buffer.from(c, "hex"));
  } catch {
    return false;
  }
}

export function normId(name: string): string {
  return name.trim().toLowerCase();
}

/** Progresso publico (sem o hash do PIN) pra mandar pro cliente. */
export type PublicProgress = Omit<MemberProgress, "pinHash">;
function publicView(m: MemberProgress): PublicProgress {
  const { pinHash: _omit, ...rest } = m;
  void _omit;
  return rest;
}

export function getMember(memberId: string): MemberProgress | undefined {
  return load().members[memberId];
}

export type LoginResult =
  | { ok: true; status: "created" | "ok"; member: PublicProgress }
  | { ok: false; status: "invalid" | "wrong" };

/**
 * Login por nome + PIN. 1o acesso DEFINE o PIN (status "created"); depois CONFERE.
 * PIN >= 4 digitos. Nunca devolve o hash.
 */
export function login(name: string, pin: string): LoginResult {
  const memberId = normId(name);
  if (!memberId || !/^\d{4,8}$/.test(pin)) return { ok: false, status: "invalid" };
  const data = load();
  let m = data.members[memberId];
  if (!m) {
    m = {
      memberId,
      displayName: name.trim().slice(0, 16),
      pinHash: hashPin(pin),
      xp: 0,
      level: 1,
      createdAt: Date.now(),
      lastLoginAt: Date.now(),
      schemaVersion: SCHEMA_VERSION,
    };
    data.members[memberId] = m;
    scheduleSave();
    return { ok: true, status: "created", member: publicView(m) };
  }
  // membro existe mas nunca setou PIN (ex.: veio so do board) -> define agora
  if (!m.pinHash) {
    m.pinHash = hashPin(pin);
    m.lastLoginAt = Date.now();
    scheduleSave();
    return { ok: true, status: "created", member: publicView(m) };
  }
  if (checkPin(m.pinHash, pin)) {
    m.lastLoginAt = Date.now();
    scheduleSave();
    return { ok: true, status: "ok", member: publicView(m) };
  }
  return { ok: false, status: "wrong" };
}
