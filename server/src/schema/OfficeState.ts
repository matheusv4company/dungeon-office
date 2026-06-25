import { Schema, type, MapSchema } from "@colyseus/schema";
import { Player } from "./Player";
import { Task } from "./Task";

export class OfficeState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  /** board do kanban (gestor de tarefas) — sincronizado ao vivo, persistido em disco */
  @type({ map: Task }) tasks = new MapSchema<Task>();
  /** cor (hex) por cliente — gerenciada pelo usuario; chips usam isso (senao auto) */
  @type({ map: "string" }) clientColors = new MapSchema<string>();
}
