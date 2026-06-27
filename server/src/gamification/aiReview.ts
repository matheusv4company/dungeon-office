// Avaliacao da entrega pela IA (Haiku 4.5), rodando no SERVIDOR no task:deliver.
// Degrada com elegancia: sem chave / falha de API / timeout -> devolve null e o gate cai
// pro fluxo manual (a entrega fica em escrow, verificavel a mao). NUNCA lanca: o board nao
// pode travar por causa da IA. A ANTHROPIC_API_KEY e lida do ambiente e NUNCA e logada.

const MODEL = "claude-haiku-4-5-20251001"; // modelo aprovado pelo dono

export type AiReview = { score: number; note: string };

export type DeliveryInput = {
  title: string;
  desc: string;
  client: string;
  unit: string; // "" | "ia" | "mkt"
  proof: string;
  note: string;
};

// Definition of Done curta por tipo (do design). A IA julga o quao PRONTA a entrega parece.
function dodFor(unit: string): string {
  if (unit === "mkt")
    return "Marketing/trafego: material no formato acordado e anexado por link verificavel; revisado; agendado/publicado; cliente avisado.";
  if (unit === "ia")
    return "IA/dev: deploy feito e testado; cliente com acesso (link/credencial); revisado por outra pessoa.";
  return "Entrega ao cliente: resultado no formato combinado, com prova verificavel de que foi enviado/publicado.";
}

/**
 * Pede ao Haiku uma nota 0-10 + justificativa curta da entrega. Retorna null em qualquer
 * falha (sem chave, erro de API, timeout, parse) — quem chama trata como "sem avaliacao".
 */
export async function reviewDelivery(input: DeliveryInput): Promise<AiReview | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null; // sem chave -> degrada pro fluxo manual
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });
    const system =
      "Voce avalia entregas de uma agencia ao cliente contra uma Definition of Done. " +
      "Voce NAO consegue abrir o link de prova — julgue pela completude aparente da descricao " +
      "e pela presenca de prova verificavel. Seja justo, objetivo e nao inflacione notas. " +
      'Responda APENAS com um JSON valido: {"score": <inteiro 0 a 10>, "note": "<uma frase curta em PT-BR>"}.';
    const user =
      `Definition of Done: ${dodFor(input.unit)}\n\n` +
      `Tarefa: ${clamp(input.title, 200)}\n` +
      `Descricao: ${clamp(input.desc, 1500) || "(sem descricao)"}\n` +
      `Cliente: ${clamp(input.client, 80) || "(sem cliente)"}\n` +
      `Prova (link, nao abrivel): ${clamp(input.proof, 300)}\n` +
      `Nota do responsavel: ${clamp(input.note, 280) || "(nenhuma)"}\n\n` +
      `De a nota 0-10 de quao completa/pronta esta entrega parece e uma justificativa curta.`;
    const resp = await client.messages.create(
      { model: MODEL, max_tokens: 200, system, messages: [{ role: "user", content: user }] },
      { timeout: 12000, maxRetries: 1 }, // 12s e 1 retry: nao pendura o board
    );
    const text = resp.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    return parseReview(text);
  } catch (e) {
    // loga so a mensagem (sem a chave) e degrada
    console.warn("[aiReview] avaliacao indisponivel (degradando):", (e as Error)?.message ?? "erro");
    return null;
  }
}

function clamp(s: string, n: number): string {
  return String(s ?? "").slice(0, n);
}

function parseReview(text: string): AiReview | null {
  try {
    const m = text.match(/\{[\s\S]*\}/); // pega o 1o objeto JSON do texto
    if (!m) return null;
    const obj = JSON.parse(m[0]) as { score?: unknown; note?: unknown };
    const score = Math.round(Number(obj.score));
    if (!Number.isFinite(score)) return null;
    return { score: Math.max(0, Math.min(10, score)), note: String(obj.note ?? "").slice(0, 280) };
  } catch {
    return null;
  }
}
