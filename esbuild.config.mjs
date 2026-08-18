import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const banner = `/*
Adaptive Spaced Repetition — bundled from src/main.ts
Run "npm run dev" to rebuild on change, "npm run build" for a production build.
*/
`;

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  banner: { js: banner },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtins],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeshake: true,
  outfile: "main.js",
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
