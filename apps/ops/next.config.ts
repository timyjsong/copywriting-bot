import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    "@copywriting-bot/shared",
    "@copywriting-bot/agents",
    "@copywriting-bot/db",
    "@copywriting-bot/inngest",
  ],
};

export default config;
