import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0f172a",
        cream: "#f8fafc",
        accent: "#2563eb",
      },
    },
  },
  plugins: [],
};

export default config;
