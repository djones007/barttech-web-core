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
