import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingIncludes: { "/*": ["./assets/fonts/*.ttf"] },
};

export default nextConfig;
