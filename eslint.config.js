import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/coverage/**", "**/src/generated/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["packages/*/src/**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
