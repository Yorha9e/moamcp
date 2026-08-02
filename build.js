import { buildSync } from 'esbuild';

buildSync({
  entryPoints: ['src/server.ts'],
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
  outfile: 'dist/server.js',
});
