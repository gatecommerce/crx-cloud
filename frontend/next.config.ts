import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  output: "standalone",
  skipTrailingSlashRedirect: true,
  experimental: {
    middlewareClientMaxBodySize: "500mb",
  },
  async rewrites() {
    // Server-side rewrite: use internal Docker network URL when available
    const backendUrl = process.env.API_URL_INTERNAL || process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";
    return [
      // WebSocket passthrough for log streaming
      {
        source: "/ws/:path*",
        destination: `${backendUrl}/ws/:path*`,
      },
      {
        source: "/api/:path*",
        destination: `${backendUrl}/api/:path*`,
      },
    ];
  },
};

export default withNextIntl(nextConfig);
