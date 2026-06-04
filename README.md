# Escritório Virtual

Escritório virtual 2D top-down (estilo Tibia) para o time interno: entra por uma URL pública,
escolhe um personagem, anda pelo mapa e conversa por **voz por proximidade**. Sem login, sem câmera.

## Stack
- **client/** — Phaser 3 + TypeScript + Vite (jogo no navegador)
- **server/** — Colyseus 0.16 + TypeScript (posições/presença em tempo real + token de voz)
- **Voz** — LiveKit (a partir da Fase 4)

## Rodando localmente
```bash
npm install        # instala client + server (workspaces)
npm run dev        # sobe server (ws://localhost:2567) e client (http://localhost:5173)
```
Abra http://localhost:5173.

## Estrutura
```
escritorio-virtual/
├── client/   # Phaser + Vite + TS
└── server/   # Colyseus + TS
```

## Status
Em construção por fases (ver plano). Fase atual: **0 — fundação** (scaffold rodando).
