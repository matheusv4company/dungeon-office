import { Schema, type, MapSchema } from "@colyseus/schema";
import { Player } from "./Player";
import { Task } from "./Task";

export class OfficeState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  /** board do kanban (gestor de tarefas) — sincronizado ao vivo, persistido em disco */
  @type({ map: Task }) tasks = new MapSchema<Task>();
}
