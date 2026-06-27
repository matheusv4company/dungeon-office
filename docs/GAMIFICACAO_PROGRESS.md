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
