# PLANO — Update V2 do Escritório (8 features)

> Plano de ação pro **Opus implementar**. Pesquisa (WorkAdventure) e verificação de código
> já feitas — as conclusões estão embutidas. NÃO fazer push sem o "pode subir" do Matheus.

## Regras da casa (valem pra TODAS as fases)
- **1 feature = 1 commit atômico** com mensagem clara; feature atrás de **flag env**
  (padrão do projeto: default LIGADO, desliga com `X=0` no Coolify — ver `server/src/gamification/flags.ts`).
- **QA de UX ao fim de cada fase** (mais importante que código bonito); review leve por
  feature; **review completo a cada 3 features** (marcado abaixo).
- O agente NÃO enxerga o canvas ao vivo (trava sob automação): QA = múltiplas abas + logs
  + pedir teste ao Matheus nos pontos marcados 🧪.
- Repo é PÚBLICO: nenhum segredo em código/commit/log.
- PowerShell: sempre `Set-Location` absoluto.
- Memórias relevantes: `voz-proximidade-privacidade` (invariantes do vazamento),
  `whatsapp-api-seguranca` (postura segura por padrão).

## Ordem das fases (e por quê)
```
F1 (#8 motor de audibilidade)  ← base estrutural do áudio
F2 (#2 sons de entrada/saída)  ← usa os eventos do motor
F3 (#3 share com áudio)        ← gated pelo mesmo motor
── REVIEW COMPLETO 1 (áudio) ──
F4 (#1 fix do print)
F5 (#5 chips responsável/cliente)
F6 (#7 duplicar card)
── REVIEW COMPLETO 2 (kanban) ──
F7 (#6 emojis)
F8 (#4 transcrição + resumo + tarefas)  ← a maior; usa zonas + IA já estáveis
── REVIEW FINAL + REGRESSÃO GERAL ──
```
Motivo: o item 8 vira a fundação (F2 e F3 dependem dele); os quick wins do kanban vêm
depois; a transcrição fica por último porque é a maior e se apoia em tudo que já estará
estável.

---

## F1 — Motor de Audibilidade server-side (item 8: fix DEFINITIVO do vazamento)

### O que a pesquisa no WorkAdventure mostrou (por que o deles não vaza)
- O servidor ("back") é dono das posições e agrupa jogadores em **bolhas discretas**
  (`GameRoom.updatePosition → updateUserGroup → searchClosestAvailableUserOrGroup`, com
  `minDistance` pra formar par e `groupRadius` pra entrar/ficar no grupo; a SAÍDA usa
  raio maior que a entrada = **histerese**).
- O front **só cria conexão WebRTC com membros da própria bolha** (P2P full-mesh até 4;
  LiveKit a partir de 5). Sair da bolha = **derrubar a conexão**.
- Conclusão: vazar é **estruturalmente impossível** — você não está conectado a quem não
  deve ouvir. Não existe "ganho 0 que falhou".

### Por que o NOSSO vaza (diagnóstico)
Hoje TODO cliente assina TODAS as tracks (`/token` dá `canSubscribe: true` global —
`server/src/index.ts`) e o "não ouvir" é só **ganho = 0 calculado no cliente**
(`client/src/net/voice.ts`). Qualquer bug/raça no cálculo (aba em 2º plano, reconexão,
frescor de posição — já caçamos 3+) = vazamento. É uma arquitetura de "silêncio por
convenção", não por estrutura.

### Design novo (2 camadas, estilo WorkAdventure adaptado ao LiveKit)
**Camada 1 — ESTRUTURAL (servidor decide quem RECEBE áudio):**
- O `OfficeRoom` (que já é dono das posições, `move` handler) calcula os **pares
  audíveis** num tick throttled (250–500ms): mesmo andar E (distância < `R_ENTRA` OU
  mesma zona de reunião). Zona de reunião = conjunto fechado (dentro↔dentro; de fora
  NUNCA ouve quem está dentro, e vice-versa).
- **Histerese**: `R_SAI > R_ENTRA` (calibrar com os raios do gain atual; ex.: entra a
  260px, sai a 320px) — evita flap na fronteira.
- Quando um par muda de estado, o servidor aplica via **LiveKit RoomService**:
  `RoomServiceClient.updateSubscriptions(room="office", identity=listenerSessionId,
  trackSids=[mic do publisher, share-audio do publisher], subscribe=true/false)`.
  - `livekit-server-sdk` já é dependência (hoje só `AccessToken` é usado).
  - URL do RoomService = LK_URL trocando `wss://` por `https://`.
  - Identity do LiveKit **já é o sessionId** do Colyseus (ver `voice.ts connect()` +
    `/token`) → mapeamento 1:1 com os players do servidor. ✔
  - Track SIDs: cache via `listParticipants()` + re-sync periódico (a cada ~5s) e ao
    receber `voice:ready` do cliente (novo msg) — cobre "publicou depois".
