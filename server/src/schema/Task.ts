import { Schema, type } from "@colyseus/schema";

/** Um card do kanban (gestor de tarefas). A chave no MapSchema e o proprio id. */
export class Task extends Schema {
  @type("string") id = "";
  @type("string") title = "";
  @type("string") desc = "";
  @type("string") assignee = ""; // responsavel
  @type("string") client = ""; // cliente
  @type("string") due = ""; // data de entrega "YYYY-MM-DD" (vazio = sem prazo)
  @type("string") col = "backlog"; // backlog | afazer | fazendo | travado | feito
  @type("number") order = 0; // posicao dentro da coluna (fracionaria; ordena asc)
  @type("boolean") archived = false; // arquivado (some do board, mas fica no historico)
  @type("string") unit = ""; // empresa dona da tarefa: "" | "ia" | "mkt"
  // --- gamificacao: carimbos de tempo do SERVIDOR (autoritativos, anti-gaming) ---
  @type("number") createdAt = 0; // ms na criacao
  @type("number") completedAt = 0; // ms da 1a vez que entrou em "feito" (0 = nunca; sticky)
  @type("number") committedDue = 0; // prazo (ms) congelado ao iniciar ("fazendo"); 0 = sem prazo
  @type("number") dueChanges = 0; // qtas vezes o prazo mudou apos sair do backlog (sinal de gaming)
  // --- gamificacao F2: gate de entrega (escrow; "Feito" sozinho NAO credita) ---
  @type("boolean") delivered = false; // entregue ao cliente de verdade (≠ "feito" interno)
  @type("number") deliveredAt = 0; // ms da entrega (carimbo do SERVIDOR)
  @type("string") deliveredBy = ""; // quem confirmou a entrega (memberId/nome)
  @type("string") proof = ""; // link/evidencia verificavel da entrega (clamp 300)
  @type("string") deliverNote = ""; // nota curta da entrega (clamp 280)
  @type("boolean") verified = false; // sign-off / verificado (libera o escrow em F3/F6)
  @type("string") verifiedBy = ""; // quem deu o sign-off (carimbo do servidor; anti-conluio em F6)
  @type("number") verifiedAt = 0; // ms do sign-off (carimbo do servidor)
  // --- gamificacao F3: nota da IA (so PUBLICA quando aprovou; nota baixa fica privada) ---
  @type("number") aiScore = -1; // -1 = nao avaliada; 0-10 = nota (so preenchida se a IA aprovou)
  @type("string") aiNote = ""; // justificativa PUBLICA (so para entrega aprovada pela IA)
}
