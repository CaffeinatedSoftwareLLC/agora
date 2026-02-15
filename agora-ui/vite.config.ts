import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/auth': 'http://localhost:3000',
      '/instance': 'http://localhost:3000',
      '/servers': 'http://localhost:3000',
      '/channels': 'http://localhost:3000',
      '/invites': 'http://localhost:3000',
      '/admin': 'http://localhost:3000',
      '/users': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
      },
    }
  }
})
