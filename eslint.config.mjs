import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
  {
    ignores: ["out/**", "dist/**", "node_modules/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // Only the two classic hooks rules, not react-hooks' full
      // `recommended` preset -- v7 bundles a set of React Compiler
      // diagnostics (set-state-in-effect, preserve-manual-memoization,
      // etc.) meant for codebases opting into that compiler. This app
      // doesn't (plain React 18 + Vite), and those rules flag this
      // codebase's ordinary, safe "default this local state to the first
      // loaded item" effects as if they were bugs. rules-of-hooks (hook
      // call order/conditionals) and exhaustive-deps (stale closures) are
      // the two that actually catch real mistakes here.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // A component that doesn't export only components breaks Fast
      // Refresh (electron-vite dev's HMR silently falls back to a full
      // reload instead) -- catches the mistake at lint time instead of
      // "why did my state just reset" during manual testing.
      "react-refresh/only-export-components": "warn",
      // Renderer-side event/status/parameter payloads are typed as `dict`/
      // `Record<string, unknown>` end to end (see protocol.ts) -- `any`
      // slipping in past that boundary is exactly the kind of silent
      // type hole this project's `strict: true` tsconfig is otherwise
      // trying to prevent.
      "@typescript-eslint/no-explicit-any": "warn",
      // A caught error this codebase only logs (see the daemon's own
      // `except Exception: logger.exception(...)` convention) legitimately
      // has an unused binding; matches the same allowance most TS configs
      // ship with.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
