import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json";

// Vite + @crxjs/vite-plugin build for the MV3 extension.
// Entries (popup, content script, background service worker) are declared in
// manifest.json and picked up by the crx plugin.
export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    rollupOptions: {
      input: {
        popup: "popup.html",
      },
      output: {
        // Stable (non-hashed) chunk/entry names. With content-hash names, a
        // rebuild changes the content-script chunk filename, but an iPaaS tab
        // that still has the previous content script loaded keeps trying to
        // dynamically import the OLD filename -> "Failed to fetch dynamically
        // imported module". Fixed names mean the file the stale loader asks for
        // still exists after a rebuild, so a reload no longer crashes.
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
