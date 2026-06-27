# Gamificação do Escritório — Design de referência (pesquisa multi-agente)

> Gerado por uma pesquisa de 17 agentes. Fonte de verdade do DESENHO. O passo a passo de execução vive no prompt mestre / docs/GAMIFICACAO_EXECUCAO.md.

## Parte A — Sistema de progressão RPG (economia, níveis, cosméticos, dados)

Vou projetar o sistema integrado. Já tenho todo o material necessário (mapa de código, pesquisa, críticas). Entrego direto o documento.

# Sistema Integrado de Progressão RPG ligado ao Gestor de Tarefas
## Escritório Virtual — design implementável, com números

> **Princípio-mestre (decorre das 4 críticas + 8 pesquisas):** o sistema **só soma, nunca subtrai do corpo público da pessoa**; recompensa nasce da **entrega confirmada ao cliente** (nunca do clique em "Feito"); a pontuação é **chaveada por `memberId` estável**, calculada **no servidor**, **normalizada por taxa** (não volume); o **HP de combate e o "poder de trabalho" são duas barras separadas**; e o atraso é **propriedade do CARD**, mostrado de forma privada/agregada, **nunca um debuff no avatar à vista dos pares**.

Antes dos 6 entregáveis, três travas inegociáveis que atravessam tudo (consenso das 4 críticas):

| Trava | Regra | Mata o risco |
|---|---|---|
| **T1 — Gate de entrega** | XP só pinga em `Entregue+Verificado` com prova, `completedAt` carimbado pelo servidor, `committedDue` travado no início. Nunca em "Feito". | Goodhart / "Feito" falso / Wells Fargo |
| **T2 — Duas barras** | `hpCombat` (volátil, do RPG, reseta) ≠ `workScore/level` (persistente, imune a fireball). Atraso nunca tira HP. | PvP vira arma de humilhação; punição por trabalho |
| **T3 — Glória pública, vergonha privada** | Positivo é público e aditivo; atraso é do card + privado pro responsável + agregado pro time. Sem ranking individual. | Pelourinho digital num time de 5 |

---

## 1. A moeda: **Pontos de Entrega (PE)** — pesados e normalizados

### 1.1 Por que não "pontos por card"
Pontuar card contado é injusto entre papéis (Marketing = 30 cards pequenos/mês; IA = 3 features longas) e gameável (fatiar 1 tarefa em 8). A moeda pesa **tamanho × cliente** e é **modulada por prazo**, mas o **placar é por TAXA**, não por soma bruta.

### 1.2 Fórmula

```
PE_base(card) = Tamanho × PesoCliente

PE_creditado(card) = PE_base × FatorPrazo × FatorRetrabalho
```

**Tamanho** (T-shirt, definido na criação/refino por quem NÃO executa — anti-sandbagging; auto-sugerido pela IA, confirmado em 1 clique; travado ao entrar em "Fazendo"):

| Size | PP | P | M | G | GG |
|---|---|---|---|---|---|
| valor | 1 | 2 | 3 | 5 | 8 |

**PesoCliente** (WSJF-lite, definido pelo dono/account, não pelo executor):

| Classe | estratégico/crítico | normal | interno/baixa criticidade |
|---|---|---|---|
| fator | ×1.5 | ×1.0 | ×0.7 |

**FatorPrazo** — modulação suave (a parte que o dono pediu), comparando `deliveredAt` (servidor) com `committedDue` (travado):

| Situação | Fator | Lógica |
|---|---|---|
| No prazo (`deliveredAt ≤ committedDue`) | **×1.0** (cheio) | baseline = recompensa plena |
| Atrasado mas entregue | **×0.6** | ainda entregar vale a pena (Habitica: +3 por atrasado vs +10 no prazo) |
| Atraso por dependência externa (estava em "Travado: aguardando cliente") | **×1.0** | relógio pausado — culpa não é da pessoa |

> **Decisão-chave anti-punição:** o "no prazo" é um **bônus de não-redução**, não a única fonte de pontos. Quem atrasou ainda ganha 60%. Atraso = **ganhar menos**, nunca **perder** (consenso das 4 críticas + pesquisa overjustification).

**FatorRetrabalho** — clawback se o cliente devolve:

| Situação | Fator |
|---|---|
| Aprovado / aceite automático após 5 dias úteis | ×1.0 |
| Devolvido pelo cliente (retrabalho) | PE daquele ciclo **revogado** (escrow), recredita ao reentregar |

### 1.3 Exemplos numéricos

| Card | Size | Cliente | Prazo | PE_base | FatorPrazo | **PE creditado** |
|---|---|---|---|---|---|---|
| Landing page, cliente estratégico, no prazo | G=5 | ×1.5 | no prazo | 7.5 | ×1.0 | **7.5** |
| 10 ajustes de campanha (P=2 cada), cliente normal, no prazo | 10×2=20 | ×1.0 | no prazo | 20 | ×1.0 | **20** |
| Feature IA (GG=8), estratégico, atrasada por culpa própria | 8 | ×1.5 | atraso | 12 | ×0.6 | **7.2** |
| Relatório interno (M=3), no prazo | 3 | ×0.7 | no prazo | 2.1 | ×1.0 | **2.1** |
| Criativo (G=5), estratégico, atraso porque cliente sumiu (estava em Travado) | 5 | ×1.5 | externo | 7.5 | ×1.0 | **7.5** |

Repare: o gestor de tráfego (20 PE em microajustes) e o dev de IA (7.2 numa feature) ficam **na mesma ordem de grandeza** — o peso resolve a cadência. E ninguém é punido por dependência de cliente.

