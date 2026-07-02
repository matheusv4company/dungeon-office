import { promises as fs, mkdirSync, writeFileSync, renameSync, readFileSync } from "fs";
import * as path from "path";
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from "crypto";

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
  // --- F6: progressão PE/XP/nível ---
  weeks: Record<string, number>; // "YYYY-Www" -> PE creditado naquela semana (pro baseline)
  delivered: number; // total de entregas verificadas (lifetime)
  lastDeliveryAt: number; // ms da última entrega creditada
  createdAt: number;
  lastLoginAt: number;
  schemaVersion: number;
};

/** PE acumulado pra um membro que ainda NÃO logou (sem conta com PIN). Absorvido no 1º login. */
type PendingPE = { xp: number; delivered: number; weeks: Record<string, number>; lastDeliveryAt: number };

type ProgressData = {
  members: Record<string, MemberProgress>;
  pending?: Record<string, PendingPE>; // crédito à espera do 1º login do dono (anti-takeover #3)
  secret?: string; // segredo p/ assinar tokens de sessão (estável entre restarts)
};

const DIR = process.env.BOARD_DIR || path.join(process.cwd(), "data");
const FILE = path.join(DIR, "progress.json");
const SCHEMA_VERSION = 2;

let cache: ProgressData | null = null;

function load(): ProgressData {
  if (cache) return cache;
  try {
    const raw = readFileSync(FILE, "utf8");
    const data = JSON.parse(raw) as Partial<ProgressData>;
    cache = { members: data.members ?? {}, pending: data.pending ?? {}, secret: data.secret };
  } catch {
    cache = { members: {}, pending: {} };
  }
  if (!cache.pending) cache.pending = {};
  // migração defensiva: garante os campos do F6 em registros antigos (schemaVersion 1)
  for (const m of Object.values(cache.members)) {
    if (!m.weeks || typeof m.weeks !== "object") m.weeks = {};
    if (typeof m.delivered !== "number") m.delivered = 0;
    if (typeof m.lastDeliveryAt !== "number") m.lastDeliveryAt = 0;
    if (typeof m.xp !== "number") m.xp = 0;
    if (typeof m.level !== "number") m.level = 1;
    m.schemaVersion = SCHEMA_VERSION; // marca como migrado
  }
  // anti-takeover (#3): contas PRÉ-CRIADAS sem PIN mas com progresso (creditadas antes do dono
  // logar) viram "pending" — deixam de ser conta reivindicável por quem só digitar o nome. O PE
  // espera o 1º login legítimo (com PIN) daquele nome pra ser absorvido.
  for (const [id, m] of Object.entries(cache.members)) {
    if (!m.pinHash && (m.xp > 0 || m.delivered > 0)) {
      const pnd = (cache.pending[id] ??= { xp: 0, delivered: 0, weeks: {}, lastDeliveryAt: 0 });
      pnd.xp = r1(pnd.xp + m.xp);
      pnd.delivered += m.delivered;
      for (const [wk, v] of Object.entries(m.weeks)) pnd.weeks[wk] = r1((pnd.weeks[wk] ?? 0) + v);
      pnd.lastDeliveryAt = Math.max(pnd.lastDeliveryAt, m.lastDeliveryAt);
      delete cache.members[id];
    }
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

// ---- token de sessão (HMAC do memberId com o segredo do servidor) ----
// O /login emite o token só depois de conferir o PIN; o onAuth da sala valida. Assim a
// identidade no join vem de quem PROVOU o PIN, não de um memberId cru autoatribuído pelo cliente.
function serverSecret(): string {
  const data = load();
  if (!data.secret) {
    data.secret = randomBytes(32).toString("hex");
    writeNow(); // grava JÁ (não debounced): se cair antes do flush, todos os tokens virariam inválidos
  }
  return data.secret;
}
function sign(memberId: string): string {
  return createHmac("sha256", serverSecret()).update(memberId).digest("hex").slice(0, 32);
}
export function issueToken(memberId: string): string {
  return `${memberId}.${sign(memberId)}`;
}
/** Valida um token e devolve o memberId, ou null se inválido/forjado. */
export function verifyToken(token: string): string | null {
  const i = token.lastIndexOf("."); // o mac é hex (sem "."), então lastIndexOf separa mesmo com nome pontuado
  if (i <= 0) return null;
  const memberId = token.slice(0, i);
  const mac = token.slice(i + 1);
  const expected = sign(memberId);
  try {
    if (mac.length === expected.length && timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
      return memberId;
    }
  } catch {
    /* comprimentos diferentes / buffer inválido */
  }
  return null;
}

/** Absorve o PE pendente (creditado antes do dono logar) para a conta recém-criada. */
function absorbPending(data: ProgressData, m: MemberProgress) {
  const pnd = data.pending?.[m.memberId];
  if (!pnd) return;
  m.xp = r1(m.xp + pnd.xp);
  m.delivered += pnd.delivered;
  for (const [wk, v] of Object.entries(pnd.weeks)) m.weeks[wk] = r1((m.weeks[wk] ?? 0) + v);
  m.level = levelFromXp(m.xp);
  if (pnd.lastDeliveryAt > m.lastDeliveryAt) m.lastDeliveryAt = pnd.lastDeliveryAt;
  delete data.pending![m.memberId];
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

/** Nomes de exibição de todos os membros já registrados (pro autocomplete do login). */
export function listMemberNames(): string[] {
  return Object.values(load().members)
    .map((m) => m.displayName)
    .filter(Boolean);
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
      weeks: {},
      delivered: 0,
      lastDeliveryAt: 0,
      createdAt: Date.now(),
      lastLoginAt: Date.now(),
      schemaVersion: SCHEMA_VERSION,
    };
    data.members[memberId] = m;
    absorbPending(data, m); // herda o PE que chegou antes dele logar (anti-takeover #3)
    scheduleSave();
    return { ok: true, status: "created", member: publicView(m) };
  }
  // membro existe mas nunca setou PIN (ex.: registro sem progresso) -> define agora
  if (!m.pinHash) {
    m.pinHash = hashPin(pin);
    m.lastLoginAt = Date.now();
    absorbPending(data, m); // herda PE pendente daquele nome, se houver
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

// ============================ F6: progressão PE/XP/nível ============================

/** XP acumulado pra ATINGIR o nível L. Fórmula do RESEARCH: 40·(L-1)^1.35 (L1=0, L2=40, L3≈103). */
export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  return Math.round(40 * Math.pow(level - 1, 1.35));
}

/** Nível a partir do XP acumulado: maior L com xpForLevel(L) <= xp. Teto Lv50. */
export function levelFromXp(xp: number): number {
  let L = 1;
  while (L < 50 && xpForLevel(L + 1) <= xp) L++;
  return L;
}

/** Chave de semana (ano-Www) pra agrupar PE e calcular baseline. Simples (dia-do-ano/7). */
function weekKey(ts: number): string {
  const d = new Date(ts);
  const start = new Date(d.getFullYear(), 0, 1);
  const week = Math.floor((d.getTime() - start.getTime()) / (7 * 86400000)) + 1;
  return `${d.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

const r1 = (n: number) => Math.round(n * 10) / 10; // arredonda 1 casa

/** Visão do progresso pra HUD (própria pessoa). % é contra a PRÓPRIA média, nunca ranking. */
export type ProgressView = {
  xp: number;
  level: number;
  xpInLevel: number; // XP já feito dentro do nível atual
  xpToNext: number; // XP que falta pro próximo nível (0 no teto)
  weekPE: number; // PE creditado nesta semana
  baseline: number; // média das últimas (até 4) semanas anteriores
  pct: number; // weekPE / baseline em % (0 se sem baseline ainda)
  delivered: number; // entregas verificadas (lifetime)
};

function buildView(m: MemberProgress): ProgressView {
  const level = m.level;
  const base = xpForLevel(level);
  const next = level < 50 ? xpForLevel(level + 1) : base;
  const wk = weekKey(Date.now());
  const weekPE = r1(m.weeks[wk] ?? 0);
  // baseline = média das últimas até-4 semanas ANTERIORES (exclui a atual)
  const prev = Object.entries(m.weeks)
    .filter(([k]) => k !== wk)
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, 4)
    .map(([, v]) => v);
  const baseline = prev.length ? r1(prev.reduce((s, v) => s + v, 0) / prev.length) : 0;
  const pct = baseline > 0 ? Math.round((weekPE / baseline) * 100) : 0;
  return {
    xp: r1(m.xp),
    level,
    xpInLevel: r1(Math.max(0, m.xp - base)),
    xpToNext: next > base ? r1(next - base) : 0,
    weekPE,
    baseline,
    pct,
    delivered: m.delivered,
  };
}

/** Progresso de um membro pra HUD (undefined se não existe). */
export function getProgressView(memberId: string): ProgressView | undefined {
  const m = load().members[memberId];
  return m ? buildView(m) : undefined;
}

/**
 * Credita PE numa entrega Verificada. A IDEMPOTÊNCIA é de quem chama (Task.scoreAwarded).
 * Membro REGISTRADO (com PIN) recebe direto; quem ainda NÃO logou tem o PE guardado em
 * "pending" (absorvido no 1º login) — assim não existe conta pré-criada sem PIN pra alguém
 * reivindicar só sabendo o nome (anti-takeover #3).
 */
export function awardPE(memberId: string, displayName: string, pe: number): ProgressView {
  const data = load();
  const m = data.members[memberId];
  if (m && m.pinHash) {
    if (displayName && (!m.displayName || m.displayName === m.memberId)) {
      m.displayName = displayName.trim().slice(0, 16);
    }
    m.xp = Math.max(0, r1(m.xp + pe));
    m.level = levelFromXp(m.xp);
    const wk = weekKey(Date.now());
    m.weeks[wk] = r1((m.weeks[wk] ?? 0) + pe);
    m.delivered += 1;
    m.lastDeliveryAt = Date.now();
    scheduleSave();
    return buildView(m);
  }
  // ainda não logou -> segura o PE em "pending" até o 1º login (com PIN) daquele nome
  const wk = weekKey(Date.now());
  const pending = (data.pending ??= {});
  const pnd = (pending[memberId] ??= { xp: 0, delivered: 0, weeks: {}, lastDeliveryAt: 0 });
  pnd.xp = r1(pnd.xp + pe);
  pnd.delivered += 1;
  pnd.weeks[wk] = r1((pnd.weeks[wk] ?? 0) + pe);
  pnd.lastDeliveryAt = Date.now();
  scheduleSave();
  const level = levelFromXp(pnd.xp);
  return { xp: r1(pnd.xp), level, xpInLevel: 0, xpToNext: 0, weekPE: r1(pnd.weeks[wk]), baseline: 0, pct: 0, delivered: pnd.delivered };
}

/** Semana atual (pra carimbar no Task a semana do crédito e estornar nela depois). */
export function currentWeekKey(): string {
  return weekKey(Date.now());
}

/**
 * Estorna PE (devolução = escrow revogado). Nível segue o XP (estágio de escrow, pré-aceite).
 * `week` = a semana em que o PE foi CREDITADO (carimbada no Task) — estorna NELA, não na atual,
 * pra não inflar a semana antiga nem zerar a corrente quando o estorno cruza a virada de semana.
 */
export function clawbackPE(memberId: string, pe: number, week?: string): ProgressView | undefined {
  const data = load();
  const wk = week || weekKey(Date.now());
  const m = data.members[memberId];
  if (m) {
    m.xp = Math.max(0, r1(m.xp - pe));
    m.level = levelFromXp(m.xp);
    if (m.weeks[wk]) m.weeks[wk] = Math.max(0, r1(m.weeks[wk] - pe));
    m.delivered = Math.max(0, m.delivered - 1);
    scheduleSave();
    return buildView(m);
  }
  // creditado enquanto pendente (dono ainda não logou) -> estorna do pending também
  const pnd = data.pending?.[memberId];
  if (pnd) {
    pnd.xp = Math.max(0, r1(pnd.xp - pe));
    if (pnd.weeks[wk]) pnd.weeks[wk] = Math.max(0, r1(pnd.weeks[wk] - pe));
    pnd.delivered = Math.max(0, pnd.delivered - 1);
    scheduleSave();
  }
  return undefined;
}
