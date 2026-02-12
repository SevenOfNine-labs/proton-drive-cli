import esbuild from "esbuild";

esbuild
  .build({
    entryPoints: ["dist/index.js"],
    bundle: true,
    platform: "node",
    target: "node25",
    outfile: "sea-bundle.cjs",
    format: "cjs",
    // readline/promises is a Node.js builtin subpath that esbuild doesn't
    // auto-detect. It resolves fine at runtime in both regular node and SEA.
    external: ["readline/promises"],
  })
  .catch(() => process.exit(1));
