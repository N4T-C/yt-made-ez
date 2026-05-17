import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
    plugins: [react()],
    // base './' is critical for Electron file:// loading
    base: './',
    build: {
        outDir: 'dist',
        emptyOutDir: true,
    },
    server: {
        port: 5173,
    },
    resolve: {
        alias: {
            // Reuse the original client CSS (no copy needed)
            '@css': path.resolve(__dirname, '../../client/src'),
        },
    },
})
