import { mkdirSync, writeFileSync, renameSync, readFileSync } from "fs";
import * as path from "path";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

/**
 * Cofre de credenciais cifrado em repouso (AES-256-GCM), persistido em vault.json
 * no mesmo volume do board/progress. Segue o MESMO padrao de persistencia do
 * board/store.ts (debounce 400ms + escrita atomica tmp+rename + flush sync no
 * onDispose) e reaproveita o estilo de crypto do progress/store.ts.
 *
 * REGRA DE OURO (repetida no protocolo Colyseus): a senha NUNCA entra no schema
 * Colyseus nem em broadcast. O array de entradas vive fora do schema, em memoria
 * no servidor, e as senhas so saem via client.send pro solicitante. Este modulo
 * cuida so do disco: cifra antes de gravar, decifra ao ler, e NUNCA loga senha
 * nem a VAULT_KEY.
 */

/** Entrada crua do cofre (COM senha em texto plano — so em memoria/disco cifrado). */
export type VaultEntry = {
  id: string;
  group: string; // "ativo" | "desativado" | "headquarters" (string livre)
  client: string;
  service: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  updatedAt: number;
  updatedBy: string;
};

/** Versao publica: igual a VaultEntry porem SEM a senha, COM hasPassword. Vai pro cliente. */
export type EntryPub = Omit<VaultEntry, "password"> & { hasPassword: boolean };

// Mesmo volume do board (Coolify monta o persistente em <cwd>/data; override por env).
const DIR = process.env.BOARD_DIR || path.join(process.cwd(), "data");
const FILE = path.join(DIR, "vault.json");

// Formato no disco: JSON { v:1, iv, tag, ct } — tudo hex. ct = AES-256-GCM de
// JSON.stringify(entries). iv NOVO (12 bytes) a cada escrita; tag = authTag do GCM.
type VaultFile = { v: 1; iv: string; tag: string; ct: string };

/** Le a VAULT_KEY (64 hex = 32 bytes) e devolve o Buffer, ou null se ausente/invalida. */
function keyBuf(): Buffer | null {
  const k = process.env.VAULT_KEY;
  if (!k || !/^[0-9a-fA-F]{64}$/.test(k)) return null;
  return Buffer.from(k, "hex");
}

/** true se a VAULT_KEY existe e tem 64 chars hex validos (cofre operavel). */
export function vaultReady(): boolean {
  return keyBuf() !== null;
}

/**
 * Le e decifra o cofre do disco.
 * - sem arquivo  -> []  (cofre ainda nao criado)
 * - sem key      -> []  (cofre inoperante; nao ha o que decifrar)
 * - falha ao decifrar (tag invalida, arquivo corrompido, key errada) -> [] +
 *   console.error generico. NUNCA loga conteudo, chave ou detalhe do erro.
 */
export function loadVault(): VaultEntry[] {
  const key = keyBuf();
  if (!key) return [];
  let raw: string;
  try {
    raw = readFileSync(FILE, "utf8");
  } catch {
    return []; // sem arquivo
  }
  try {
    const file = JSON.parse(raw) as Partial<VaultFile>;
    if (!file || file.v !== 1 || !file.iv || !file.tag || !file.ct) {
      console.error("[vault] falha ao decifrar");
      return [];
    }
    const iv = Buffer.from(file.iv, "hex");
    const tag = Buffer.from(file.tag, "hex");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag); // se a tag nao bater, o final() abaixo lanca
    const plain = Buffer.concat([decipher.update(Buffer.from(file.ct, "hex")), decipher.final()]).toString("utf8");
    const arr = JSON.parse(plain) as unknown;
    return Array.isArray(arr) ? (arr as VaultEntry[]) : [];
  } catch {
    console.error("[vault] falha ao decifrar"); // NUNCA logar o conteudo/chave
    return [];
  }
}

// ---- gravacao com debounce (400ms) + escrita atomica (mesmo padrao do board) ----
let timer: NodeJS.Timeout | null = null;
let pending: VaultEntry[] | null = null;

/** Cifra `entries` (AES-256-GCM) e devolve o objeto de arquivo, ou null se sem key. */
function encrypt(entries: VaultEntry[]): VaultFile | null {
  const key = keyBuf();
  if (!key) return null;
  const iv = randomBytes(12); // iv NOVO a cada escrita — obrigatorio no GCM
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(entries), "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { v: 1, iv: iv.toString("hex"), tag: tag.toString("hex"), ct: ct.toString("hex") };
}

/** Escreve JA (sincrono) o objeto cifrado — usado pelo debounce e pelo flush. */
function writeNow(entries: VaultEntry[]): void {
  const file = encrypt(entries);
  if (!file) return; // sem key: nao ha como cifrar, nao grava texto plano
  try {
    mkdirSync(DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(file), "utf8"); // so o cifrado; nunca senha em claro
    renameSync(tmp, FILE); // troca atomica: nunca deixa o cofre pela metade
  } catch (e) {
    console.error("[vault] erro ao salvar:", e); // e = erro de fs, sem conteudo do cofre
  }
}

/** Salva o cofre com debounce (400ms) + escrita atomica, cifrando antes de escrever. */
export function saveVault(entries: VaultEntry[]): void {
  pending = entries;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const d = pending;
    pending = null;
    if (!d) return;
    writeNow(d);
  }, 400);
}

/**
 * Grava IMEDIATAMENTE (sincrono) o que estiver pendente no debounce.
 * Chamar no onDispose da sala (redeploy do Coolify) — senao as ultimas edicoes
 * dentro da janela de 400ms se perdem quando o processo reinicia.
 */
