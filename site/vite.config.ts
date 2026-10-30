import { createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { type Plugin, defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Local demo files (e.g. transcriptions of copyrighted songs) live in site/local/.
// They are served by the dev server only and are never copied into a build.
function localDemos(): Plugin {
  const root = join(__dirname, "local");
  return {
    name: "local-demos",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/local", (req, res, next) => {
        const path = normalize(join(root, decodeURIComponent((req.url ?? "/").split("?")[0])));
        if (!path.startsWith(root + sep) || !existsSync(path) || !statSync(path).isFile()) return next();
        createReadStream(path).pipe(res);
      });
    },
  };
}

// base "./" so the build works from any sub-path (e.g. GitHub Pages)
export default defineConfig({
  plugins: [react(), localDemos()],
  base: "./",
  server: {
    // node_modules is a symlink to node_modules.nosync (keeps it out of iCloud sync)
    watch: { ignored: ["**/node_modules.nosync/**", "**/local/**"] },
  },
});
