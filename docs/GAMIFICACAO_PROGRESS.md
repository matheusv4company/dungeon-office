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
