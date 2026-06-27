// Login por membro + PIN (F1). Fala com GET /members e POST /login (Etapa 0b do servidor)
// e guarda o membro logado em localStorage pra relogin automatico no mesmo device.
// O memberId (nome normalizado) e a chave estavel do progresso de gamificacao; vai no
// join do Colyseus. Convidado = sem memberId, sem progresso.
import { SERVER_HTTP_URL } from "../net/room";

const LS_MEMBER = "ev_member"; // JSON {memberId, displayName}

export type SavedMember = { memberId: string; displayName: string };

/** Membro salvo neste device (relogin automatico), ou null. */
export function loadMember(): SavedMember | null {
  try {
    const raw = localStorage.getItem(LS_MEMBER);
    if (!raw) return null;
    const m = JSON.parse(raw) as Partial<SavedMember>;
    if (m && typeof m.memberId === "string" && m.memberId && typeof m.displayName === "string") {
      return { memberId: m.memberId, displayName: m.displayName };
    }
  } catch {
    /* sem localStorage / json invalido */
  }
  return null;
}

export function saveMember(m: SavedMember): void {
  try {
    localStorage.setItem(LS_MEMBER, JSON.stringify(m));
  } catch {
    /* ignora */
  }
}

export function clearMember(): void {
  try {
    localStorage.removeItem(LS_MEMBER);
  } catch {
    /* ignora */
  }
}

/** Lista de nomes de membros pro dropdown (vazia se o servidor falhar). */
export async function fetchMembers(): Promise<string[]> {
  try {
    const r = await fetch(`${SERVER_HTTP_URL}/members`);
    const data = (await r.json()) as { members?: unknown };
    return Array.isArray(data.members) ? (data.members as string[]).filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export type LoginStatus = "created" | "ok" | "wrong" | "invalid" | "error";
export type LoginResult = {
  ok: boolean;
  status: LoginStatus;
  member?: SavedMember;
};

/**
 * Tenta logar. 1o acesso DEFINE o PIN (status "created"); depois CONFERE ("ok").
 * "wrong" = PIN errado; "invalid" = entrada ruim; "error" = servidor fora.
 */
export async function login(member: string, pin: string): Promise<LoginResult> {
  try {
    const r = await fetch(`${SERVER_HTTP_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member, pin }),
    });
    const data = (await r.json()) as {
      ok?: boolean;
      status?: LoginStatus;
      member?: { memberId?: string; displayName?: string };
    };
    if (data.ok && data.member?.memberId) {
      return {
        ok: true,
        status: data.status ?? "ok",
        member: {
          memberId: data.member.memberId,
          displayName: data.member.displayName ?? member.trim().slice(0, 16),
        },
      };
    }
    return { ok: false, status: (data.status as LoginStatus) ?? "error" };
  } catch {
    return { ok: false, status: "error" };
  }
}
