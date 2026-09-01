import type { Config } from "tailwindcss";

/**
 * Canonical palette, resolved from the two divergent PyQt6 stylesheets found
 * in the original codebase (senario programm/ui/style.py vs. player fountain
 * isleyar/ui/*.py). style.py's tokens are the literal VS Code Dark+ hex
 * values, so that one wins wherever the two disagreed (border color,
 * surface grays). Duplicate "second green"/"second red" domain colors from
 * the original (motor_active #00aa00, valve_closed #cc0000) are intentionally
 * NOT carried over as distinct tokens -- they mapped to the same semantic
 * role as success/danger and existed only from stylesheet drift, not intent.
 */
export default {
  darkMode: "class",
  content: ["./src/renderer/index.html", "./src/renderer/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          base: "#1e1e1e",      // window/app background
          surface1: "#252526",   // sidebar, cards, status bar
          surface2: "#2d2d30",   // panels, tab panes
          surface3: "#3c3c3c",   // inputs, buttons, dropdowns
        },
        border: {
          DEFAULT: "#464647",
          light: "#3e3e40",
          separator: "#5a5a5c",
        },
        accent: {
          DEFAULT: "#007acc",   // focus rings, selection, active-tab border
          hover: "#1b8ad6",
        },
        primary: {
          DEFAULT: "#0078d4",   // CTA buttons
          hover: "#106ebe",
        },
        text: {
          primary: "#ffffff",
          secondary: "#cccccc",
          muted: "#969696",
          disabled: "#6e6e6e",
        },
        success: { DEFAULT: "#00cc6a", hover: "#00b35f" },
        warning: { DEFAULT: "#ffaa44", hover: "#e6943d" },
        danger: { DEFAULT: "#ff4757", hover: "#e63e4d" },
      },
      fontFamily: {
        ui: ["Segoe UI", "system-ui", "sans-serif"],
        mono: ["Consolas", "ui-monospace", "monospace"],
      },
      fontSize: {
        xs: ["9px", "1.4"],
        sm: ["10px", "1.4"],
        base: ["11px", "1.4"],
        md: ["12px", "1.4"],
        lg: ["14px", "1.4"],
      },
      spacing: {
        xs: "4px",
        sm: "8px",
        md: "12px",
        lg: "16px",
        xl: "24px",
      },
      borderRadius: {
        control: "4px",  // buttons, inputs
        panel: "6px",    // panels, tabs, menus
      },
      height: {
        control: "28px",  // buttons
        input: "24px",
        row: "32px",
      },
    },
  },
  plugins: [],
} satisfies Config;