- Reconexão: ao (re)entrar no LiveKit, o cliente manda `voice:ready`; o servidor
  re-aplica o estado inteiro daquele listener (dessincronização impossível de durar).

**Camada 2 — SUAVIDADE (cliente, já existe):** o gain por distância atual vira só
estética (fade de volume). Se falhar, o pior caso é volume errado — nunca ouvir quem
não devia, porque a track nem chega.

**Flag:** `AUDIO_AUTH` (default ON; `AUDIO_AUTH=0` volta instantâneo ao comportamento
atual sem rebuild).

**Plano B (se o RoomService do self-host não responder):** smoke test é o PRIMEIRO
passo da fase (`listParticipants` na VPS). Se indisponível: fallback client-side — o
servidor manda `aud:set {sids[]}` pro listener e o cliente faz
`RemoteTrackPublication.setSubscribed(false)` fora do conjunto. Menos blindado contra
cliente malicioso, mas ainda estrutural do ponto de vista do listener (time interno de
confiança — aceitável).

### Arquivos
- `server/src/rooms/OfficeRoom.ts` (tick de audibilidade + integração RoomService)
- `server/src/index.ts` (export das creds LK pro módulo novo)
- novo `server/src/voice/audibility.ts` (motor puro + testável: pares, histerese, zonas)
- `client/src/net/voice.ts` (`voice:ready`, manter gains)
- `server/src/gamification/flags.ts` + `client/src/net/config.ts` (flag)

### 🧪 QA (com o Matheus, 2–3 abas/máquinas)
1. Longe = a track NEM CHEGA (conferir em `chrome://webrtc-internals` — 0 audio tracks
   do outro) → aproxima → track chega + fade suave.
2. **Aba em 2º plano não muda NADA** (decisão é do servidor) — o caso histórico.
3. Reunião: colado na parede por fora, não ouve nada de dentro. Dentro↔dentro ok.
4. Reconexão dupla (F5 nas duas abas em sequência).
5. Andar diferente = silêncio absoluto.
6. `AUDIO_AUTH=0` → tudo volta ao comportamento atual.

---

## F2 — Som de "entrou/saiu do alcance" (item 2)

- **Fonte de verdade = o motor da F1**: quando a assinatura de um par muda, o servidor
  já sabe — manda `prox:enter {sid, name}` / `prox:leave {sid, name}` pro listener.
  (Zero divergência entre o som e o áudio real.)
- Cliente: 2 bipes curtos **sintetizados via WebAudio** (sem asset externo; tipo
  "ding" subindo = chegou, descendo = saiu), volume discreto (~0.15), cooldown de 2s
  por pessoa, sem som pra si mesmo. Respeitar o unlock de áudio já existente da voz.
- Flag: `PROX_SOUND` (ON).
- 🧪 QA: cruzar a fronteira repetidamente → 1 som por transição (histerese da F1
  segura o flap); entrar/sair de reunião; morte/respawn não toca em loop.

## F3 — Compartilhar tela COM áudio (item 3)

- Cliente (`voice.ts startScreenShare`):
  `setScreenShareEnabled(true, { audio: true, systemAudio: "include" }, ...)` →
  publica também `ScreenShareAudio`.
- UI: no fluxo de compartilhar, dica: "Pra ter SOM: compartilhe uma **aba** (Chrome:
  marcar 'compartilhar áudio da guia') ou tela inteira com áudio do sistema (Windows)".
  Indicador 🔊 no cabeçalho do share quando o áudio existe.
- Listener: attach do track `ScreenShareAudio` junto do vídeo; **quem pode VER o share
  ouve o áudio dele** (mesmo conjunto do vídeo, gated pela F1 — o motor já assina/
  desassina o share-audio junto). Volume cheio (não passa pelo fade de proximidade).
- Degradação: navegador sem tab-audio (Firefox/Safari) compartilha só vídeo, sem erro.
- Flag: `SHARE_AUDIO` (ON).
- 🧪 QA: compartilhar aba do YouTube → 2ª aba ouve em sync; quem está longe/fora do
  share não recebe a track; parar share limpa; PiP próprio não ecoa (não anexar o
  próprio share-audio localmente!).

## ─── REVIEW COMPLETO #1 (F1+F2+F3) ───
Regressão pesada de voz com a matriz da memória `voz-proximidade-privacidade` +
`/code-review` do diff acumulado. Corrigir findings antes de seguir.

---

## F4 — Fix do envio de print da entrega (item 1)

### O que já foi verificado no código (diagnóstico pronto)
- Cliente está CORRETO: comprime pra JPEG ≤1280px q0.72, base64 **sem** prefixo, envia
  `{image, imageType:"image/jpeg"}` (`kanban.ts:1111-1140, 1273-1284`).