### 1.4 Justiça entre papéis: **placar é % sobre o próprio baseline**
O **número absoluto de PE NUNCA é comparado entre pessoas** (story points entre papéis não são a mesma moeda — anti-padrão Scrum confirmado). O que se exibe:

```
Desempenho_pessoal = PE_da_semana / baseline_pessoal
baseline_pessoal = média móvel de PE/semana das últimas 4 semanas
```

Cada um joga **contra si mesmo da semana passada**. Marketing e IA têm **baselines e agregados separados** (campo EMPRESA já existe). **Sem leaderboard 1-5.**

---

## 2. Progressão XP → níveis → poder (com teto e decay suave)

### 2.1 XP vem do PE confirmado
`XP += PE_creditado` no evento `Entregue+Verificado` (T1). Só aí.

### 2.2 Curva híbrida (log no início, platô no fim — anti "impossível no fim", anti-elite-permanente)

```
XP_para_nivel(n) = round(40 × n^1.35)
```

| Nível | XP acumulado p/ atingir | PE/semana medianos p/ chegar |
|---|---|---|
| 1 | 0 | início |
| 2 | 40 | ~1 boa entrega |
| 3 | ~103 | onboarding rápido (endowed progress: começa com 20% da barra do Lv2 "de presente") |
| 5 | ~327 | ~2-3 semanas |
| 8 | ~736 | ~5-6 semanas |
| 10 | ~1060 | platô de poder atingido aqui |
| 12+ | linear suave (+120/nível) | só cosmético/título daqui pra frente |

> Poder funcional **satura no Lv10**. Acima disso só desbloqueia cosmético e título (escassez sem casta de combate).

### 2.3 Nível/consistência → poder (a barra de TRABALHO, separada do combate — T2)

Três stats derivados, **re-hidratados no `onJoin`** a partir do registro persistente:

| Stat | Fórmula | Teto | Efeito |
|---|---|---|---|
| **maxHpBonus** | `min(level × 2, 20)` | +20 (Lv10) | HP máx do combate vai de 100→120. Só **upside**: quem está atrás continua com 100, nunca menos |
| **dmgBonus** | `min(level, 6)` | +6 (Lv6) | fireball de 20→26 (~+30%). Combate continua "5-6 acertos matam", nunca trivializado |
| **regen** | `1 HP / (12 − streak)s`, mín 6s | streak≥6 → 6s | regen fora de combate; consistência acelera |
| **escudo** | streak≥3 → `shield=10` no join | 10 | absorve antes do HP no combate |

**streak** = semanas consecutivas em que a pessoa entregou ≥80% no prazo (ver §2.5).

> Por que só upside: três críticas independentes apontaram que dar **menos HP a quem rendeu menos** transforma o PvP existente (fireball) numa arma contra o colega fragilizado. Logo: **todo mundo tem ≥100 HP sempre**; bom desempenho dá teto maior e regen, mau desempenho dá o baseline normal. Ninguém fica "mais fácil de matar" por ter tido uma semana ruim.

### 2.4 O que acontece no atraso — **nada no corpo, decay só no buff temporário**

| Evento | Consequência |
|---|---|
| Atraso isolado | **Nenhuma** perda de XP/nível/HP. Apenas não ganha o ×1.0 (ganha ×0.6) |
| Semana sem entregar | streak **pausa** (não zera de raiva) → buffs temporários (regen rápido, escudo) decaem |
| XP acumulado / nível / cosmético | **Nunca regridem.** Permanente. O personagem nunca "fica feio de volta" |

**Decay aplica-se só aos buffs voláteis** (regen, escudo), nunca ao nível ou aos cosméticos ganhos. Isso dá o "loss aversion" natural (Octalysis: quem possui teme perder) **sem punição explícita**.

### 2.5 Streak saudável (obrigatório: leniência embutida — lição Duolingo, −21% churn)
- **Unidade = SEMANA, não dia** (não pune fim de semana/folga).
- **2 "streak freezes"/mês**: folga, doença, cliente sumido → não quebra.
- **Streak de TIME** existe em paralelo ao individual (cooperação, distribui risco social): se a guilda (por empresa) fecha a meta semanal, todos ganham um buff cosmético coletivo.
- Quebrou? **"Repair": entregue 2 cards verificados e recupera** — sem drama, sem vermelho.

---

## 3. Cosméticos — desbloqueios por marco (tecnicamente viável nos 10 sprites)

Tudo abaixo é **programático sobre os sprites existentes** (sem arte nova, exceto 6-10 micro-PNGs de acessório opcionais). Cada efeito mapeia um hook real do `OfficeScene` (ring de voz clonável, `setTint`, partículas `flameDot`, label de nome). **Todos aditivos e permanentes.** Render no mundo precisa de `uiCam.ignore()`.

| # | Cosmético | Como (API real) | Desbloqueio (marco) | Custo arte |
|---|---|---|---|---|
| 1 | **Anel colorido sob os pés** | clonar `localRing`/`ring` (ellipse + strokeStyle), cor por tier | Lv2 | 0 |
| 2 | **Tint do sprite** | `sprite.setTint(0xRRGGBB)` (já usado em paredes) | Lv3 (1ª cor); paleta amplia por nível | 0 |
| 3 | **Aura branca suave (glow)** | `preFX.addGlow()` ou emissor `flameDot` seguindo o player | streak 3 (entregas no prazo) | 0 |
| 4 | **Aura dourada** | mesma, cor dourada | streak 7 | 0 |
| 5 | **Aura dourada pulsante + partículas** | glow + emissor com tween yoyo | streak 14 | 0 |
| 6 | **Título flutuante** no label | `nameLabel.setText("Lv.7 ⚔ Mateus")` / "Guardião da [Cliente]" | Lv5; título de cliente por afinidade | 0 |
| 7 | **Moldura no roster** | `backgroundColor` na linha do roster (texto Phaser) | por nível | 0 |
| 8 | **Cor/efeito da bola de fogo** | tint no orbe + trail | streak 5 | 0 |
| 9 | **Acessório (faixa/capa/coroa)** | `add.image(x,y-off,"crown")` seguindo player, `setDepth(y+1)`, `uiCam.ignore` | 25 / 50 / 100 entregas verificadas (lifetime) | 6-10 micro-PNGs |
| 10 | **Skin-up (evoluir entre os 10)** | `setTexture(charKey(id))` + `ensureCharAnims` | marco trimestral (Soldado→Senhor de Guerra) | 0 (sheets já existem) |

