import type { NextConfig } from 'next';
const config: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || '.next',
  output: 'standalone',
  poweredByHeader: false,
  serverExternalPackages: ['pg', '@electric-sql/pglite'],
  async headers() {
    return [{ source: '/:path*', headers: [
      {key:'X-Content-Type-Options',value:'nosniff'},
      {key:'X-Frame-Options',value:'DENY'},
      {key:'Referrer-Policy',value:'no-referrer'},
      {key:'Permissions-Policy',value:'camera=(), microphone=(), geolocation=()'},
      {key:'Content-Security-Policy',value:`default-src 'self'; script-src 'self' 'unsafe-inline'${process.env.NODE_ENV==='development'?" 'unsafe-eval'":''}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'${process.env.NODE_ENV==='development'?' ws://localhost:* ws://127.0.0.1:*':''}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`},
    ]}];
  }
};
export default config;
