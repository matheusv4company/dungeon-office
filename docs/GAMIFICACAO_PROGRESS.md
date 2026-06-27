# Gamificação — Progresso da execução (branch `gamificacao`)

> Diário de bordo da implementação autônoma. Fonte do DESENHO: `docs/GAMIFICACAO_RESEARCH.md`.
> Ao retomar (após compactação de contexto): leia este doc + `git log --oneline` pra saber onde está.

## Como reverter / desligar (resumo)
- **Desligar uma feature sem rebuild:** setar a env do flag no Coolify (ex.: `GAMIF_GATE=0`) e
  redeploy. Default é LIGADO quando a var não existe. Aceita `0/false/off/no` (qualquer caixa) pra desligar.
- **Kill switch geral:** `GAMIF_ALL=0` desliga a gamificação inteira.
- **Reverter de vez:** `git revert <sha do commit da feature>` (cada feature = 1 commit atômico).

## Ambiente de QA (lições aprendidas — IMPORTANTE pra retomar)
- **Vite dev (porta 5173) NÃO é acessível neste ambiente** (reporta "ready" mas não escuta em
  nenhuma interface; o browser do preview dá `chrome-error`). NÃO use 5173 pro QA.
- **QA do client = via BUILD servido pelo servidor na 2567.** Fluxo: `npm run build -w client`
  (atualiza `client/dist`) → o servidor (express.static) serve o build novo na 2567 → navegar o
  preview pra `http://localhost:2567/`. O JS tem hash, então sem cache velho. **Rebuildar o client
  a cada mudança de client que for testar.**
- **QA do server:** `curl http://localhost:2567/<endpoint>` (confiável). Lógica pura (ex.: flags):
  `node -e "require('./server/dist/...')"` com env setado.
- **Canvas Phaser congela o CDP:** evals LONGOS (com await/loop) no preview dão timeout. Use evals
  CURTOS e síncronos. Depois de ~20 reloads o contexto WebGL exaure (cenas param de bootar) →
  pare e reinicie o preview do servidor pra ter browser fresco.
- **Preview servers:** `escritorio-server` (porta 2567, serve API + build do client) e
  `escritorio-client` (5173, inútil aqui). Os dois compartilham o MESMO browser.
- Servidor de dev (tsx watch) sobe com `npm run dev -w server`; em prod o Coolify builda e roda `dist`.

---

## F0 — Infra de flags + /config + helpers de QA ✅ FEITO
**Commit:** (ver `git log`) · **Flag:** não tem flag próprio (é a própria infra).

**O que entrou:**
- `server/src/gamification/flags.ts` — `getFlags()` lê `process.env`, default LIGADO; `ligado()`
  trata `0/false/off/no` como desligado; master `GAMIF_ALL` desligado zera tudo.
- `server/src/index.ts` — `GET /config` → `{ flags: {...} }` (só booleans, nenhum segredo).
- `client/src/net/config.ts` — `loadConfig()` busca `/config` no boot (timeout 4s + try/catch,
  default tudo-ON em falha), `getFlags()` síncrono, `configLoaded()`.
- `client/src/dev/gam.ts` — `window.__gam` dev-helpers (`devEnabled()` = localhost OU
  `localStorage.gam_dev="1"`; em prod fica off). `registerGam()` pra cada feature pendurar helpers.
- `client/src/scenes/BootScene.ts` — `create()` async: `await loadConfig()` + `registerGam` antes
  de entrar na seleção. Boot não trava (promise nunca rejeita).

**Flags expostos** (todos default ON): `login, gate, aiReview, overdue, climate, progression,
stats, cosmetics, social` + master `GAMIF_ALL`.

**Como desligar:** não aplicável (infra). Para desligar features, ver os flags acima nas próximas seções.

**QA feito:**
- `curl /config` → 9 flags todos `true` (default). ✅
- `node -e getFlags()` com `GAMIF_ALL=0`/`off` → tudo `false`; `GAMIF_GATE=0`/`false` → só gate
  `false`, resto `true`; default → tudo `true`. ✅
- Client (build na 2567): `window.__gam.flags()` devolve os 9 flags lidos do `/config`; helpers
  `flags`/`reloadConfig` expostos. ✅
- Boot continua entrando na seleção normalmente (regressão do núcleo: não toca voz/kanban/movimento). ✅
- Review (general-purpose): aprovado, zero achados altos. Aplicados: DRY no master + parser
  tolerante (`false/off/no`) + alinhamento de comentário.

**Riscos/decisões tomadas sozinho:**
- **Tipo `GamifFlags` duplicado** em server (`flags.ts`) e client (`config.ts`) — não há fonte
  compartilhada entre os workspaces. RISCO ACEITO: mantenho os dois em sincronia a cada feature
  (são só listas de booleans). Revisar com olho humano se virar problema.
- **Default tudo-ON em falha de /config** (em vez de off): se o servidor está fora, o jogo nem
  conecta, então o default não atrapalha; e evita sumir com features por um blip de rede.
- **Dev-helpers por hostname localhost** (não por `import.meta.env.DEV`): o acesso a
  `import.meta.env` no client precisa de cast pra tipar, e o cast quebra a substituição estática
  do Vite (testado: não resolvia). localhost é confiável e em prod fica off.

