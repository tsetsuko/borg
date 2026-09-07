import { copyFileSync } from "node:fs";

import { defineConfig } from "tsup";

// The seed files are DATA, and the code that reads them resolves them relative to
// its own module URL (src/akuki/seed/temperament.ts:242, scaffolding.ts:219). That
// works when Akuki's entry points run through tsx against src/, which was the only
// way they ran until the connector moved into its own package on 2026-09-07 and
// began importing borg through dist/. From there the same expression resolves to
// dist/temperament.yaml, and the seed died with ENOENT at startup -- exactly the
// case the comment above TEMPERAMENT_PATH warned about.
//
// Copying them beside the bundle is what that comment asks for. Anything added to
// src/akuki/seed/ that gets read at runtime belongs in this list.
const SEED_ASSETS = ["temperament.yaml", "scaffolding.md"] as const;

function copySeedAssets(): void {
  for (const name of SEED_ASSETS) {
    copyFileSync(`src/akuki/seed/${name}`, `dist/${name}`);
  }
}

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      "suppression-outcome": "src/cognition/generation/suppression-outcome.ts",
    },
    format: ["esm"],
    target: "node22",
    // tsup 8 strips node: prefixes from output imports by default, which
    // resolves for legacy builtins but breaks node:-only modules: bare
    // "sqlite" is not a package. Keep the prefixes verbatim.
    removeNodeProtocol: false,
    dts: true,
    clean: true,
    sourcemap: true,
    splitting: false,
    shims: false,
    onSuccess: async () => {
      copySeedAssets();
    },
  },
  {
    entry: { "cli/index": "src/cli/index.ts" },
    format: ["esm"],
    target: "node22",
    // tsup 8 strips node: prefixes from output imports by default, which
    // resolves for legacy builtins but breaks node:-only modules: bare
    // "sqlite" is not a package. Keep the prefixes verbatim.
    removeNodeProtocol: false,
    dts: false,
    clean: false,
    sourcemap: true,
    splitting: false,
    banner: { js: "#!/usr/bin/env node" },
    shims: false,
  },
]);