> **Decay estético opcional e gentil:** brilho/aura **ficam adormecidos** (neutro, não feio) enquanto há card travado por culpa própria, e **reacendem ao entregar**. Nunca "afeia" o personagem. Acessórios e nível são **permanentes**.

**Temporadas (anti-inflação + anti-casta):** a cada 4-6 semanas o **status competitivo da temporada** reseta (o "melhor da temporada" vira título colecionável permanente), mas **XP, nível e cosméticos ficam**. Dá chance nova ao novato sem apagar conquistas.

---

## 4. Modelo de dados

### 4.1 Campos novos no `Task` (`schema/Task.ts` + espelhar em `TaskData` no `store.ts`; defaults defensivos no loader)

```ts
@type("number")  createdAt     = 0;     // Date.now() no task:create
@type("number")  committedDue  = 0;     // due (ms) CONGELADO ao entrar em "fazendo" — anti-edição
@type("number")  completedAt   = 0;     // 1ª vez que entra em "feito"; carimbo do SERVIDOR
@type("string")  size          = "";    // "PP|P|M|G|GG" (travado em "fazendo")
@type("number")  clientWeight  = 100;   // 70|100|150 (×0.7/1.0/1.5)
@type("boolean") delivered     = false; // entrega EFETIVA ao cliente (≠ feito)
@type("number")  deliveredAt   = 0;     // carimbo do servidor
@type("string")  deliveredBy   = "";    // quem confirmou (idealmente ≠ assignee)
@type("string")  proof         = "";    // link/print verificável (clamp 300)
@type("boolean") verified      = false; // sign-off de 2ª pessoa / aceite-auto
@type("number")  scoreAwarded  = 0;     // PE já creditado — IDEMPOTÊNCIA (não credita 2x)
@type("number")  dueChanges    = 0;     // nº de alterações de due pós-commit (flag de gaming)
@type("string")  blockReason   = "";    // "" | "aguardando_cliente" | "aguardando_interno" | "bloqueio_tecnico"
```

### 4.2 Registro persistente por MEMBRO (chave estável, sobrevive ao `sessionId` que muda)

Novo `server/src/progress/store.ts` clonando o padrão de `board/store.ts` (debounce 400ms + escrita atômica + `flushSync` no `onDispose`), arquivo `progress.json` no mesmo `BOARD_DIR`. **Chave = `memberId` normalizado** (`trim().toLowerCase()` do nome de membro; entrada por **seleção da lista de membros existente + PIN**, não texto livre).

```ts
type MemberProgress = {
  memberId: string;        // chave normalizada estável
  displayName: string;
  xp: number;
  level: number;
  weeklyPE: number[];      // últimas N semanas → baseline
  baseline: number;        // média móvel 4 semanas
  onTimeStreak: number;    // semanas ≥80% no prazo
  bestStreak: number;
  freezesLeft: number;     // 2/mês
  delivered: number;       // total verificado lifetime
  onTime: number;
  late: number;
  cosmetics: string[];     // ids desbloqueados (permanentes)
  equipped: { tint?: string; aura?: string; accessory?: string; title?: string; skinId?: number };
  schemaVersion: number;   // migração defensiva
  lastDeliveryAt: number;
};
```

**Espelho efêmero no `Player`** (só o que precisa ser visto ao vivo no mundo, re-hidratado no `onJoin`):
```ts
@type("uint8")  level = 1;
@type("uint8")  maxHp = 100;        // 100..120 — barra HP passa de hp/100 p/ hp/maxHp (linha 1371)
@type("uint8")  dmg = 20;           // 20..26
@type("uint16") onTimeStreak = 0;
@type("string") equippedCosmetic = "";  // serializado p/ render
```

> **Mapa de identidade:** `sessionId → memberId` no connect; toda leitura/escrita de progresso é por `memberId`. `member:rename` (já existe) precisa renomear a chave junto, senão histórico vaza. HP de combate vive na sala (volátil); stats de trabalho vivem no disco.

### 4.3 Onde calcular (tudo no servidor, idempotente)
- **Hook A — entrada em "feito":** função `markColumn(t, novaCol)` chamada por `task:move` E `task:update`, comparando `t.col` anterior; carimba `completedAt`, congela nada ainda.
- **Hook B — `task:deliver`** (novo handler): seta `delivered/deliveredAt/deliveredBy/proof`. Exige `proof` não-vazio.
- **Hook C — `task:verify`** (novo, por 2ª pessoa ≠ assignee, ou aceite-auto após 5 dias úteis): seta `verified=true` → **aqui e só aqui** chama `awardPE(t)`, guardado por `if (t.scoreAwarded === 0)`.
- **Hook D — edição de due:** se `msg.due ≠ t.due && t.col !== "backlog"` → `t.dueChanges++` e `committedDue` **não muda** (prazo-base preservado).
- **`task:undeliver`/devolução:** clawback de `scoreAwarded` (reverte XP daquele card), loga evento.

---

## 5. Anti-gaming embutido + anti-inflação

