# LiveKit self-hosted (voz do Escritório Virtual)

Roda o LiveKit na própria VPS (a mesma do Coolify) pra não depender do free tier do
LiveKit Cloud, que estoura com uso o dia inteiro. Voz ilimitada, sem custo por minuto.

## Topologia
- **Sinalização WS** (porta `7880`) → atrás do **Traefik** do Coolify em
  `livekit.empresa-br.com`, com SSL automático (wss). Traefik faz isso bem (é HTTP/WS).
- **Mídia WebRTC** → Traefik **não** faz UDP, então sai direto no host:
  - `50000/udp` (porta única multiplexada de mídia)
  - `7881/tcp` (fallback)
  - `use_external_ip: true` → o LiveKit anuncia o IP público da VPS nas ICE candidates.

## Passos

### 1) DNS (Hostinger)
Criar registro **A**: `livekit` → `147.79.104.128` (IP da VPS).

### 2) Coolify — novo recurso "Docker Compose"
- Cole o `docker-compose.yml` desta pasta (e o `livekit.yaml` junto).
- **Domain / FQDN**: `https://livekit.empresa-br.com` apontando pra porta **7880**
  (o Traefik emite o SSL).
- **Environment**: `LIVEKIT_KEYS=APIb5e9cd388757: <SECRET>`
  (o SECRET é o gerado fora do repo; nunca commitar).
- Garantir que as portas `7881:7881` e `50000:50000/udp` sejam publicadas no host
  (estão no compose).
- Deploy.

### 3) Firewall da VPS
Abrir **inbound**: `50000/udp` e `7881/tcp`. (80/443 já estão abertos pro Traefik.)

### 4) Verificar o servidor
```
curl https://livekit.empresa-br.com/    # deve responder: OK
```

### 5) Apontar o app pro LiveKit novo
No recurso do **app** no Coolify, trocar as envs:
```
LIVEKIT_URL=wss://livekit.empresa-br.com
LIVEKIT_API_KEY=APIb5e9cd388757
LIVEKIT_API_SECRET=<SECRET>
```
Redeploy do app. Testar a voz no escritório (2 pessoas perto se ouvem).

## Notas
- Pinar a imagem numa versão (ex.: `livekit/livekit-server:v1.8.4`) depois de validar.
- Se a voz conectar mas não passar áudio entre redes diferentes, o problema é
  NAT/firewall na mídia — revisar `50000/udp` aberto e `use_external_ip`/`node_ip`.
- Segredos só no env do Coolify (repo é público).
