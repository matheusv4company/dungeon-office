# Escritorio Virtual — app unico: Colyseus (multiplayer) + /token (voz) + cliente estatico.
FROM node:22-slim

# git: o Colyseus instala o uWebSockets.js a partir de um repositorio git.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencias primeiro (melhor cache de camadas)
COPY package.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/
# --include=dev garante vite/typescript (build) mesmo com NODE_ENV=production;
# --omit=optional pula o sharp (usado so no gerador de personagens offline).
RUN npm install --include=dev --omit=optional

# Codigo + build (cliente -> client/dist ; servidor -> server/dist)
COPY . .
RUN npm run build -w client && npm run build -w server

ENV NODE_ENV=production
# Porta interna; o Coolify mapeia o dominio HTTPS -> esta porta.
ENV PORT=2567
EXPOSE 2567

# O servidor serve o cliente estatico + WebSocket + /token na mesma porta.
CMD ["node", "server/dist/index.js"]
