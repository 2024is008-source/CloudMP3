import { defineConfig, loadEnv, mergeConfig, type PluginOption, type UserConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";

export default defineConfig(({ command, mode }) => {
  const isDevBuild = command === "build" && mode === "development";

  const plugins: PluginOption[] = [
    tailwindcss(),
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tanstackStart({
      importProtection: {
        behavior: "error",
        client: { files: ["**/server/**"], specifiers: ["server-only"] },
      },
      // TanStack Start's bundled server entry is redirected to src/server.ts (the SSR error wrapper).
      server: { entry: "server" },
    }),
    viteReact(),
  ];

  // node-server emits a plain Node HTTP server (.output/server/index.mjs) for the VPS;
  // "cloudflare-module" was the earlier Worker target and cannot run under PM2.
  if (command === "build") plugins.push(nitro({ defaultPreset: "node-server" }));

  // .env values are inlined at build time; SSR-only secrets stay out of the bundle by not being VITE_ prefixed.
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const define: Record<string, string> = {};
  for (const [key, value] of Object.entries(env))
    define[`import.meta.env.${key}`] = JSON.stringify(value);

  const config: UserConfig = {
    define,
    css: { transformer: "lightningcss" },
    resolve: {
      alias: { "@": `${process.cwd()}/src` },
      dedupe: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "@tanstack/react-query",
        "@tanstack/query-core",
      ],
    },
    optimizeDeps: {
      include: [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
      ],
      ignoreOutdatedRequests: true,
    },
    server: {
      host: "::",
      port: 8080,
      // Windows file watchers report writes while editors are still flushing; without this, one save can trigger two reloads.
      watch: { awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 } },
    },
    plugins,
  };

  if (isDevBuild) {
    return mergeConfig(config, {
      environments: {
        client: { define: { "process.env.NODE_ENV": JSON.stringify("development") } },
      },
      esbuild: { keepNames: true },
    });
  }
  return config;
});
