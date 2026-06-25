import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: 'dist/index.js',
  format: 'cjs',
  sourcemap: true,
  external: [
    'readline/promises',
    '@protontech/openpgp',
    'openpgp',
  ],
});
