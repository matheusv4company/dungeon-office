// Bot de teste: entra na sala "office" e anda em circulos.
// Uso: node tools/bot.mjs [url] [nome] [charId]
import { Client } from "colyseus.js";

const url = process.argv[2] || "ws://localhost:2567";
const name = process.argv[3] || "Bot Mago";
const charId = Number(process.argv[4] ?? 3);

const client = new Client(url);
const room = await client.joinOrCreate("office", { name, charId, x: 600, y: 420 });
console.log("[bot] entrou:", room.sessionId, "como", name);

let t = 0;
setInterval(() => {
  t += 0.06;
  const x = 600 + Math.cos(t) * 130;
  const y = 420 + Math.sin(t) * 70;
  const dir =
    Math.cos(t) < -0.2 ? 2 : Math.cos(t) > 0.2 ? 3 : Math.sin(t) < 0 ? 1 : 0;
  room.send("move", { x: Math.round(x), y: Math.round(y), dir, moving: true });
}, 100);

process.on("SIGINT", () => {
  try {
    room.leave();
  } catch {
    /* ignore */
  }
  process.exit(0);
});