| Vetor de gaming | Trava |
|---|---|
| **Marcar "Feito" sem entregar** | XP só em `verified` (Hook C), com `proof` + sign-off de 2ª pessoa. "Feito" sozinho dá selo provisório cinza, 0 PE |
| **Empurrar a data de entrega** | `committedDue` congelado ao entrar em "Fazendo"; edições depois logam `dueChanges`, não recontam prazo. Quem define due ≠ quem executa |
| **Fatiar 1 tarefa em N cards** | PE por **size estimado na criação**, não por contagem. Subtarefas (checklist) não pontuam, só o card-pai. Size definido por outro membro |
| **Prazo folgado de propósito** | Size/peso/prazo definidos por quem distribui (dono/account), não pelo executor |
| **Conluio "aprovo o seu, você aprova o meu"** | Aprovador sofre clawback se cliente devolve (skin in the game); sign-off final de entrega = account owner; flag de anomalia se mesmo par se aprova >X% |
| **Cherry-picking (fugir do difícil)** | PE proporcional ao size (GG paga 8× PP); +XP de risco por desbloquear card "Travado" de outro; abacaxi é a jogada de MAIOR recompensa |
| **Esconder bloqueio (não marcar Travado)** | Sinalizar bloqueio cedo dá **+XP**, não custo; "Travado: aguardando_cliente" pausa o relógio (FatorPrazo ×1.0) |
| **Não criar o card** | Regra cultural "fora do board = não contou"; criação de card = higiene premiada; account cria a demanda |
| **Roubo/colisão de identidade** | Login por seleção da lista + PIN; progresso por `memberId`, nunca `sessionId` |
| **Crédito duplicado** | `scoreAwarded` idempotente; cálculo só no servidor |

**Anti-inflação (faucets vs sinks):**
- XP nunca infla o placar porque o **placar é % sobre baseline** (não soma eterna).
- **Buffs voláteis decaem** (regen/escudo) = sink contínuo.
- **Temporadas resetam status competitivo** = sink sazonal.
- **Cosméticos prestígio** (skin-up trimestral, acessórios 25/50/100) = sink de acúmulo.
- Poder funcional **satura no Lv10** = sem power-creep infinito.

---

## 6. Celebração / juice (reaproveitando efeitos existentes)

**Calibração por raridade** (lição Duolingo: se tudo é fogos, nada é). Tudo in-world e efêmero — **nunca vira feed de notificações** (46% desativam push com spam).

| Evento | Efeito (reusa o que existe) | Custo |
|---|---|---|
| **Entrega verificada (micro)** | burst de partículas `flameDot` (cor do cliente) + som curto com grave + squash&stretch no sprite (tween 150ms, `Back.easeOut`) + flash branco 80ms + **+HP de cura subindo na barra** (animação que já existe, partículas verdes) | ~1 dia dev |
| **No prazo** | mesma + anel/aura acende | 0 |
| **Selo provisório (Feito sem verificar)** | aura **cinza** discreta sobre o personagem ("aguardando envio") — visível, neutro, não-punitivo | baixo |
| **Level-up / marco raro** (cada 10 entregas no prazo, ou semana 100%) | **cinematográfico**: anticipation (wind-up 250ms) → clímax (hit-stop 6 frames + screenshake + chuva de partículas, 120ms) → settle (400ms easing) + título novo + cosmético | médio |
| **Boss cooperativo de sexta** | se a guilda (por empresa) bate a meta semanal, aparece chefe na cripta que o time mata junto (usa 3 andares + voz por proximidade) → cosmético coletivo | médio |
| **Peer recognition** | colega dá "joinha" → mini-coração/estrela no personagem de quem recebeu (reconhecimento lateral vale ~2×) | baixo |
| **Atraso (privado)** | toast só pro responsável ("2 entregas vencendo"); no mundo, nuvenzinha cinza temporária que **some ao entregar** — estado do trabalho, não rótulo da pessoa | baixo |
| **Atraso (agregado, sem nome)** | badge do escritório "⏰ 3 entregas em risco esta semana" / "clima do escritório" (sol↔nublado) | baixo |

**Variabilidade ética:** varia só a **forma** da celebração (3-5 variações de partícula/cor/frase), nunca a **quantidade** de PE (que é fixa e previsível — justiça).

---

### Sequência de implementação (trava primeiro, jogo depois)
1. **Fundação:** `memberId` + login por seleção + `progress.json` versionado. HP de combate desacoplado do score.
2. **Gate (T1):** estados `Entregue`/`Verificado` + `proof` + `committedDue` congelado + evento de PE idempotente no servidor. **Ainda sem efeito de combate.**
3. **Cosmético** no sign-off (recompensa mais segura) + celebração micro reusando efeitos.
4. **Atraso privado/agregado** + feed de glória + boss cooperativo.
5. **Só então**, modesto: +maxHp/+dmg/regen/escudo (upside-only).
6. Piloto **4-6 semanas, opt-in, dono se gamifica primeiro**, co-design das regras com os 5, kill switch. Métrica de sucesso = **% entregas no prazo verificadas + bem-estar**, nunca "tempo no jogo". Se aparecer micro-card farming, prazo inflado, ou alguém se sentindo exposto → ajusta ou desliga.

---

