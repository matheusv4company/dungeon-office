import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    port: 5173,
    strictPort: false,
    // Dev local no Windows: o Preview lanca via caminho curto (8.3, ESCRIT~1),
    // que difere do caminho longo do root e faz o Vite bloquear (403). Desligar
    // a allow-list resolve. Sem efeito em producao (build estatico).
    fs: { strict: false },
  },
});