export function flushVaultSync(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const d = pending;
  pending = null;
  if (!d) return;
  writeNow(d);
}

// ============================ parser de import (v1, TOLERANTE) ============================

/**
 * parseVaultMarkdown — parser TOLERANTE v1, GENERICO. Sera AFINADO depois com um
 * exemplo real do .md do usuario (o formato exato das credenciais dele ainda nao
 * e conhecido). Heuristica atual, propositalmente conservadora:
 *
 * - Quebra o texto por headers markdown (# / ##) — cada header vira o `client`.
 * - Uma secao cujo header (ou uma linha de rotulo de secao) case "desativado" /
 *   "headquarters" / "hq" define o `group` das entradas seguintes; default "ativo".
 * - Dentro da secao, linhas do tipo "- campo: valor" ou "campo: valor" viram campos:
 *     login / usuario / user / e-mail / email -> username
 *     senha / password / pass / pwd           -> password
 *     url / link / site / (valor http...)      -> url
 *     qualquer outro rotulo / linha solta      -> acumula em notes
 * - `service` recebe o rotulo da linha quando faz sentido (linha "Serviço: X" ou o
 *   1o rotulo desconhecido); senao fica "".
 * - Uma entrada e emitida por bloco que tenha ao menos username OU password OU url
 *   (blocos so-titulo sem credencial nenhuma sao ignorados).
 * - id unico e deterministico DENTRO da chamada: "v" + base + contador incremental.
 *   Usa Date.now() so como base do id em runtime normal (nao quebra o build — o
 *   parser nunca roda em build). Se duas entradas saissem no mesmo ms, o contador
 *   garante unicidade.
 */
export function parseVaultMarkdown(text: string): VaultEntry[] {
  const out: VaultEntry[] = [];
  if (!text || typeof text !== "string") return out;

  const base = Date.now();
  let counter = 0;
  const mkId = (): string => `v${base}${counter++}`;

  // grupo "corrente": muda quando um header/rotulo de secao bate as palavras-chave
  let group = "ativo";
  const groupFromLabel = (s: string): string | null => {
    const t = s.toLowerCase();
    if (/\bdesativad/.test(t)) return "desativado";
    if (/\bheadquarters\b|\bhq\b/.test(t)) return "headquarters";
    if (/\bativ/.test(t)) return "ativo";
    return null;
  };

  // acumulador da entrada corrente
  let cur: VaultEntry | null = null;
  const notesBuf: string[] = [];

  const flush = (): void => {
    if (!cur) return;
    cur.notes = notesBuf.join("\n").trim().slice(0, 2000);
    // so emite se tiver ao menos uma credencial de fato
    if (cur.username || cur.password || cur.url) out.push(cur);
    cur = null;
    notesBuf.length = 0;
  };

  const startEntry = (client: string): void => {
    flush();
    cur = {
      id: mkId(),
      group,
      client: client.slice(0, 120),
      service: "",
      username: "",
      password: "",
      url: "",
      notes: "",
      updatedAt: base,
      updatedBy: "import",
    };
  };

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // ---- header markdown (# / ##) -> novo client (e talvez novo grupo) ----
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      const title = h[1].trim();
      const g = groupFromLabel(title);
      if (g) group = g; // header que e so um rotulo de secao ("## Desativados")
      // se o header vira grupo puro (ex: "Desativados" sozinho), nao abre entrada;
      // senao, abre uma entrada com esse client.
      if (g && !/[a-z0-9]/i.test(title.replace(new RegExp(g, "i"), ""))) {
        flush(); // secao pura: fecha a anterior e nao abre nova
      } else {
        startEntry(g ? title.replace(new RegExp(`\\b${g}\\b`, "i"), "").trim() || title : title);
      }
      continue;
    }

    // ---- linha de campo: "- campo: valor" ou "campo: valor" ----
    const stripped = line.replace(/^[-*]\s+/, ""); // tira bullet
    const kv = stripped.match(/^([^:]{1,60}?)\s*:\s*(.*)$/);

    // linha que e so um rotulo de secao solto ("Desativados:") muda o grupo
    if (kv && !kv[2].trim()) {
      const g = groupFromLabel(kv[1]);
      if (g) {
        group = g;
        continue;
      }
    }

    if (kv) {
      const label = kv[1].trim();
      const value = kv[2].trim();
      const lk = label.toLowerCase();

      // sem entrada aberta ainda (campos antes de qualquer header) -> abre uma anonima
      if (!cur) startEntry("");

      if (/^(login|usu[aá]rio|user(name)?|e-?mail)$/.test(lk)) {
        cur!.username = value.slice(0, 200);
      } else if (/^(senha|password|pass|pwd)$/.test(lk)) {
        cur!.password = value.slice(0, 400);
      } else if (/^(url|link|site|endere[çc]o)$/.test(lk) || /^https?:\/\//i.test(value)) {
        cur!.url = value.slice(0, 400);
      } else if (/^(servi[çc]o|service|sistema|plataforma|app)$/.test(lk)) {
        cur!.service = value.slice(0, 120);
      } else {
        // rotulo desconhecido: 1o vira service (se vazio), senao acumula em notes
        if (!cur!.service && value) cur!.service = label.slice(0, 120);
        notesBuf.push(`${label}: ${value}`);
      }
      continue;
    }

    // ---- valor solto (url crua sem rotulo, ou texto livre) ----
    if (!cur) startEntry("");
    if (/^https?:\/\//i.test(line) && !cur!.url) {
      cur!.url = line.slice(0, 400);
    } else {
      notesBuf.push(line);
    }
  }

  flush();
  return out;
}