**Arquivos-âncora para implementação (absolutos):**
- `C:/Users/mathe/OneDrive/Desktop/Claude Code/Clientes marketing/escritorio-virtual/server/src/schema/Task.ts` — campos novos do §4.1
- `.../server/src/schema/Player.ts` — espelho efêmero §4.2 (level/maxHp/dmg/streak/cosmetic)
- `.../server/src/schema/OfficeState.ts` — onde adicionar `MapSchema<MemberProgress>` (opcional) ou manter só em disco
- `.../server/src/board/store.ts` — espelhar `TaskData`; clonar padrão p/ `progress/store.ts`
- `.../server/src/rooms/OfficeRoom.ts` — Hooks A–D, `task:deliver`/`task:verify`/`task:undeliver`, `hit` (dmg por atacante), `onJoin` (re-hidratar), `setSimulationInterval` (regen/decay) que hoje não existe
- `.../client/src/ui/kanban.ts` — `daysOverdue` (59-67), estados novos, botões "Entregar"/"Verificar", selo provisório, atraso privado
- `.../client/src/scenes/OfficeScene.ts` — HP bar `hp/100`→`hp/maxHp` (1371-1372), cosméticos (ring 303/570, tint, aura, label), celebração (`explodeAt` 1324, `flameDot`), `uiCam.ignore`
- `.../client/src/characters.ts` — skin-up entre os 10 (sem arte nova)
---

## Parte B — Accountability amigável + verificação de entrega + rollout

Vou entregar o documento agora. O material é extenso e convergente; meu trabalho aqui é destilar em um plano concreto e implementável, ancorado nos hooks reais do código.

# Gamificação ligada ao Gestor de Tarefas — Plano de Produto + Cultura

**Princípio-mestre que atravessa tudo (a evidência converge nele):**
**Recompensa é PÚBLICA, ADITIVA e COSMÉTICA. Atraso é PRIVADO, FOCADO NO CARD e RECUPERÁVEL. O sistema só SOMA para quem foi bem — NUNCA SUBTRAI de quem foi mal. Pontos só contam na ENTREGA CONFIRMADA, nunca no clique em "Feito".**

Os quatro red-teams independentes chegaram às mesmas três travas não-negociáveis, então elas viram a espinha do design:
1. A variável que dá recompensa precisa estar **fora do alcance de quem ganha com ela** (servidor carimba o tempo; prazo trava; outra pessoa confirma).
2. **Atraso atinge o CARD/CLIENTE, nunca o avatar da PESSOA** à vista dos pares.
3. **HP de combate ≠ score de trabalho** (duas barras separadas), senão a bola de fogo vira arma de sabotagem do placar profissional.

---

## (1) VISIBILIDADE AMIGÁVEL DE ATRASOS

### O que aparece, onde, pra quem, com que tom

O dado bruto (`daysOverdue` em `kanban.ts:59`) já existe e é confiável. O problema não é detectar — é **enquadrar**. A regra de ouro derivada de toda a pesquisa (Disney "electronic whip", shame-vs-guilt de Tangney/Brown, Edmondson): **mire no trabalho, em tom de pedido de ajuda; nunca na pessoa, em tom de acusação.**

#### Três camadas, da mais sutil à mais explícita

**OPÇÃO A — Sutil: nuvem temporária no avatar + selo no card (RECOMENDADA)**

- **No card** (`kanban.ts`, reusa o chip `kb-late` já existente em `:512`): troca a linguagem de acusação por linguagem de estado/socorro, escalonada:
  - 1–2 dias: 🟡 *"precisa de atenção"*
  - 3–5 dias: 🟠 *"vamos destravar isto"*
  - 6+ dias: 🔴 *"missão de resgate — quem ajuda?"*
- **No mundo Phaser** (sobre o personagem de quem tem card atrasado): uma **nuvenzinha de chuva** discreta (estado meteorológico — "passa") ou a aura/brilho de streak simplesmente **apaga** (perda silenciosa, não marca vermelha). Some no instante em que a pessoa entrega. **Nunca** caveira, X vermelho, personagem cinza/feio ou "podre".
- **Quem vê o quê:**
  - **Nuvem sobre o avatar:** visível só para a **própria pessoa** por padrão (HUD privado). Os pares **não** veem a marca negativa nominal.
  - **Selo no card:** visível no board (é sobre o *trabalho*, é gestão legítima — o vermelho vive no card, não na testa de ninguém).
  - **Agregado de time:** um medidor "**Clima do Escritório**" — sol quando o board está em dia, nublado quando há atrasos — mostra o estado coletivo **sem nomear ninguém**. Ex.: "⛅ 3 entregas em risco esta semana".

**OPÇÃO B — Intermediária: nudge privado + "Saúde da Guilda"**

- Ao entrar, se *você* tem card vencendo/atrasado: toast privado (molde `showToast` em `OfficeScene.ts:1180`) — *"Você tem 2 entregas pedindo atenção 👀"*. Zero exposição.
- Badge agregado no HUD (molde `meetingBadge` em `:717`): *"⏰ 3 entregas em risco hoje"* — número, nunca nomes.
- Sem nada sobre o avatar.

**OPÇÃO C — Explícita (NÃO recomendada, listada para descartar conscientemente):** personagem do atrasado visivelmente debuffado/cinza para todos verem, lista nominal de atrasos na daily. **Este é literalmente o "electronic whip" da Disney.** Em time de 5 onde todos se ouvem por voz, isto não é nudge — é evento social de humilhação diária. Desencadeia: ansiedade, gaming defensivo (empurrar prazo), ocultação de bloqueio, e pedido de demissão antes de "aparecer feio". **Não construir.**

#### Recomendação: **OPÇÃO A**, com estes detalhes de blindagem

