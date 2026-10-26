import { defineConfig } from "vite";

// GitHub Pages では /<リポジトリ名>/ 配下で配信される
export default defineConfig({
  base: process.env.GITHUB_PAGES ? "/National-Route-Conquest-Map/" : "/",
});
