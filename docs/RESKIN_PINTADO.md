# Re-skin pintado dos 3 andares — relatório da noite

**O que é:** troquei o visual do mapa (que era um mix de tiles DCSS + formas desenhadas por
código) por **um fundo PINTADO por andar**, no estilo do print de referência. É o método que o
Gather usa: uma imagem única por área + colisão invisível por cima. Salto visual enorme.

As imagens foram **geradas pela sua API do Gemini** (modelo `gemini-2.5-flash-image` / nano
banana). Como é a sua API e o modelo gera arte original, **você é dono das imagens** — sem
licença de terceiro, pode commitar no repo público sem tela de créditos.

## ✅ Como VER
1. `git push` (o commit `4a151a5` está local, não enviei).
2. **Redeploy no Coolify.**
3. Entre e ande pelos 3 andares. Ou rode local: `npm run dev` → `localhost:5173`.

> Prévia do mapa montado (os 3 andares empilhados): abra
> `../reskin-candidatas/MAPA-COMPLETO-preview.png` (fora do repo, no Desktop).

## 💰 Custo
Gastei **$0,43 dos $2** (11 imagens: 1 smoke + 4 escritório + 3 praia + 3 cripta). A trava dura
em $1,80 nunca chegou perto. **Sobra ~$1,57** pra ajustes que você pedir de manhã.

## 🎛️ Reversibilidade (3 camadas)
- **Env:** `PAINTED_MAP=0` no Coolify → volta o visual antigo **sem rebuild**.
- **Git:** commit atômico `4a151a5` → `git revert 4a151a5`.
- O renderer antigo (tiles DCSS + rachaduras procedurais) **continua no código**, no `else` do flag.

## 🖼️ Você tem opções (candidatas)
Gerei várias por andar e escolhi a melhor (top-down plano + centro aberto + rachaduras visíveis).
**Todas estão em `../reskin-candidatas/`** (Desktop) pra você comparar. Se preferir outra, me diz
o nome que eu troco em 1 minuto:
- **Escritório:** usei `office_1`. Alternativas: `office_2` (mais premium/ornamentado),
  `office_3` (linda mas oblíqua/isométrica — pior pra colisão), `office_4` (retangular limpa).
- **Praia:** usei `beach_1`. Alternativas: `beach_2`, `beach_3` (mais movimentada).
- **Cripta:** usei `crypt_1`. Alternativas: `crypt_2` (mais destruída/entulho), `crypt_3`.

## ⚠️ Pendências pra ajustar (o que eu deixaria pra você pedir)
Isto é POC de 1ª versão — o essencial (visual dos 3 andares) está pronto; a colisão fina fica
pra iterar com você porque **não consigo ver o jogo ao vivo** (o canvas trava na minha automação):
1. **Colisão de móveis:** hoje anda por cima das mesas/sarcófagos (colisão só na borda + divisórias).
   Dá pra adicionar colisão nos móveis principais.
2. **Zonas de reunião (áudio):** os tapetes pintados podem não coincidir exatamente com as bolhas
   de áudio atuais. Realinhável.
3. **Escadas:** o sprite antigo de escada pode aparecer por cima do fundo pintado. Dá pra pintar
   escadas nas imagens ou reposicionar.
4. **Y-sort com móveis:** como o móvel é parte da imagem de fundo, o personagem sempre anda "por
   cima" (não some atrás de uma estante). Limitação do método de fundo pintado — aceitável.
5. **Peso:** os 3 PNGs somam ~2,8MB. Dá pra converter pra webp e cair bastante (otimização futura).

## 🔁 Como regenerar (se você quiser um andar diferente)
O pipeline está em `../reskin-candidatas/` (`gen.mjs`, `resize.mjs`, prompts `p_*.txt`). Eu rodo:
`node gen.mjs <saida.png> <prompt.txt> <aspect> [ref.png]` — ele lê a chave do arquivo em runtime
(nunca commitada/logada), soma no `spend.json`, e recusa gerar se passar de $1,80. Depois
`resize.mjs` corta pro tamanho exato do andar.

## De manhã
Me diga: **(a)** curtiu no geral? **(b)** quer trocar alguma candidata? **(c)** quais ajustes
finos (colisão de móveis, zonas, escadas)? Tenho orçamento e o pipeline prontos pra iterar rápido.
