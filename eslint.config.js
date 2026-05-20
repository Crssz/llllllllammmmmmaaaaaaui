import js from "@eslint/js";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "node_modules",
      "src-tauri/target",
      "src-tauri/gen",
      "coverage",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.es2022 },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      react,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      // HMR-only nudge — the rule fires on files that legitimately export
      // both components and constants (icons, screens with helper exports,
      // the state module). Doesn't affect production behavior.
      "react-refresh/only-export-components": "off",
      // The following react-hooks v7 rules flag idiomatic React-18 patterns
      // already used throughout this codebase. Demoting to warn so they
      // surface incremental cleanup without blocking CI.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/purity": "warn",
      "react/no-unescaped-entities": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    files: ["src/**/*.test.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ["*.config.{ts,js}", "vitest.config.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
