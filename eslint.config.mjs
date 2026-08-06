// web-core is a plain TypeScript source library — deliberately NOT eslint-config-next.
// It ships no React components (the cookie banner stays per-repo because brand styling
// differs), so it carries none of the Next plugin stack and none of that stack's
// version constraints.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // `scripts/**` are standalone Node CLIs run by consumer CI, not library
    // source. They were linted with NO environment declared — the block below
    // matches `*.ts` only, and in flat config that is top-level `.ts` files,
    // not `scripts/*.mjs` — so every `process`, `console`, `Buffer` and `fetch`
    // in them was a `no-undef` error and CI had been red since they landed.
    //
    // Node globals only, deliberately: these never run in a browser, and
    // including the browser set would let a `window` or `document` reference
    // pass lint here and fail at runtime in CI, where there is no DOM.
    files: ["scripts/**/*.mjs", "scripts/**/*.js"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // A CLI's argv/JSON parsing is genuinely dynamic, and these files are not
      // consumed as typed modules by anything — the no-explicit-any rule below
      // exists to protect the 9+ repos that import the LIBRARY, which is a
      // different concern from a script that only ever runs standalone.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["*.ts"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // These modules are consumed by 9+ repos; an implicit `any` here silently
      // becomes an untyped value in every one of them.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
