/**
 * Nonces do /token do LiveKit (hardening do review V2).
 *
 * PROBLEMA: o /token aceitava qualquer `identity` da query — e com o motor de
 * audibilidade a identidade virou FRONTEIRA DE PRIVACIDADE (os sessionIds de todos
 * são visíveis no estado do Colyseus; conectar no LiveKit como a identidade de outra
 * pessoa herdaria as assinaturas dela, ex.: ouvir uma reunião fechada).
 *
 * SOLUÇÃO: o cliente NÃO escolhe identidade. O OfficeRoom emite um nonce aleatório
 * atado ao sessionId da sessão Colyseus (entregue só àquele cliente, via client.send)
 * e o /token resolve nonce -> identidade. Válido enquanto a sessão viver; revogado no
 * onLeave. Reutilizável dentro da sessão (reconexões do LiveKit usam o mesmo).
 */
import { randomBytes } from "crypto";

const bySessionId = new Map<string, string>(); // sessionId -> nonce
const byNonce = new Map<string, string>(); // nonce -> sessionId

/** Emite (ou reutiliza) o nonce da sessão. Só o dono da sessão recebe esse valor. */
export function issueVoiceNonce(sessionId: string): string {
  const existing = bySessionId.get(sessionId);
  if (existing) return existing;
  const nonce = randomBytes(24).toString("base64url");
  bySessionId.set(sessionId, nonce);
  byNonce.set(nonce, sessionId);
  return nonce;
}

/** Resolve um nonce pra identidade (sessionId), ou null se inválido/revogado. */
export function resolveVoiceNonce(nonce: string): string | null {
  return byNonce.get(nonce) ?? null;
}

/** Revoga o nonce da sessão (chamar no onLeave — nonce morre com a sessão). */
export function revokeVoiceNonce(sessionId: string): void {
  const nonce = bySessionId.get(sessionId);
  if (nonce) byNonce.delete(nonce);
  bySessionId.delete(sessionId);
}
