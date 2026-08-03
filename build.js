import { buildSync } from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; var require = __cr(import.meta.url);",
  },
  alias: {
    process: 'node:process',
  },
};

buildSync({ ...shared, entryPoints: ['src/server.ts'], outfile: 'dist/server.js' });

// Headless Bus owner spawned by the controlled restart flow (task D) — kept
// as a separate flat bundle because dist/server.js resolves it as a sibling.
buildSync({ ...shared, entryPoints: ['src/bus-daemon.ts'], outfile: 'dist/bus-daemon.js' });
