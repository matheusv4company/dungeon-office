import { Client, getStateCallbacks } from "colyseus.js";
import type { Room } from "colyseus.js";

/**
 * Descobre a URL do servidor:
 * 1) VITE_SERVER_URL se definida (override);
 * 2) localhost (dev) -> ws://localhost:2567;
 * 3) produção -> mesma origem da página (o servidor serve o cliente).
 */
function resolveServerUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  if (env?.VITE_SERVER_URL) return env.VITE_SERVER_URL;
  if (typeof window !== "undefined" && window.location) {
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1") return "ws://localhost:2567";
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${window.location.host}`;
  }
  return "ws://localhost:2567";
}

const SERVER_URL = resolveServerUrl();

/** URL HTTP do servidor (mesma origem) — usada pra buscar o token do LiveKit. */
export const SERVER_HTTP_URL = SERVER_URL.replace(/^ws/, "http");

export type JoinOpts = { name: string; charId: number; x: number; y: number; authToken?: string };

/** Conecta na sala "office" do Colyseus. */
export async function joinOffice(opts: JoinOpts): Promise<Room> {
  const client = new Client(SERVER_URL);
  return client.joinOrCreate("office", opts);
}

export { getStateCallbacks };
export type { Room };