**Ficou de fora:** nada do escopo do F0.

---

## F1 — Tela de login (membro + PIN) ✅ FEITO
**Commit:** (ver `git log`) · **Flag:** `GAMIF_LOGIN` (default ON). **Desligar:** `GAMIF_LOGIN=0`.

**O que entrou:**
- `client/src/auth/login.ts` (novo) — `fetchMembers()` (GET /members), `login(member,pin)` (POST /login),
  `loadMember/saveMember/clearMember` (localStorage `ev_member` = {memberId, displayName}).
- `client/src/net/room.ts` — `JoinOpts` ganhou `memberId?`.
- `client/src/scenes/CharacterSelectScene.ts` (reescrito) — gate por `getFlags().login`:
  - **OFF** → método `buildNameInput()` = a tela antiga de nome livre, byte-a-byte.
  - **ON** → painel DOM com 3 modos: **welcome** (relogin automático, sem PIN, + "Trocar de pessoa"),
    **login** (dropdown de membro + PIN 4-8 díg + "entrar como convidado"), **guest** (nome livre, sem progresso).
    Painel ancorado pela base (cresce pra cima), `escapeHtml()` nos nomes.
- `client/src/scenes/OfficeScene.ts` — campo `memberId`; em `create()`: `this.memberId =
  getFlags().login ? (loadMember()?.memberId ?? "") : ""`; passa `memberId` nos dois `joinOffice`
  (conexão inicial + reconexão). O servidor (OfficeRoom) já lia `options.memberId`.

**Como desligar:** `GAMIF_LOGIN=0` no Coolify → volta ao campo de nome livre. memberId sempre "" (convidado).

**QA feito (tudo ✅):**
- Painel renderiza (dropdown Pedro/Ana + PIN). Validação: PIN vazio/curto → "O PIN tem de 4 a 8 dígitos".
- **Criar:** Pedro/1234 → cria PIN (server: relogin 1234=ok, 9999=wrong, abc=invalid; hash nunca exposto),
  `ev_member` salvo, `memberId=pedro` chega ao Player no servidor.
- **Relogin automático:** reload → "Bem-vindo de volta, Pedro!" sem PIN.
- **Trocar de pessoa:** limpa `ev_member` → volta ao login.
- **PIN errado:** "PIN incorreto — tenta de novo 🙂", fica no select.
- **Convidado:** `ev_member` nulo, `memberId=""` no servidor (sem progresso).
- **Mobile** (375x812): grid 3 colunas + painel cabem; responsivo.
- **OFF** (`GAMIF_LOGIN=0` via .env temporário): volta ao campo de nome livre, sem erro de console.
- **Regressão do núcleo:** logado como Pedro → escritório conecta, nome "Pedro", charId/hp ok, botões
  Voz/Compartilhar/Gestor/Microfone/Mão presentes, mundo renderiza, 0 erro de console. Voz NÃO foi tocada.
- Review (general-purpose): aprovado, 0 bloqueante. Voz intocada, OFF equivalente, sem XSS explorável
  (escapeHtml cobre texto e atributos com aspas duplas), PIN não vaza.

**Riscos/decisões tomadas sozinho:**
- **Dropdown só de membros do board** (GET /members). Quem não está na lista entra como convidado
  (ou o admin cadastra no kanban). Dentro do escopo do prompt.
- **Lista vazia** (servidor fora): foca o PIN e o link de convidado fica visível — ninguém trava.
- **`<style id="ev-login-styles">`** fica no `<head>` após o login (idempotente, inócuo, só no caminho ON).
- **QA do clique em DOM do Phaser:** `preview_click` por coordenada pode acertar o elemento errado
  (DOM transformado do Phaser). Usei `element.click()` via `preview_eval` (confiável). Clique real do
  usuário roteia certo (browser faz hit-test no elemento visível). NÃO é bug de produto.

**Ficou de fora:** nada do escopo do F1. (Re-render por mudança de flag pós-boot não é necessário —
BootScene faz `await loadConfig()` antes de abrir a tela.)

---

## F2 — Gate de entrega (escrow) ✅ FEITO
**Commit:** (ver `git log`) · **Flag:** `GAMIF_GATE` (default ON). **Desligar:** `GAMIF_GATE=0`.

**O que entrou (estados no card de "Feito", sem novas colunas):**
- `server/src/schema/Task.ts` — campos: `delivered, deliveredAt, deliveredBy, proof, deliverNote, verified`.
- `server/src/board/store.ts` — `TaskData` espelhou (opcionais p/ compat com board.json antigo).
- `server/src/rooms/OfficeRoom.ts` — loader hidrata + persistBoard grava; 3 handlers **guardados por
  `if (!getFlags().gate) return`**:
  - `task:deliver` — exige `proof` não-vazio; carimba `deliveredAt` no SERVIDOR; `deliveredBy` = memberId/nome;
    `verified=false`. **Escrow: não credita nada.**
  - `task:verify` — sign-off manual → `verified=true` (F2 não credita ponto; isso é F6).
  - `task:undeliver` — reverte a entrega (engano/retrabalho).
