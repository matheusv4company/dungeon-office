# Escritorio Virtual — app unico: Colyseus (multiplayer) + /token (voz) + cliente estatico.
FROM node:22-slim

# git: o Colyseus instala o uWebSockets.js a partir de um repositorio git.
# O lockfile resolve via SSH; reescrevemos para HTTPS (repo publico, sem auth)
# e instalamos ca-certificates para o TLS do clone funcionar.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" \
  && git config --global url."https://github.com/".insteadOf "git@github.com:"

WORKDIR /app

# Dependencias primeiro (melhor cache de camadas). O LOCKFILE vai junto: sem ele o
# `npm install` resolvia versoes NOVAS do registry a cada build — o mesmo commit que
# subiu ontem podia quebrar hoje porque alguma dependencia publicou versao nova
# (build nao reproduzivel). Com o lock, o build usa exatamente o que foi testado.
COPY package.json package-lock.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/
# --include=dev garante vite/typescript mesmo com NODE_ENV=production.
# NAO usar --omit=optional: o vite 8 (rolldown) precisa do binding nativo por
# plataforma, que e dependencia OPCIONAL. O sharp (tambem opcional) instala
# aqui normalmente — ou e ignorado se falhar, sem quebrar o build.
# `npm ci` instala exatamente o lock; se ele falhar por algo de ambiente, cai no
# `npm install` (comportamento antigo) pra nao deixar o deploy travado.
RUN npm ci --include=dev || npm install --include=dev

# Codigo + build (cliente -> client/dist ; servidor -> server/dist)
COPY . .
RUN npm run build -w client && npm run build -w server

ENV NODE_ENV=production
# Porta interna; o Coolify mapeia o dominio HTTPS -> esta porta.
ENV PORT=2567
EXPOSE 2567

# O servidor serve o cliente estatico + WebSocket + /token na mesma porta.
CMD ["node", "server/dist/index.js"]
