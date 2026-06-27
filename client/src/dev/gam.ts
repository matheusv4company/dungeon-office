// Helpers de QA da gamificacao expostos em window.__gam — APENAS em dev
// (import.meta.env.DEV) ou com localStorage.gam_dev="1" (pra testar contra um build).
// Em producao nada disso existe. Cada feature registra seus proprios helpers via
// registerGam() (ex.: setLevel, fakeDeliver, setOverdue) pra dirigir estados no canvas,
// que a CDP costuma congelar e nao da pra clicar um fluxo real inteiro.

type GamNS = Record<string, unknown>;

/** Liga os helpers de QA em dev (host localhost), ou via localStorage.gam_dev="1". */
export function devEnabled(): boolean {
  // Rede local (dev/QA) — em prod (dungeon.empresa-br.com) isto e falso, entao os
  // helpers nao existem la. Nao dependo de import.meta.env.DEV: no client esse acesso
  // precisa de cast pra tipar, e o cast quebra a substituicao estatica do Vite.
  try {
    const h = window.location.hostname;
    if (h === "localhost" || h === "127.0.0.1") return true;
  } catch {
    /* sem window */
  }
  // Escape hatch pra testar contra um build de producao: localStorage.gam_dev="1".
  try {
    return localStorage.getItem("gam_dev") === "1";
  } catch {
    return false;
  }
}

/** Devolve (criando se preciso) o namespace window.__gam, ou null fora de dev. */
export function gamNS(): GamNS | null {
  if (!devEnabled()) return null;
  const w = window as unknown as { __gam?: GamNS };
  if (!w.__gam) w.__gam = {};
  return w.__gam;
}

/** Mescla helpers no window.__gam (no-op fora de dev). */
export function registerGam(obj: GamNS): void {
  const ns = gamNS();
  if (ns) Object.assign(ns, obj);
}