- `client/src/ui/kanban.ts` — card de "Feito" (flag on) ganha rodapé: **📤 Entregar** → modal (link de prova
  obrigatório, validado http(s), + nota) → selo **⏳ aguardando verificação** + 🔗 prova + **✓ Verificar**/**↩ Devolver**
  → selo **✅ Verificado**. `stopPropagation` isola os botões do drag/clique do card.

**Como desligar:** `GAMIF_GATE=0` → some o rodapé de entrega (kanban normal) e o servidor ignora os 3 handlers.

**QA feito (tudo ✅):**
- Card em "Feito" mostra "📤 Entregar"; card em outras colunas não tem gate.
- Modal: prova inválida ("isso nao e um link") → erro "Cole um link válido (começa com http…)". Válida → entrega.
- Entregue → selo "⏳ aguardando verificação", 🔗 prova clicável, "entregue por pedro"; servidor:
  `delivered=true, verified=false, deliveredBy=pedro, proof/note ok` (escrow, sem creditar).
- Verificar → "✅ Verificado" verde, sem botões; servidor `verified=true`.
- Devolver → reverte ao botão "Entregar"; servidor limpo.
- Clicar no título do card ainda abre o editor (regressão do kanban OK — stopPropagation só na seção de entrega).
- **OFF** (`GAMIF_GATE=0` via .env temp): card de Feito sem seção de entrega (0 botões); servidor ignora
  `task:deliver` (delivered continua false). Client E servidor desligados.
- Voz/movimento intactos (F2 não toca voz; confinado a schema/store/handlers/kanban).
- Review (general-purpose): aprovado, 0 crítico. Escrow íntegro, sem XSS, flag guarda as 2 pontas.

**Riscos/decisões tomadas sozinho:**
- **Sub-estados no card de "Feito"** (não novas colunas Entregue/Verificado): menos disruptivo ao board atual,
  casa com "selo provisório no card de Feito" do prompt. As colunas seguem Backlog/A fazer/Fazendo/Travado/Feito.
- **`task:verify` manual incluído no F2** (sem creditar) pra o gate ser testável de ponta a ponta. Em F3 a IA
  vai setar `verified` automaticamente na entrega. Crédito de PE/XP só em F6.
- **Servidor aceita `proof` não-http** (só exige não-vazio); o link clicável só aparece se for http(s). A DoD do
  design permite "ID de envio" além de link, então não travei no servidor. Via UI normal sempre vai http(s).
- **Fail-open do /config** (herdado do F0): se /config falhar no boot, client mostra "Entregar" mas o servidor
  (autoritativo) faz no-op se o gate estiver off — descasamento transitório de UX, não de dados.

**Ficou de fora:** verificação automática por IA (é o F3); crédito de pontos (é o F6); aceite-automático após N dias
(não implementado — pode entrar no F6/F9).

---

## ✅ REVIEW COMPLETO F0–F2 (checkpoint "a cada 3 features") — tratado
Rodado um review de alto esforço (8 ângulos × verificação adversarial, ~48 agentes). 10 achados; consolidados
e tratados. **Commit das correções:** (ver `git log` — "fix(gamificacao): hardening do gate + login").

**Corrigidos (no escopo, com QA):**
- **A — escrow furado ao sair de "Feito":** `markColumn` agora chama `resetDelivery(t)` quando o card sai de
  "feito" (retrabalho). Antes, um card Verificado voltava do "fazendo" ainda ✅ com a prova antiga, sem reentrega.
  QA: entregar+verificar → mover pra fazendo → TODOS os campos de entrega zerados. ✅
- **C — reentrega forjada sobrescrevia o carimbo:** `task:deliver` agora ignora se `t.delivered` já é true
  (precisa "Devolver" antes). QA: 2º deliver não muda `deliveredAt`/`proof`. ✅
- **D — servidor aceitava prova não-URL:** `task:deliver` agora exige `^https?://` (espelha o cliente).
  QA: deliver com proof="ok" → rejeitado (delivered fica false). ✅
- **E — `board:archiveDone` arquivava card em escrow:** agora pula `delivered && !verified` (servidor + contador
  do cliente). QA: card entregue-não-verificado não arquiva; depois de verificar, arquiva normal. ✅
- **B — `task:verify` sem carimbo de quem verificou:** add `verifiedBy`/`verifiedAt` (schema+store+loader+persist).
  NÃO bloqueio self-verify de propósito: o design (Parte B) permite o **dono da conta** assinar a própria entrega;
  o controle anti-conluio é o registro de `verifiedBy` (pro F6 sinalizar "mesmo par se aprova >X%"), não um bloqueio.
  QA: verify → `verifiedBy="pedro"`, `verifiedAt>0`. ✅
- **G — `/login` sem rate-limit (PIN 4-8 díg brute-forçável):** add limiter em memória por membro (5 PINs errados →
  30s de cooldown, 429). QA: 6ª tentativa do Pedro bloqueada; outro membro não afetado. ✅

**Registrado como decisão/risco (NÃO corrigido agora):**
- **F — login trust-on-first-use + `/members` público = tomada de identidade.** É o modelo de auth da Etapa 0b
  (pré-branch, decisão do dono). Cenário: atacante lê `/members`, chama `/login` com o nome de um colega que ainda
  não logou + PIN próprio → cria o PIN dele. **Mitigação parcial já feita:** o rate-limit (G) atrasa varredura do
  roster. **Recomendação pro dono (olho humano):** decidir o modelo — ex.: provisionar PINs fora de banda, ou exigir
  um segredo de convite no 1º acesso, ou aceitar o risco (time de 5, identidade de gamificação, baixo valor;
  socialmente detectável). Não mexi sozinho no modelo de auth à noite — é chamada de produto do dono.
- **Fail-open do `/config`** (F0): se `/config` falha no boot, o cliente assume tudo-ON; o servidor (autoritativo)
  ainda faz no-op nos handlers desligados. Descasamento transitório de UX, não de dados. Aceitável.

---

## F3 — Nota da IA (Haiku 4.5) ✅ FEITO
**Commit:** (ver `git log`) · **Flag:** `GAMIF_AIREVIEW` (default ON). **Desligar:** `GAMIF_AIREVIEW=0`.

**O que entrou:**
- `server/src/gamification/aiReview.ts` (novo) — `reviewDelivery({title,desc,client,unit,proof,note})` chama
  Haiku 4.5 (`claude-haiku-4-5-20251001`) com a Definition of Done + dados da entrega → `{score 0-10, note}`.
  **Degrada sempre pra `null`** (sem chave, erro de API, timeout 12s, parse ruim) — NUNCA lança. A
  `ANTHROPIC_API_KEY` é lida do ambiente e **nunca logada** (o catch loga só `error.message`).
- `server/src/rooms/OfficeRoom.ts` — no `task:deliver`, se `GAMIF_AIREVIEW` on, dispara `runAiReview` em
  **2º plano** (fire-and-forget, não bloqueia o board). `runAiReview` re-busca a tarefa antes de aplicar
  (ignora resultado tardio se foi devolvida/movida/já verificada):
  - **score >= 7** → `verified=true`, `verifiedBy="IA"`, `aiScore`/`aiNote` PÚBLICOS (glória) + toast privado positivo.
  - **4-6 (parcial) / <4 (baixo)** → NÃO verifica; `aiScore` fica -1 (card neutro "aguardando", sem nota pública);
    feedback **SEMPRE PRIVADO** ao responsável via `client.send("ai:feedback")`.
  - **null (degradou)** → fica em escrow (verificação manual, igual F2) + toast privado "IA indisponível".
- `Task`: `aiScore` (-1=não avaliada; 0-10 só quando aprovou) + `aiNote` (justificativa pública). Espelhados em
  store/loader/persist; `resetDelivery` também os zera.
- `client/src/ui/kanban.ts` — selo verde mostra "✅ Verificado · IA X/10" (+ justificativa no hover) quando a IA aprovou.
- `client/src/scenes/OfficeScene.ts` — `room.onMessage("ai:feedback")` → `showAiFeedback`: banner PRIVADO no topo,
  **z-index 10080 (acima do kanban)**, cor por status (verde/âmbar/roxo/cinza), some em 10s ou ao clicar.
- SDK: `@anthropic-ai/sdk@^0.106.0` em `server` (import dinâmico → compila pra `require`; **testado no build de prod**).

**Como desligar:** `GAMIF_AIREVIEW=0` → `task:deliver` não chama a IA; entrega cai no fluxo manual do F2 (sign-off
no botão "✓ Verificar"). Igual ao comportamento sem chave.

**QA feito (tudo ✅):**
- Entrega BOA ("Landing page... publicada", desc completa) → IA deu **9/10** → card auto-verificado
  "✅ Verificado · IA 9/10" (público) + toast verde privado "IA aprovou (9/10)".
- Entrega RUIM ("coisa", desc vazia) → IA deu nota baixa → card fica **neutro "⏳ aguardando"** (sem nota pública),
  feedback foi **privado** ao Pedro. Vergonha privada preservada.
- **Sem chave:** `reviewDelivery` → `null` (degrada, sem lançar). Testado isolado.
- **Build de prod (`node dist`):** chamada real ao Haiku retornou nota → import dinâmico (require) funciona em prod.
- Toast privado renderiza ACIMA do kanban (z-index 10080) — screenshot.
- Board nunca trava: deliver é síncrono, IA roda async com timeout 12s + try/catch.
- **OFF (`GAMIF_AIREVIEW=0`):** coberto por composição — a guarda `if (getFlags().aiReview)` é o mesmo padrão do
  `gate` (testado OFF) e o teste **sem chave** já exercita o MESMO comportamento observável (escrow manual, sem
  auto-verify, sem nota pública). Para desligar de fato: `GAMIF_AIREVIEW=0`.

**Riscos/decisões tomadas sozinho:**
- **Privacidade da nota:** `aiScore`/`aiNote` no schema sincronizado só são preenchidos quando a IA APROVA (>=7).
  Nota baixa/parcial NUNCA vai pro schema público — só pro toast privado do responsável. Respeita "vergonha privada".
- **Degradação = deixa PENDENTE** (escrow manual), não credita provisoriamente. Mais seguro: nada é "aprovado" sem
  avaliação real. O sign-off manual (F2) continua disponível.
- **A IA não abre o link de prova** (é chamada server-side de texto). O prompt deixa isso explícito; a nota é um
  sinal heurístico de completude, com o humano podendo dar/!dar o sign-off manual por cima.
- **`verifiedBy="IA"`** distingue verificação automática de sign-off humano (útil pro F6/anomalias).

**Ficou de fora:** crédito de PE/XP (F6 — hoje verified só libera o selo); reavaliação ao reentregar é automática
(novo deliver dispara nova IA).

---

## ✅ REVIEW COMPLETO APÓS F3 — tratado
Review de alto esforço (8 ângulos × verificação, ~48 agentes) sobre o delta (correções + F3). 10 achados,
4 temas distintos, todos CONFIRMED e **corrigidos**. **Commit:** (ver `git log` — "fix(gamificacao): corrige race da IA...").

- **RACE no `runAiReview` (entrega devolvida+reentregue na janela da IA):** a IA leva ~12-24s; se a entrega era
  devolvida e reentregue nesse meio, o veredito ANTIGO aplicava na entrega NOVA (auto-verificava conteúdo que a IA
  nunca viu; nota pública errada). **Fix:** captura `deliveredAt0` antes do `await` e aborta se `t.deliveredAt`
  mudou (além de devolvida/movida/verificada). **QA:** entregar→devolver na janela → o veredito obsoleto abortou
  (tarefa não verificada, aiScore=-1). ✅
- **Feedback privado perdido na reconexão:** o `ai:feedback` ia pro `sessionId` capturado no deliver; se o
  responsável reconectava (sessionId muda) o toast evaporava. **Fix:** `findDeliverer` roteia pelo `memberId` atual
  (sobrevive à reconexão); convidado cai no sessionId. Se sair de vez, perde o toast (aceitável — reentrega/vê o
  estado ao voltar).
- **`deliverNote` privada vazando pro `aiNote` público:** numa entrega aprovada (>=7), a IA podia parafrasear a
  nota privada do responsável dentro da justificativa pública. **Fix:** a `deliverNote` NÃO entra mais no prompt da
  IA (privacidade > qualidade marginal da nota; desc + prova bastam pro score).
- **Rate-limit fraco:** resetava `fails:0` → 5 tentativas novas a cada 30s (PIN 4-díg cairia em ~16h). **Fix:**
  backoff PROGRESSIVO (cooldown dobra a cada bloqueio: 30s→1m→2m→…→1h, `lockouts` não zera) + prune do Map quando
  cresce. **QA:** 5 erros → 429 (regressão do gate OK). Brute-force vira inviável.

---

## F4 — Atraso amigável ✅ FEITO
**Commit:** (ver `git log`) · **Flag:** `GAMIF_OVERDUE` (default ON). **Desligar:** `GAMIF_OVERDUE=0`.

**O que entrou:**
- `Task.blockReason` (motivo curto do "Travado") + espelho em store/loader/persist.
- `OfficeRoom`: `markColumn` limpa `blockReason` ao SAIR de "travado"; handler `task:block` (gated por
  `getFlags().overdue`, só se `col==="travado"`, clamp 120).
- `client/src/ui/kanban.ts`:
  - `daysToDue(committedDue, due, col)` — usa o prazo CONGELADO (committedDue, anti-empurrar-prazo); null em
    "feito"/"travado" (relógio pausado).
  - `overdueChip` escalonado com **tom de socorro**: 🟡 "⏳ vence em Xd" (1-2d) · 🟠 "📅 vence hoje" · 🔴 "🆘 Xd
    atrasada" (1-5d, tip "precisa de ajuda?") · 🔴 "🆘 Xd — resgate" (6+d, "missão de resgate: quem ajuda?").
    Mais de 2 dias no futuro → sem chip.
  - Gate por `getFlags().overdue`; flag OFF → chip antigo "Xd atraso". Chip 🚧 do motivo em cards travados.
  - `maybePromptBlock` (window.prompt → `task:block`) ao ENTRAR em travado (no drag e no editor).
  - Filtro "só atrasados" alinhado ao chip (`daysToDue<0`) com flag on.

**Como desligar:** `GAMIF_OVERDUE=0` → volta ao chip vermelho "Xd atraso" (inclusive contando travado como atrasado,
como era antes); `task:block` vira no-op.

**QA feito (tudo ✅):**
- Chips escalonados conferem por prazo: +1d→🟡"vence em 1d", hoje→🟠"vence hoje", -3d→🔴"🆘 3d atrasada",
  -7d→🔴"🆘 7d resgate", +10d→sem chip. Tons de socorro nos tooltips. (screenshot)
- **Travado pausa:** mover card pra travado → some o chip de atraso. `task:block` → chip "🚧 motivo".
- `maybePromptBlock` (prompt sobrescrito no QA) → `task:block` na ordem certa (move→block) → blockReason setado.
- **Destravar** (sair de travado) → `blockReason` limpa.
- **OFF** (mutei `window.__gam.flags().overdue=false` + re-render): card volta ao chip antigo "3d atraso", sem
  chip escalonado. ✅
- Voz/CRUD/drag intactos (F4 é só kanban; review confirmou que não toca voz).
- Review (general-purpose): sem bug crítico; XSS ok (textContent), gate nos 2 lados, ordem de msg ok.

**Riscos/decisões tomadas sozinho:**
- **Off-by-one entre fusos (committedDue em ms):** o committedDue é parseado no fuso do SERVIDOR e o dia é
  derivado no fuso do CLIENTE. Pro time BR (single-TZ, servidor BR/UTC, prazo às 23:59:59) NÃO dá off-by-one
  (23:59 UTC ainda é o mesmo dia em BRT). Risco só existiria com cliente em fuso muito distante do servidor —
  não é o caso. Não re-arquitetei o committedDue (é number ms por design da Etapa 0a). RISCO ACEITO/documentado.
- **Cancelar o prompt de motivo** deixa o card travado SEM motivo (relógio pausado mesmo assim). Coerente com o
  tom "pede, não exige" do design (não forçar). O card fica visível na coluna Travado. Aceitável.

**Ficou de fora:** botão "chamar reforço" no card 🔴 (é o F5, que reusa a infra de chamar/notificar).

---

## F5 — Visão própria + Clima do escritório ✅ FEITO
**Commit:** (ver `git log`) · **Flag:** `GAMIF_CLIMATE` (default ON). **Desligar:** `GAMIF_CLIMATE=0`.

**O que entrou:**
- `client/src/util/overdue.ts` (novo) — `daysToDue` extraído do kanban (reuso kanban + mundo).
- `client/src/scenes/OfficeScene.ts`:
  - **Nuvem privada** `localCloud` 🌧️: SÓ sobre o MEU avatar, SÓ eu vejo (não sincroniza, não aparece em remotos —
    privada por construção). Visível quando EU tenho tarefa atrasada. Criada antes da uiCam → ignorada pelo HUD.
  - **Clima do escritório** (badge DOM, agregado SEM nomes): "☀️ Escritório em dia" / "🌧️ N pedindo reforço" +
    botão "🆘 chamar reforço". Timer de recálculo (3s) lê o board e separa total (clima) de meu (nuvem).
  - `callBackup` → `help:call`; `onMessage("help:called")` → toast "🆘 <nome> pediu reforço!".
  - Cleanup no SHUTDOWN + reset defensivo no create().
- `server/src/rooms/OfficeRoom.ts` — `help:call` (gated por `getFlags().climate`) → broadcast `help:called` {name do
  CHAMADOR} exceto ele. O nome que aparece é de quem PEDIU ajuda (ato voluntário, cooperação), nunca de quem atrasou.

**Como desligar:** `GAMIF_CLIMATE=0` → sem nuvem, sem badge, sem broadcast (gate nas 2 pontas).

**QA feito (tudo ✅):**
- Badge mostra "🌧️ 1 entrega pedindo reforço" com a tarefa real atrasada do Pedro; nuvem 🌧️ sobre o avatar dele (screenshot).
- **Agregado vs meu / privacidade:** criei tarefa atrasada da Ana → clima vira "2" (total), mas meu atraso/nuvem fica
  "1" (só Pedro). Tarefa da Ana NÃO bota nuvem no Pedro. ✅
- **Chamar reforço:** clique → toast "🆘 Reforço chamado pro time!"; servidor faz broadcast (handler do outro lado wired).
- **OFF** (flag mutado pra false): badge não recria, nuvem invisível. ✅
- Voz/update/kanban intactos (nuvem é world-object ignorado pela uiCam; timer independente do voiceBgTimer).
- Review (general-purpose): privacidade central OK, gate nos 2 lados, sem leak (corrigido o reset defensivo no create()).

**Riscos/decisões tomadas sozinho:**
- **"Minha tarefa" por nome de exibição** (`assignee === loadSelection().name`), coerente com o modelo (o assignee no
  kanban É o nome do membro, não o memberId). Edge de homônimo: 2 membros de mesmo nome → um veria a própria nuvem
  acender por tarefa do outro — mas SÓ na tela dele (não vaza pra terceiros). Time de 5 com nomes distintos → não
  acontece. RISCO ACEITO/documentado.
- **Clima recalcula por timer (3s)** em vez de listener do board (o OfficeScene não tem listener próprio de tasks; o
  kanban tem). 3s é barato (forEach em dezenas de cards). Decisão pragmática.
- **Off-by-one entre fusos** (herdado do daysToDue): mesmo do F4, risco nulo pro time BR.

**Ficou de fora:** sugerir "quem está online e perto" pra reforço (o broadcast vai pra todos; refinamento futuro).

---

## F6 — Progressão PE/XP/Nível ✅ FEITO
**Commit:** (ver `git log`) · **Flag:** `GAMIF_PROGRESSION` (default ON). **Desligar:** `GAMIF_PROGRESSION=0`.

**O que entrou (engine no SERVIDOR, idempotente):**
- `server/src/progress/store.ts` — `MemberProgress` ganhou `weeks` (PE/semana), `delivered`, `lastDeliveryAt`
  (migração defensiva v1→v2 no loader). Funções: `xpForLevel(L)=round(40·(L-1)^1.35)` (L1=0, L2=40, L3≈102),
  `levelFromXp` (teto Lv50), `awardPE`, `clawbackPE`, `getProgressView` (nível, XP no nível, weekPE, baseline,
  **% vs própria média** — nunca ranking).
- `Task` — `scoreAwarded` (idempotência: PE creditado por esta entrega), `size` ("PP".."GG"), `clientWeight`
  (70/100/150). Espelhados em store/loader/persist.
- `server/src/rooms/OfficeRoom.ts` — `computePE = SIZE_PE[size] × (clientWeight/100) × FatorPrazo`
  (FatorPrazo ×0.6 se `deliveredAt > committedDue`); `creditIfVerified` (chamado no `task:verify` E no
  `runAiReview` >=7, guardado por `scoreAwarded>0`); clawback no `resetDelivery` (devolução/retrabalho);
  `task:create`/`task:update` aceitam size+clientWeight; `onJoin` re-hidrata e manda `progress:self` privado;
  `sendProgressTo` acha o cliente do membro creditado.
- `client/src/ui/kanban.ts` — editor ganhou selects **Tamanho** + **Peso do cliente** (só com flag on).
- `client/src/scenes/OfficeScene.ts` — HUD discreto (canto inf-esquerdo): "⭐ Nível N · X entregas", barra de XP no
  nível, "X/Y XP · % da sua média / N PE esta semana". Atualiza via `onMessage("progress:self")`.

**Como desligar:** `GAMIF_PROGRESSION=0` → sem crédito de PE, sem HUD, sem selects de size/peso no editor.

**QA feito (tudo ✅):**
- Engine (node, build de prod): award +12 → xp12/lvl1; 4×12=48 → lvl2 (cruza 40); clawback → lvl volta; persiste
  `weeks`/`delivered`; cria registro sem PIN pra quem não logou.
- Fórmulas: `xpForLevel` L2=40/L3=102; `levelFromXp` boundaries 39→1, 40→2, 102→3.
- Integração (browser): tarefa GG+estratégico → **PE=12** (8×1.5×1.0, número bate); HUD "Nível 1 · 12/40 XP · 12 PE".
- **Idempotência:** 2× `task:verify` → scoreAwarded continua 12 (sem dobrar).
- **Clawback:** `task:undeliver` → xp/HUD voltam a 0.
- **Persistência:** `server/data/progress.json` com Pedro xp:12; **re-hidratação no reconnect** → HUD volta com 12 no join.
- **OFF** (flag mutado): HUD não recria; servidor não credita (mesmo padrão de guarda).
- HUD convive com clima (F5) e nuvem; voz/kanban intactos.

**Riscos/decisões tomadas sozinho:**
- **Credita o ASSIGNEE** (`normId(t.assignee)`) — o responsável pelo trabalho. Edge: se reassignar entre creditar e
  devolver, o clawback bate no novo assignee (raro; documentado). PE só credita se há assignee.
- **Nível segue o XP no clawback** (escrow revogado pré-aceite). O design diz "nível nunca regride" pro estágio
  CONFIRMADO (aceite-auto após N dias, não implementado); no escrow a revogação é válida. Documentado.
- **FatorPrazo simples** (no prazo ×1.0 / atrasado ×0.6). O ×1.0 de "atraso por dependência externa" (travado
  aguardando_cliente) não foi implementado (o blockReason some ao destravar) — refinamento futuro.
- **% vs baseline** = média das últimas até-4 semanas anteriores; sem base ainda → mostra "N PE esta semana" (sem
  número de %). NUNCA é ranking entre pessoas, e o % nunca pune (só informa).
- **HUD por mensagem privada** (`progress:self`), não por schema no Player — mantém o XP do indivíduo fora do estado
  público (o nível público pra cosméticos vem no F8 se preciso).
- **Sem backdoor de XP** pra QA (segurança): testei via entregas reais + node. (Os `window.__gam` dev-helpers
  existentes — flags/reloadConfig — ficam; não adicionei injeção de XP no servidor.)

**Ficou de fora:** aceite-automático após N dias úteis; streak/buffs voláteis (parte no F7/F9); UI de "size travado
ao entrar em fazendo" (anti-sandbagging — o campo existe, a trava é refinamento).

---

## ✅ REVIEW COMPLETO APÓS F6 (F4+F5+F6) — tratado
Review de alto esforço (8 ângulos × verificação, ~55 agentes). 10 achados, 4 temas (vários eram o mesmo root),
todos CONFIRMED e **corrigidos**. **Commit:** (ver `git log` — "fix(gamificacao): corrige reassign/semana/clima/travado").

- **A — reassign/rename desviava crédito e clawback:** o PE era creditado ao assignee no verify, mas o clawback usava
  o assignee ATUAL → se reatribuísse/renomeasse no meio, estornava a pessoa errada e o XP do creditado ficava órfão.
  **Fix:** `Task.awardedTo` (carimba QUEM recebeu) + `awardedWeek`; `creditIfVerified` grava, `resetDelivery` estorna
  POR `awardedTo`/`awardedWeek` (não pelo assignee atual). **QA end-to-end:** creditou Ana → reassign p/ Pedro →
  devolveu → estornou a **Ana** (volta a 0), **Pedro intocado** (não foi debitado). ✅
- **B — clawback estornava na semana ERRADA:** `clawbackPE` usava `weekKey(now)`, não a semana do crédito → inflava
  a semana antiga e corrompia o baseline. **Fix:** `clawbackPE(memberId, pe, week)` estorna na semana carimbada
  (`awardedWeek`). **QA (node):** clawback na semana do crédito zera certo; semana errada não toca a do crédito. ✅
- **C — `recomputeClimate` comparava nome case-sensitive** (F5) enquanto o resto usa `normId` → a nuvem privada
  sumia por diferença de caixa. **Fix:** comparação normalizada (`trim().toLowerCase()` nos dois lados) + passa
  `blockedMs` ao `daysToDue`. ✅
- **D — "Travado" não pausava o relógio DE VERDADE** (F4): só escondia o chip; ao destravar, o atraso inteiro
  (incluindo dias bloqueados) reaparecia, punindo bloqueio legítimo. **Fix:** `Task.blockedMs`/`blockedAt`
  acumulam o tempo em Travado em `markColumn`; `daysToDue` e `computePE` ESTENDEM o `committedDue` por `blockedMs`
  (bloqueio externo não vira atraso). **QA:** blockedMs acumula o tempo real parado; deadline estende. ✅
  (Isso também habilita o FatorPrazo ×1.0 do design pra atraso por dependência externa.)

Todos verificados (server-side determinístico + end-to-end no browser) e re-typecheck verde.

---

## F7 — Stats upside-only ✅ FEITO
**Commit:** (ver `git log`) · **Flag:** `GAMIF_STATS` (default ON). **Desligar:** `GAMIF_STATS=0`.

**O que entrou:**
- `server/src/schema/Player.ts` — `maxHp` (uint8 100), `dmg` (uint8 20), `level` (uint8 1), sincronizados.
- `server/src/rooms/OfficeRoom.ts`:
  - `statsFor(level)` — `maxHp=100+min(lvl*2,20)` (100..120), `dmg=20+min(lvl,6)` (20..26). **Baseline 100/20**
    quando `!getFlags().stats` (flag off) — sempre upside.
  - `applyStatsTo(memberId,level)` — aplica ao vivo a TODAS as sessões do membro; **SÓ SOBE** (`Math.max`),
    nunca rebaixa mid-sessão (clawback não pune o combate); level-up CURA (hp=maxHp). Guarda de flag própria.
  - `onJoin` re-hidrata stats do nível persistido; **convidado = 100/20 puro**; entra com vida cheia.
  - `hit` usa o **dmg do ATACANTE** (era fixo 20).
  - `creditIfVerified` chama `applyStatsTo` no crédito (sobe stats no level-up).
- `client/src/scenes/OfficeScene.ts` — barra de HP agora é **hp/maxHp** (cor pela proporção); `myMaxHp` lê
  `meState.maxHp`; remotos usam `p.maxHp`.

**Como desligar:** `GAMIF_STATS=0` → `statsFor` retorna baseline 100/20 (sem bônus), HP bar vira hp/100 efetivo
(maxHp=100), dano fixo 20. Convidados já são baseline.

**QA feito:**
- Membro nível 1 → Player.maxHp=102, dmg=21, hp cheio (statsFor + onJoin). ✅
- **Level-up ao vivo:** creditei Pedro a nível 2 → maxHp 104, dmg 22, hp curado pra 104 (applyStatsTo), HUD "Nível 2". ✅
- **HP bar hp/maxHp:** testado o render — hp 52/maxHp 104 → barra 50% amarela; 104/104 → cheia verde. ✅
- **Upside-only:** applyStatsTo usa Math.max (nunca abaixa); clawback NÃO chama applyStatsTo (combate não regride mid-sessão). ✅ (review confirmou)
- **OFF** (`GAMIF_STATS=0` via .env + restart, /config = stats:false): coberto por composição — `statsFor` retorna
  `{100,20}` literal quando off (sem lógica que possa falhar) + gate é o mesmo padrão provado; convidado=100/20
  confirma o caminho baseline. (A verificação ao vivo do join-OFF ficou bloqueada pela instabilidade do Chrome
  headless após N restarts — não é problema de código.)
- Voz por proximidade INTOCADA (review confirmou: hit/HP/stats não tocam voz/áudio). uint8 não estoura (≤120/≤26).
- Review (general-purpose): sólido, 0 crítico.

**Riscos/decisões tomadas sozinho:**
- **Nível 1 já dá +2 HP / +1 dmg** (statsFor(1)=102/21), seguindo a fórmula do design (min(level×2,20)). "Ninguém
  abaixo de 100" é respeitado (102≥100). Convidado fica em 100/20 puro (sem progressão).
- **Clawback não rebaixa o combate** ao vivo (só o XP/nível persistido cai). No PRÓXIMO join os stats recomputam do
  nível (menor) — fresh session, não punição mid-sessão. Alinha com "HP de combate é volátil; trabalho é persistente".
- **Combate balanceado:** 120 HP / 26 dmg ≈ 5 acertos (= baseline 100/20). Não trivializa.
- **regen + escudo** (do design §2.3) ficaram de fora: precisam de `setSimulationInterval` (tick do servidor, que
  não existe) + tracking de streak. O CORE (+maxHp/+dmg) entrega o "upside-only" visível. Refinamento futuro.

**Ficou de fora:** regen/escudo (sim-interval + streak); demo de dano em combate real (precisa de 2 jogadores — o
dono valida abrindo 2 abas e jogando bola de fogo; a lógica `hit` usa attacker.dmg, verificado por código).