- **Card em "Travado" PAUSA o relógio de atraso.** A coluna "Travado" já existe — use-a como **escudo**. Atraso por dependência externa (cliente sumiu, aguardando aprovação) **não gera nenhum sinal contra ninguém**. Isto é o que separa accountability amigável de chicote. Exija um motivo curto ao travar (`aguardando_cliente` / `aguardando_interno` / `bloqueio_tecnico`); `aguardando_cliente` nunca conta.
- **Atraso vira gatilho de cooperação, não de culpa.** Card 🔴 ganha botão *"Chamar reforço"* que usa a infra que já existe ("chamar pessoa" / "levantar a mão" / voz por proximidade): sugere quem está **online e perto** para uma call de 5 min. Quem ajuda a destravar **ganha XP de cooperação**. Atraso = quest aberta que qualquer um pode fechar, não carimbo na testa do responsável.
- **Sem histórico público de atrasos.** O sinal é **estado atual**, não placar acumulado. Vergonha vem da permanência ("o atrasado crônico"); culpa acionável vem do presente ("este card precisa de mim agora"). Ao entregar, o sinal some na hora — nada de "dívida".
- **Período de graça:** atraso < 1 dia não dispara nada (protege do cliente que respondeu tarde).

#### Como o personagem/mundo refletem atraso SEM humilhar

| Mecanismo | Como funciona | Por que não humilha |
|---|---|---|
| **Aura apaga (não acende)** | Quem está em dia tem brilho/aura; atraso = ausência de brilho | Ausência de prêmio ≠ presença de punição. Diferença psicológica enorme |
| **Nuvem privada** | Só a própria pessoa vê sobre seu avatar | Auto-correção antes de qualquer exposição |
| **Clima coletivo** | Andar fica nublado quando há muitos atrasos | Estado do *time*, sem apontar dedo |
| **Selo no card** | Vermelho no card, com tom de socorro | É sobre o trabalho, não sobre a pessoa |

---

## (2) CONTROLE DE ENTREGA EFETIVA

Este é o pedido #3 do dono e o coração anti-gaming. **A gamificação NÃO resolve isto — um GATE de verificação resolve.** Primeiro a trava, depois o jogo.

### Fluxo de estados (estende o kanban atual)

Hoje: `Backlog / A fazer / Fazendo / Travado / Feito`.
Novo final da esteira:

```
... → Fazendo → Feito (interno) → Entregue (ao cliente) → Aprovado / Sign-off
                                                              (+ Travado lateral, pausa relógio)
```

| Transição | Quem confirma | O que exige | Recompensa |
|---|---|---|---|
| **Fazendo → Feito** | O próprio responsável (auto-declarado) | nada | **+0 confirmado.** Gera só **XP pendente** ("selo provisório" cinza sobre o personagem) |
| **Feito → Entregue** | Responsável, mas com **prova** | **link/evidência verificável** de envio ao cliente (post publicado, arquivo no Drive, ID de envio — NÃO print solto) | converte ~parte do pendente |
| **Entregue → Aprovado** | **Quem tem a conta** (account/dono) OU **aceite automático após N dias** (ex.: 5 dias úteis sem objeção) | sign-off | **converte o restante → HP regenera, dano +, cosmético evolui** |

### Quem confirma (anti-conluio)

- **Sign-off final = quem tem a relação com o cliente** (account owner/dono), **não rotativo entre pares**. Revisão de par serve para qualidade interna, não para liberar a recompensa cheia. Isto mata o "eu aprovo o seu, você aprova o meu".
- **Aprovador tem skin in the game:** se o cliente devolve o trabalho (estado **"Devolvido"**), o XP pendente é **revogado (clawback)** — e o aprovador também sente. Aprovar mal passa a doer. Sem perda de HP já confirmado, só não-ganho.
- **`completedAt`/`deliveredAt` carimbados pelo SERVIDOR** (Colyseus autoritativo), nunca pela UI. O usuário não forja a hora. Hooks reais: centralizar uma função `markColumn(t, novaCol)` chamada por AMBOS `task:move` (`OfficeRoom.ts:206`) e `task:update` (`:166`), comparando a coluna anterior antes de sobrescrever (a "armadilha dos dois caminhos" identificada no mapa de código).

### Evidência anexa

Campo `proof` (link) obrigatório para sair de "Feito → Entregue". Enquadre como **proteção do colega, não auditoria**: *"fica registrado que você entregou — se o cliente reclamar, você está coberto"*, nunca *"prove que trabalhou"*. A diferença de tom decide se vira confiança ou vigilância.

### Pontos só contam APÓS confirmação

A regra que neutraliza Goodhart/Wells Fargo: **a recompensa (HP/dano/cosmético) NUNCA dispara no clique em "Feito".** Dispara em "Aprovado/Sign-off". Marcar "Feito" sozinho dá apenas um selo provisório visível — removendo todo incentivo a fraudar. É o modelo de **escrow de pontos** (pontos pendentes → confirmados → ou revogados no clawback).

### Definition of Done por tipo de tarefa (cole no card)

**Marketing / tráfego:**
1. Criativo/material no formato acordado, anexado por **link verificável**
2. Revisado por outra pessoa (campo revisor preenchido)
3. Agendado no gerenciador / publicado
4. Cliente avisado (link/ID de envio registrado)
5. Sign-off do cliente OU aceite automático após 5 dias úteis

**IA / dev:**
1. Deploy feito + testado
2. Cliente com acesso (link/credencial registrada)
3. Revisado por outra pessoa
4. Sign-off OU aceite automático após 5 dias úteis

O card só fica **"Aprovado de verdade"** com a checklist completa. Como a recompensa exige a prova, gamear "Feito" deixa de pagar — *gaming indistinguível de melhoria real*, a única defesa contra Goodhart.

### Travas anti-gaming embutidas (das críticas)

