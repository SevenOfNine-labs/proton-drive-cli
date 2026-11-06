import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  outfile: 'dist/index.js',
  format: 'cjs',
  sourcemap: true,
  // @protontech/crypto imports openpgp/lightweight, an "exports" entry that
  // only exists for the browser condition; Node loads the full package.
  alias: { 'openpgp/lightweight': 'openpgp' },
  external: [
    'readline/promises',
    'openpgp',
  ],
});
