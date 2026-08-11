import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.MISSION_CONTROL_NEXT_DIST_DIR || ".next",
  allowedDevOrigins: ["127.0.0.1", "localhost", "joaquins-mac-mini.tail12193b.ts.net"],
};

export default nextConfig;