- **Trave o `due`** quando o card entra em "Fazendo" (snapshot `committedDue` ≠ `due` de planejamento). Mudança posterior exige outra pessoa + motivo, vira evento no histórico, e **não restaura prazo retroativo**. O `dueChanges++` (Hook C do mapa de código) sinaliza empurrão de prazo.
- **Pontue por ENTREGA ao cliente, não por card fechado** — quebrar 1 entrega em 14 cards não multiplica recompensa. Subtarefas (checklist) não pontuam; só o card-pai entregue.
- **Idempotência no servidor:** `scoreAwarded` por `cardId + transição`, para refresh/re-entrada não creditar 2x.

---

## (3) JUSTIÇA & CONSENTIMENTO

A premissa mais dura das críticas: **o chefe gamificando a entrega do próprio time pode virar vigilância com skin de RPG.** O design só sobrevive com travas de justiça explícitas.

### O que é opt-in

- **Camada estética/competitiva: opt-in real, default OFF.** Ninguém começa participando. A pessoa pode esconder a camada de jogo e o trabalho não é afetado (autonomia = a alavanca SDT mais forte). O gate de entrega (processo, não jogo) vale para todos.
- **Visibilidade do próprio atraso: privada por padrão.** Glória pública, vergonha privada.
- **Co-criação obrigatória:** o **time** (não o dono) define o que dá pontos, o que é público, o que é privado, antes de uma linha de código. Sessão de 30 min onde o dono **abre mão de decidir as regras sozinho**. Regra que o time desenhou é deles, não imposição.

### Individual vs equipe (a ciência manda híbrido)

A pesquisa é clara: só-individual mata cooperação; só-grupo gera carona; **híbrido é o melhor para times pequenos interdependentes** — com peso maior na equipe para puxar cooperação de volta.

- **Camada individual (~40%) — buffs pessoais, SOMPRE aditivos:** entrega aprovada no prazo → +HP máximo temporário (teto baixo, +20%) e +dano, **decaindo suavemente** se parar de entregar (sink, evita inflação). Atraso = 0 buff (ausência), nunca debuff.
- **Camada de equipe (~60%) — "Saúde da Guilda" / boss cooperativo:** meta semanal de entregas aprovadas no prazo, **separada por EMPRESA (IA / Marketing)** — são cadências incomparáveis (Marketing: muitos cards rápidos; IA: poucos, ciclo longo), nunca no mesmo ranking. Bater a meta = recompensa **coletiva** (cosmético de evento, boss derrotado junto na cripta na sexta usando os 3 andares + voz que já existem). Transforma "fulano atrasou" em "vamos ajudar o time a não tomar dano".

### Justiça entre papéis (crítico — split IA/Marketing, meio-período)

- **Pontuação por TAXA, não por volume:** % de entregas no prazo entre as que tinham prazo. Quem entrega 3/3 = 100%, igual a quem entrega 30/30. O dev de IA não fica "pior" por fazer o trabalho mais difícil e lento.
- **Comparação só contra si mesmo** (streak/PR pessoal vs. sua semana passada), **NUNCA leaderboard 1–5 entre pessoas** — em time de 5, alguém é sempre o 5º e todos sabem quem.
- **Peso de dificuldade explícito:** pegar o card-abacaxi (cliente difícil, tarefa ingrata) deve ser a jogada de **maior** recompensa, não a de maior risco de punição. Definido por quem distribui, não por quem executa (anti-inflação de peso próprio). Reconhecer "pegar o que ninguém quis" como conquista.
- **Meio-período tem calendário próprio:** atraso só conta em dias úteis configurados para a pessoa.

### Como o DONO introduz sem virar cobrança top-down

1. **O dono se gamifica PRIMEIRO e expõe o próprio atraso** (de feedback, de briefing) antes de qualquer subordinado. Se o personagem do chefe também perde brilho quando ele trava o time, a assimetria cai. Se o chefe é imune, é vigilância.
2. **Proibição escrita e absoluta:** o estado do jogo **NUNCA** entra em avaliação, salário ou cobrança. No minuto em que *"seu HP estava baixo"* aparece numa conversa de performance, o time joga para a métrica e mente para o kanban — perde-se o jogo E a verdade operacional.
3. **Cláusula de pausa que o time controla:** qualquer pessoa aciona pausa por 1 sprint, **sem veto do dono**, sem justificativa. A existência de um freio que o time controla é o que separa jogo de panóptico.
4. **A daily lê FLUXO, não pessoa:** a tela destaca *quests em risco e seus bloqueios* ordenadas por risco pro cliente, com a pergunta **"o que destrava isto?"** e nunca **"por que VOCÊ atrasou?"**. O dono modela a linguagem (Edmondson: liderança que enquadra erro como aprendizado cria a segurança).

---

## (4) ROLLOUT FASEADO

### Fundação técnica (antes de qualquer XP) — sem isso nada é seguro

- **Identidade estável = `memberId`/nome do membro normalizado** (`trim().toLowerCase()`), NUNCA `sessionId` (efêmero — refresh = progresso evapora). Entrada por **seleção da lista de membros** que já existe (não digitação livre) + PIN curto, evitando impersonação. Progresso persiste em `progress.json` no mesmo volume/padrão do `board/store.ts` (debounce + escrita atômica + `flushSync` no dispose).
- **HP de combate (volátil, da sala) separado de score de trabalho (persistente).** A bola de fogo nunca toca o score profissional. Trabalho dá `maxHp`/cosmético/buff, nunca rebaixa abaixo do baseline. (Corrige também o bug latente: barra `hp/100` hardcoded em `OfficeScene.ts:1371` precisa virar `hp/maxHp` se mexer no teto.)

### MVP — entrega 80% com o mínimo (Fase 0 + 1)

