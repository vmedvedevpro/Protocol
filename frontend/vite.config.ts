/// <reference types="vitest/config" />
import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
import {fileURLToPath} from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@': path.resolve(root, 'src'),
            // @blocknote/react's emoji picker imports this module on demand, and
            // it imports one chunk of emoji names per locale: 25 chunks, 3.2 MB,
            // emitted into `out/` and so into the installer. The notes editor
            // draws none of BlockNote's menus, so the picker never loads them.
            '@blocknote/core/emoji-data': path.resolve(root, 'src/components/editor/noEmojiData.ts'),
        },
    },
    // Tauri prints the native build log into the same terminal.
    clearScreen: false,
    server: {
        // tauri.conf.json `devUrl` points here; another port would load nothing.
        // `pnpm dev`, the browser on mock IPC, takes 3119 instead, so it can
        // keep running while `tauri dev` starts this one.
        port: 3118,
        strictPort: true,
        watch: {
            ignored: ['**/src-tauri/**'],
        },
    },
    build: {
        // `frontendDist` in tauri.conf.json and the packaging scripts read `out`.
        outDir: 'out',
    },
    test: {
        environment: 'jsdom',
        setupFiles: ['./src/test/setup.ts'],
        include: ['src/**/*.test.{ts,tsx}'],
        restoreMocks: true,
    },
})
