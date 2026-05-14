import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    "@copywriting-bot/shared",
    "@copywriting-bot/agents",
    "@copywriting-bot/db",
    "@copywriting-bot/inngest",
  ],
  experimental: {
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default config;
