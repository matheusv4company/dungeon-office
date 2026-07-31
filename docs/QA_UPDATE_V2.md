# QA — Update V2 (roteiro de teste)

> Precisa de **2–3 pessoas** (ou 2 navegadores diferentes — aba anônima conta) e uns
> **20 min**. Os testes de áudio são os mais importantes. Marque ✅/❌ e anote o que
> estranhar. Itens com 🖥️ = confira também o **log do servidor no Coolify**.

## 0) Deploy
- [ ] `git push` + Redeploy no Coolify.
- [ ] 🖥️ No log do boot, procurar: `[audibility] RoomService OK — assinaturas server-side ATIVAS`.
      Se aparecer `INDISPONÍVEL`: o motor degradou pro comportamento antigo — me avisa
      (o áudio continua funcionando, mas sem a blindagem nova).

## 1) 🔊 ÁUDIO — o bloco crítico (2+ pessoas com fone)
- [ ] **Proximidade**: longe = silêncio; aproximando (~5 tiles) o som entra suave; afastando, some.
- [ ] **Som de aviso**: ao alguém entrar no seu alcance toca um "ding" subindo; ao sair, descendo.
      Andar na fronteira não metralha o som.
- [ ] **Sala de reunião**: os dois dentro = ouve cheio. Um DENTRO e outro FORA **colado na
      parede** (especialmente no corredor AO SUL das salas azul/dourada — era o vazamento) =
      **silêncio absoluto**.
- [ ] **Aba em 2º plano** (o teste histórico): A e B perto, conversando. B minimiza/troca de
      aba e ANDA pra longe usando outra janela? Não dá — então: A deixa a aba do escritório
      em 2º plano; B se afasta. **A NÃO pode continuar ouvindo B.** Repetir com B dentro de
      uma sala de reunião.
- [ ] **Andares**: praia ↔ escritório ↔ cripta = nunca se ouve entre andares.
- [ ] **Reconexão**: F5 no meio da conversa → voz volta e as regras continuam valendo.
- [ ] **Morte** 🔥: morrer/reviver não deixa voz vazando.

## 2) 🖥️ Share com áudio
- [ ] Compartilhar uma **ABA do Chrome** com "Compartilhar áudio da guia" marcado (a dica
      aparece 1x) → quem está perto vê a tela **e ouve** (indicador 🔊 no card).
- [ ] Quem está longe/fora da sala não vê nem ouve.
- [ ] Parar o share corta vídeo e áudio na hora (sem som fantasma).
- [ ] Minimizar o card do share muta o áudio dele.

## 3) 📤 Print de entrega (o bug do vídeo)
- [ ] Task em **Feito** → Entregar → aba **Print** → anexar screenshot → **Entregar**:
      agora **funciona** (card vira "Entregue", IA dá nota).
- [ ] **Ctrl+V** no modal cola o print direto (novo!).
- [ ] Tentar entregar sem anexar → mensagem clara (nada de "cliquei e nada aconteceu").

## 4) 📋 Gestor (kanban)
- [ ] Editor: **responsável e cliente viraram chips** clicáveis (com as cores). "➕ novo…"
      continua criando na hora. Salvar funciona igual.
- [ ] **⧉ Duplicar** no modal de edição: cria "(cópia)" logo abaixo, SEM estado de
      entrega/verificação (duplicar task entregue → cópia limpa).

## 5) 😀 Emojis
- [ ] Barra no rodapé → clicar → emoji flutua sobre seu personagem pra todos.
- [ ] Spam clicando rápido → limitado (1 a cada ~0,75s).

## 6) 🤖 Transcrição/ata (2 membros LOGADOS, no Chrome/Edge)
- [ ] Entrar juntos numa sala de reunião com **voz ligada** → badge
      "🔴 transcrevendo a reunião" aparece. Clicar nele pausa SÓ a sua parte.
- [ ] Conversar 3–4 min de "trabalho" com 1–2 combinados claros
      (ex.: "Bernardo, você faz o criativo do quiz até sexta").
- [ ] Saírem os dois da sala → **~1 min depois**: toast "📋 Ata pronta" + no gestor,
      card "📋 Ata — dd/mm hh:mm" (resumo/decisões) + tarefas "🤖" (cliente "Reunião",
      responsável preenchido se o nome dito bate com um membro).
- [ ] Conversa de 30 segundos/fiada → NÃO gera ata (mínimo de conteúdo).
- [ ] Convidado (sem login) na sala → a fala dele não entra na ata.

## Se algo falhar
Me manda: o item, print/vídeo e (se puder) o console (F12). Cada feature tem um
interruptor no Coolify pra desligar na hora sem rebuild:
`AUDIO_AUTH=0` · `PROX_SOUND=0` · `SHARE_AUDIO=0` · `EMOTES=0` · `MEETING_SCRIBE=0`.