1. **GATE de entrega primeiro:** estados `Feito → Entregue → Aprovado` + prova (link) obrigatória + sign-off de quem tem a conta. **Isto sozinho resolve o pedido #3 e já vale o projeto, mesmo sem nenhum HP.**
2. **Selo no card escalonado** (🟡🟠🔴, tom de socorro) + **"Travado" pausa relógio**. Resolve o pedido #2 na versão amigável.
3. **XP pendente em escrow** → conversão em **cosmético programático no sign-off** (aura/tint/título — `setTint`, glow, partículas reusando a bola de fogo, anel clonado do ring de voz `OfficeScene.ts:570`, título no roster `:738`). Zero arte nova. Cosmético é a recompensa de menor risco que existe.
4. **Celebração in-world** na entrega aprovada no prazo: burst de partículas + som + flash, reusando os efeitos que já existem. Reservar a celebração GRANDE (level-up cinematográfico) para **marcos raros** (lição Duolingo: se tudo é especial, nada é).
5. **Nudge privado de atraso** ao próprio dono do card. **Clima coletivo do escritório** (agregado, sem nomes).

**Pare aqui e rode 4–6 semanas antes de adicionar HP/dano.**

### Incrementos (só se Fase 1 for bem recebida)

- **Fase 2:** buff individual de +maxHP/+dano (teto baixo, decai), streak **de equipe semanal** com **2 streak-freezes/mês** (Duolingo: leniência reduziu churn 21%). Peer recognition (joinha entre colegas → mini-efeito no avatar de quem recebe).
- **Fase 3:** boss cooperativo de sprint na cripta, temporadas (reset do status corrente, cosméticos permanentes ficam) para dar chance nova a todos e renovar sinks.

### O que NÃO construir

- ❌ **Leaderboard individual público** (absoluto, 1–5 entre pessoas) — Disney, demotiva o 5º lugar permanente.
- ❌ **Punição de HP por atraso / morte por atraso** (Habitica: dispara evitação e abandono).
- ❌ **Marca de vergonha no avatar** visível aos pares (caveira, cinza, "feio").
- ❌ **Economia de RPG completa** (moeda, loja, árvore de skills, crafting, prestige) para 5 pessoas — over-engineering que morre em 2 semanas de novidade.
- ❌ **Anti-cheat algorítmico** — em time de 5, transparência social (feed de entregas confirmadas) é mais barata e eficaz.
- ❌ **Recompensa atrelada a "Feito" cru, ou a data editável pelo executor.**
- ❌ **Bônus de janela** ("entregue nesta sexta e ganhe 2×") — cria incentivo a represar entrega pronta.
- ❌ **Variabilidade na *quantidade* de recompensa** (vira caça-níquel) — varie só a *forma* estética da celebração.

### Métricas/sinais: ajudando vs. prejudicando + gatilhos de reversão

**Sinais de que está AJUDANDO:**
- % de entregas **aprovadas no prazo** sobe (a métrica real, não "engajamento com o jogo").
- Bloqueios sinalizados **mais cedo** (mais uso de "Travado" com motivo, mais "chamar reforço").
- Bem-estar percebido do time estável ou melhor (pergunte diretamente).
- Cards continuam refletindo a realidade do cliente.

**Sinais de ALERTA (gaming/dano cultural) → ajustar:**
- Board enchendo de **micro-cards** (fatiamento para inflar contagem).
- **Prazos folgados de propósito** ou `dueChanges` alto (empurrar prazo).
- Cards de cliente entregues **fora do board** (gaming por omissão — "se não está no board, não foi entregue").
- Alguém entrando de madrugada doente para "não perder streak".
- Sign-offs sempre entre o mesmo par (conluio).

**GATILHOS DE REVERSÃO (desligar na hora):**
- Qualquer pessoa relata sentir-se **exposta/vigiada/constrangida**.
- O jogo aparece numa conversa de avaliação/salário.
- Sobe o engajamento com o jogo MAS o time relata estresse → **foi backfire, pare** (a armadilha do Duolingo de medir streak em vez de aprendizado).
- A "novidade" decai e sobra só o tracking → vira vigilância sem o açúcar; mate ou revise.

**Governança:** trate tudo como **experimento com kill switch e data de revisão** (4–6 semanas). A própria evidência de prazos (Ariely) não replicou num estudo recente — nenhum número aqui é sagrado; calibre com 2–3 semanas de dados reais do time.

---

### Síntese em uma frase
**Conte valor entregue e verificado (não cliques em "Feito"); meça cada pessoa contra o próprio passado e a equipe contra uma meta coletiva; pague em HP/beleza que só soma e decai (nunca em dinheiro nem em status eterno); torne atraso uma missão de resgate no card em vez de um pelourinho no avatar; e nunca credite recompensa antes da prova de entrega ao cliente.** Isso entrega literalmente os três pedidos do dono (no prazo → mais HP/dano/beleza; atraso visível e amigável; controle de envio efetivo) ficando na "Learning Zone" de Edmondson em vez da Disney/Wells Fargo.

**Arquivos-âncora para implementação:** `escritorio-virtual/server/src/schema/Task.ts` (campos `completedAt`/`deliveredAt`/`delivered`/`proof`/`committedDue`/`scoreAwarded`/`dueChanges`), `server/src/schema/OfficeState.ts` (`MemberScore` por nome de membro), `server/src/board/store.ts` + novo `server/src/progress/store.ts` (persistência espelhada), `server/src/rooms/OfficeRoom.ts` (hooks A–D: `markColumn` em `task:move`/`task:update`, novo `task:deliver`, clawback), `client/src/ui/kanban.ts` (`daysOverdue:59`, chip `kb-late:512`, estados novos, botão entrega/sign-off), `client/src/scenes/OfficeScene.ts` (HP bar `hp/maxHp:1371`, cosméticos via tint/glow/partículas/ring `:570`, nuvem privada via `showToast:1180`, clima coletivo via `meetingBadge:717`).