/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        eos: {
          purple: "#7c3aed",
          pink: "#ff007f",
          cyan: "#00f0ff",
          dark: "#0b0c10",
          card: "rgba(18, 18, 26, 0.75)",
        },
      },
      fontFamily: {
        mono: [
          "'JetBrains Mono'",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "'Segoe UI'",
          "Roboto",
          "sans-serif",
        ],
      },
      boxShadow: {
        "frosted": "0 16px 36px 0 rgba(0, 0, 0, 0.65)",
        "neo-inset": "inset 2px 2px 5px rgba(0, 0, 0, 0.6), inset -2px -2px 5px rgba(255, 255, 255, 0.05)",
        "neo-raised": "3px 3px 6px rgba(0, 0, 0, 0.5), -1px -1px 3px rgba(255, 255, 255, 0.08)",
        "glow-cyan": "0 0 15px rgba(0, 240, 255, 0.35)",
        "glow-purple": "0 0 15px rgba(124, 58, 237, 0.4)",
      },
      animation: {
        "pulse-subtle": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
    },
  },
  plugins: [],
};
