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
  // OBS: a deliverNote (nota privada do responsavel) NAO entra aqui de proposito — a IA pode
  // parafrasea-la na justificativa publica (aiNote), vazando contexto interno. Privacidade > nota.
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
      "Voce avalia se uma entrega de uma agencia ao cliente esta PRONTA, contra uma Definition of Done, num time de CONFIANCA. " +
      "IMPORTANTE: voce NAO consegue abrir o link de prova (Google Drive, Docs, Figma, Vercel, etc.), mas a PRESENCA de um " +
      "link de prova valido E DO TIPO ADEQUADO a tarefa E a evidencia da entrega — o trabalho esta DENTRO do link. " +
      "Assuma que os passos padrao da Definition of Done foram cumpridos, A MENOS QUE a descricao ou o tipo do link contradigam. " +
      "NUNCA desconte pontos porque a descricao (um resumo curto) nao menciona explicitamente revisao/agendamento/testes/etc. — " +
      "isso NAO e falha, e so um resumo enxuto. " +
      "Escala: 7-10 e o caso COMUM e esperado — link valido e coerente com a tarefa (mesmo com descricao curta como 'segue no drive'); " +
      "4-6 SOMENTE quando o link e de tipo claramente inadequado pra tarefa OU a descricao contradiz a tarefa; " +
      "0-3 SOMENTE quando nao ha link de prova valido OU a entrega claramente nao tem relacao com a tarefa. " +
      'Responda APENAS com um JSON valido: {"score": <inteiro 0 a 10>, "note": "<uma frase curta em PT-BR>"}.';
    const user =
      `Definition of Done: ${dodFor(input.unit)}\n\n` +
      `Tarefa: ${clamp(input.title, 200)}\n` +
      `Descricao (resumo, pode ser curto): ${clamp(input.desc, 1500) || "(sem descricao)"}\n` +
      `Cliente: ${clamp(input.client, 80) || "(sem cliente)"}\n` +
      `Link de prova (contem o trabalho entregue; voce nao abre, mas conte como entregue se for um link valido): ${clamp(input.proof, 300)}\n\n` +
      `Assumindo que o link de prova contem o trabalho, de a nota 0-10 de quao pronta a entrega parece e uma justificativa curta.`;
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
