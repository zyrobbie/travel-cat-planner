import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  async rewrites() {
    return [{ source: "/account-app", destination: "/account-app/index.html" }];
  },
};
export default config;
