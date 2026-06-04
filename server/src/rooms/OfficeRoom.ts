import { Room, Client } from "colyseus";
import { OfficeState } from "../schema/OfficeState";
import { Player } from "../schema/Player";

type JoinOptions = { name?: string; charId?: number; x?: number; y?: number };
type MoveMsg = { x?: number; y?: number; dir?: number; moving?: boolean };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export class OfficeRoom extends Room<OfficeState> {
  maxClients = 50;

  onCreate() {
    this.setState(new OfficeState());

    // Client-authoritative: cada cliente envia sua posicao; retransmitimos.
    this.onMessage("move", (client, msg: MoveMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof msg.x === "number") p.x = msg.x;
      if (typeof msg.y === "number") p.y = msg.y;
      if (typeof msg.dir === "number") p.dir = clamp(msg.dir | 0, 0, 3);
      p.moving = !!msg.moving;
    });

    console.log("[OfficeRoom] sala criada");
  }

  onJoin(client: Client, options: JoinOptions = {}) {
    const p = new Player();
    p.name = String(options.name ?? "Convidado").slice(0, 16) || "Convidado";
    p.charId = clamp(Number(options.charId ?? 0) | 0, 0, 9);
    p.x = Number.isFinite(options.x) ? Number(options.x) : 496;
    p.y = Number.isFinite(options.y) ? Number(options.y) : 592;
    p.dir = 0;
    p.moving = false;
    this.state.players.set(client.sessionId, p);
    console.log(`[OfficeRoom] entrou: ${p.name} (${client.sessionId}) — ${this.clients.length} online`);
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    console.log(`[OfficeRoom] saiu: ${client.sessionId}`);
  }
}
