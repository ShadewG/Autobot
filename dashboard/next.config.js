/** @type {import('next').NextConfig} */
const isDev = process.env.NODE_ENV !== 'production';
const apiTarget =
  process.env.NEXT_PUBLIC_API_URL ||
  process.env.API_URL ||
  'http://localhost:3004/api';
// Strip trailing /api for the rewrite destination base
const apiOrigin = apiTarget.replace(/\/api\/?$/, '');

const nextConfig = {
  // Static export for production (Railway), but allow rewrites in dev
  ...(isDev ? {} : { output: 'export' }),
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  ...(isDev
    ? {
        async rewrites() {
          return [
            {
              // Strip trailing slash before proxying to backend
              source: '/api/:path*/',
              destination: `${apiOrigin}/api/:path*`,
            },
            {
              source: '/api/:path*',
              destination: `${apiOrigin}/api/:path*`,
            },
          ];
        },
      }
    : {}),
};

module.exports = nextConfig;
