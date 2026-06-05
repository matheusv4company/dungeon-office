# Deploy — Escritório Virtual (Coolify)

App **único**: servidor Colyseus (multiplayer) + endpoint `/token` (voz) + cliente
estático (jogo) — tudo na mesma porta/origem. O LiveKit roda na nuvem (separado).

## Pré-requisitos
- VPS com **Coolify**
- Domínio (alvo: **dungeon.empresa-br.com**)
- Conta **LiveKit Cloud** (URL + API Key + Secret)

## 1) DNS
No painel de DNS do domínio (Hostinger), crie:

| Tipo | Nome | Valor | TTL |
|------|------|-------|-----|
| A | `dungeon` | `<IP da sua VPS>` | padrão |

→ resolve `dungeon.empresa-br.com` para a VPS.

## 2) Repositório
Suba este repositório para um Git provider (ex.: GitHub, repo **privado**).

## 3) Coolify
1. **New Resource → Application** → escolha o repositório → branch **main**.
2. **Build Pack: Dockerfile** (detectado automaticamente — o `Dockerfile` está na raiz).
3. **Port / Ports Exposes: `2567`**.
4. **Domains:** `https://dungeon.empresa-br.com`
   (o Coolify/Traefik emite o certificado HTTPS via Let's Encrypt automaticamente).
5. **Environment Variables** (cole aqui — **nunca** no código/git):
   ```
   LIVEKIT_URL=wss://SEU-PROJETO.livekit.cloud
   LIVEKIT_API_KEY=API...
   LIVEKIT_API_SECRET=...
   ```
6. **Deploy.**

## 4) Testar
Abra **https://dungeon.empresa-br.com** → escolha personagem + nome → ande (WASD)
→ clique em **🎙️ Ativar voz** (permita o microfone).

## Notas
- **HTTPS é obrigatório** para o microfone (getUserMedia). O Coolify resolve.
- **WebSocket**: o Traefik do Coolify proxia WS nativamente (Colyseus + LiveKit funcionam).
- **Porta**: o app escuta em `process.env.PORT` (padrão 2567). Garanta que o "exposed port" no Coolify seja 2567.
- **LiveKit free tier** conta *participant-minutes*; para uso intenso o dia todo,
  dá para **self-hostar o LiveKit na própria VPS** depois (Docker), sem custo por minuto.
- **Atualizar**: novo commit + push → Coolify redeploya (ou clique em *Redeploy*).