- Servidor: `task:deliver` valida e, em QUALQUER falha, faz **`return` SILENCIOSO**
  (`OfficeRoom.ts:301-341`, guarda em `:337`) → o usuário clica "Entregar" e **nada
  acontece, sem nenhuma mensagem**. Guardas que caem aí: task fora da coluna `feito`,
  já entregue, imagem ausente, `imageType` fora de `IMG_TYPES`, base64 > 8MB.
- Transporte WS sem `maxPayload` explícito (`index.ts:149`) — mensagem grande demais
  pode ser dropada pela lib sem erro visível.
- Foto de iPhone (HEIC) não decodifica no `<img>` → `compressImage` devolve null (a UI
  até avisa, mas a mensagem é genérica).

### Plano
1. **Matar o silêncio pra sempre**: toda falha do `task:deliver` responde
   `client.send("task:deliverError", { reason })` → toast claro no kanban ("imagem
   grande demais", "a task precisa estar em Feito", etc.). Isso sozinho já explica
   "por que não funciona" na próxima ocorrência.
2. Robustez de decodificação: `createImageBitmap(file)` com fallback pro `<img>`;
   HEIC → mensagem específica "use um screenshot (PNG/JPG), foto do iPhone em HEIC
   não é suportada".
3. `maxPayload: 10 * 1024 * 1024` explícito no `WebSocketTransport` + log de tamanho
   recebido no handler (só o tamanho, nunca o conteúdo).
4. Colar imagem com **Ctrl+V** no modal de entrega (screenshot direto, sem salvar
   arquivo) — melhora real de UX pro caso de uso.
5. 🧪 Matriz: PNG 4K, JPG, WebP, foto de celular, >8MB (erro amigável), colar print.
   Reproduzir ANTES com o Matheus o caso real que falhou (print + console).

## F5 — Chips no lugar de dropdown: responsável e cliente (item 5)

- No editor de task do kanban (`kanban.ts`, modal editor): substituir os `<select>` de
  **responsável** e **cliente** por linhas de **chips clicáveis** (mesmo padrão visual
  do seletor de formato de entrega `kb-seg`): membro com a cor de `memberColors`,
  cliente com a cor de `clientColors`, chip ativo destacado, chip "✕ ninguém/nenhum"
  e chip "+ novo…" (abre `askText`, replicando o fluxo atual de criar cliente).
- Zero mudança de dados/servidor. Mobile: chips têm alvo de toque maior que dropdown
  (ganho de UX no celular).
- 🧪 QA: criar/editar task, novo cliente na hora, toque no mobile, listas longas
  (quebra de linha ok).

## F6 — Duplicar card (item 7)

- Server: handler `task:duplicate { id }` → clona **conteúdo** (`title + " (cópia)"`,
  `desc, client, assignee, due, unit, size, clientWeight`), **reseta estado** (mesma
  coluna, `order` logo após o original; `delivered/verified/proof/score/block` zerados
  — cópia nunca herda entrega nem PE), `persistBoard()`.
- Client: botão "⧉ Duplicar" no modal de edição (+ atalho no hover do card).
- 🧪 QA: duplicar task entregue → cópia limpa em estado; duplicar 2x; PE não duplica.

## ─── REVIEW COMPLETO #2 (F4+F5+F6) ───

---

## F7 — Emojis flutuantes (item 6)

- HUD: barra colapsável (canto inferior direito, acima do HUD de nível) com 8 emojis
  fixos: 👍 ❤️ 😂 🎉 👏 😮 🔥 ✅.
- Clique → `room.send("emote", { e })`. Server: whitelist + rate limit (1 a cada
  750ms por cliente) → `broadcast("emote", { sid, e })`.
- Clientes: emoji flutua acima do sprite do autor (tween: sobe ~40px, escala 1.4→1,
  fade em 2.5s, depth UI). Funciona pro próprio player e remotos; some se o autor
  trocar de andar.
- Flag: `EMOTES` (ON). 🧪 QA: spam (rate limit segura), 2 abas, andar durante o emote,
  mobile (toque).

## F8 — Transcrição, resumo e tarefas automáticas das reuniões (item 4) — A MAIOR

### Arquitetura (custo ~zero, sem serviço novo)
- **Captura (cliente)**: Web Speech API (`webkitSpeechRecognition`, `lang: "pt-BR"`,
  `continuous`, só resultados FINAIS). Ativa SOMENTE quando: flag on + usuário É
  membro logado + está DENTRO de zona de reunião + voz ativa + não pausou a própria
  transcrição. Auto-restart no `onend` enquanto na zona. Envia
  `room.send("meeting:say", { text })` (≤500 chars por fala).
  - Chrome/Edge only (Safari/Firefox: banner "seu navegador não transcreve" e segue
    sem — a reunião ainda é transcrita pelos demais).
  - **Nenhum áudio sai do navegador — só texto.**
- **Sessão (servidor, `server/src/meetings/`)**: por zona de reunião — abre quando
  ≥2 membros na zona; acumula `{ts, memberId, name, text}`; fecha quando a zona
  esvazia (grace 60s). Persistência em `meetings.json` no volume (mesmo padrão
  atômico do board).
- **Resumo (servidor)**: ao fechar sessão com ≥30 palavras → Anthropic
  `claude-haiku-4-5` (ANTHROPIC_API_KEY já existe) com saída JSON:
  `{ resumo, decisoes[], tarefas[{ titulo, responsavel?, due? }] }`.
- **Saída**:
  1. Card-ATA: "📋 Ata — {data} {hora}" criado em **A Fazer**, client "Reunião" (cor
     própria criada se não existir), com o resumo+decisões na descrição.
  2. **Tarefas automáticas**: cada uma vira card normal em A Fazer com prefixo "🤖 ",
     `assignee` mapeado por nome via `normId` (sem match → sem responsável), client
     "Reunião". Fácil de identificar e de apagar se a IA viajar.
  3. Toast pros participantes: "📋 Ata pronta — N tarefas criadas".
- **Consentimento/controle**: badge persistente "🔴 transcrevendo" na zona + botão
  pausar (pessoal); kill switch `MEETING_SCRIBE=0`; nada grava áudio.

### Riscos aceitos (documentar no PR)
Precisão do pt-BR razoável (não perfeita); falas simultâneas se perdem; navegadores
não-Chrome não contribuem. Custo por reunião: centavos (logar tokens no console).

### 🧪 QA
Reunião real de 2 pessoas × 3-4 min → ata coerente + tarefas certas; convidado (sem
login) não transcreve; sair no meio; 2 zonas em paralelo; `MEETING_SCRIBE=0` desliga
tudo; spam de `meeting:say` (rate limit ~1/s por cliente).

## ─── REVIEW FINAL + REGRESSÃO GERAL ───
`/code-review` completo do update + regressão manual: voz (matriz completa de novo),
share, kanban (CRUD/entrega/verificação), vault, login, colisão/andares, mobile.

---

## Custos do update
- Anthropic Haiku (atas): ~US$ 0,01–0,05 por reunião.
- Web Speech API: grátis. LiveKit: já self-host. **Zero serviço novo pago.**

## Flags novas (todas default ON, desligáveis no Coolify)
`AUDIO_AUTH` · `PROX_SOUND` · `SHARE_AUDIO` · `EMOTES` · `MEETING_SCRIBE`

## Fontes da pesquisa (item 8)
- FAQ/suporte do WorkAdventure (bolhas, WebRTC P2P ≤4, upgrade pra LiveKit com 5+):
  https://workadventu.re/support/ e release 1.27:
  https://workadventu.re/release/workadventure-1-27-0-the-road-to-workadventure-2/
- Código do back (grupos/bolhas com `minDistance`/`groupRadius` + histerese):
  https://github.com/workadventure/workadventure — `back/src/Model/GameRoom.ts`
- Docs de chat por proximidade: https://docs.workadventu.re/user/chat/

---

# PROMPT PRO OPUS (colar numa janela nova, na pasta do projeto)

```
Implemente o update V2 do escritório virtual seguindo docs/PLANO_UPDATE_V2.md, fase por
fase, NA ORDEM (F1→F8). Regras:

- Pasta do projeto: C:\Users\mathe\OneDrive\Desktop\Claude Code\Clientes marketing\escritorio-virtual
- 1 fase = 1 commit atômico (Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>).
  NUNCA dê git push — eu dou o "pode subir".
- Cada feature atrás da flag env indicada no plano (padrão flags.ts: default ON).
- Ao fim de F1, F2, F3 e F8: PARE e me chame pra QA manual (os testes 🧪 do plano) antes
  de seguir. As demais podem seguir direto após typecheck+build verdes.
- Reviews: /code-review completo após F3 (áudio), após F6 (kanban) e ao final. Corrija
  findings CONFIRMED antes de prosseguir.
- F1 começa OBRIGATORIAMENTE pelo smoke test do RoomService do LiveKit self-host
  (listParticipants na VPS). Se indisponível, use o Plano B do documento e me avise.
- F4: antes de codar, me peça o print/console do erro real em produção pra confirmar o
  diagnóstico (rejeição silenciosa).
- Repo público: nenhum segredo em código/commit/log. Builds: server `npx tsc --noEmit`,
  client `npx tsc --noEmit && npm run build` — verdes antes de cada commit.
- Não me pergunte o que já está decidido no plano; pergunte só o que o plano marcar
  como decisão minha ou o que for genuinamente ambíguo.
```
