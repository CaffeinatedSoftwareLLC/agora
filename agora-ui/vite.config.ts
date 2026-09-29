import { defineConfig, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const API = 'http://localhost:3000'

// Same prefixes nginx proxies to the API (agora-ui/nginx.conf). Some overlap with SPA
// routes (e.g. /admin/users), so browser page loads (Accept: text/html) fall through
// to the SPA and only API requests are proxied.
const API_PREFIXES = ['auth', 'servers', 'channels', 'invites', 'admin', 'users', 'health', 'instance',
  'unreads', 'messages', 'roles', 'files', 'bots']

const apiProxy: ProxyOptions = {
  target: API,
  bypass: (req) => (req.headers.accept?.includes('text/html') ? req.url : undefined),
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      ...Object.fromEntries(API_PREFIXES.map(p => [`/${p}`, apiProxy])),
      '/socket.io': {
        target: API,
        ws: true,
      },
    }
  }
})
