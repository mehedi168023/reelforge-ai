import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Only the two APIs the app needs can be reached from a production build, and film pages load
// only from this site's own frame.html.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "frame-src 'self'",
  "worker-src 'self' blob:",
  "connect-src 'self' https://api.anthropic.com https://api.elevenlabs.io https://api.cartesia.ai",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

export default defineConfig(({ command, mode }) => ({
  // Relative paths, so the build works from any folder on any static host.
  base: './',
  plugins: [
    react(),
    {
      name: 'reelforge-csp',
      transformIndexHtml(html: string) {
        if (command !== 'build') return html;
        // The end-to-end test runs this same policy, plus a route to its local stand-in for the APIs.
        const policy = mode === 'mock' ? CSP.replace("connect-src 'self'", "connect-src 'self' http://localhost:8799") : CSP;
        return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}">`);
      },
    },
  ],
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
}));
