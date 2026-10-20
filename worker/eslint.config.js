import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".wrangler/**", "node_modules/**"] },
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true },
    },
  },
);
