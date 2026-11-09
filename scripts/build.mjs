// Bundles the Gateway into one minified file. Bundling matters here: loading drizzle-orm and
// express from node_modules as ~1,000 separate ESM files costs ~110 MB of RSS at startup; the
// single bundle idles at ~75 MB (a bare Node process is ~48 MB). tsc is used for type checks only.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: true,
  sourcemap: 'linked',
  // Some CommonJS deps (express, ws) call require() at runtime; give the ESM bundle one.
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  logLevel: 'info',
});
