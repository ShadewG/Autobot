/** @type {import('next').NextConfig} */
const isDev = process.env.NODE_ENV !== 'production';
const apiTarget = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api';
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
              source: '/api/:path*',
              destination: `${apiOrigin}/api/:path*`,
            },
          ];
        },
      }
    : {}),
};

module.exports = nextConfig;
