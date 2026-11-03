// MiniPC のサーバーで走行ログを判定する worker(src/judgeWorker.ts)を server/build/judgeWorker.js にまとめる
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    ssr: "src/judgeWorker.ts",
    outDir: "server/build",
    emptyOutDir: true,
    target: "node20",
  },
});
