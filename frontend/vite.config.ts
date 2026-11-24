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
        env: {
            // styled-components outside production appends each new rule as
            // text to its <style>, and jsdom then parses the whole sheet
            // again: a screen's first render cost grows with every style
            // already on the page (about 200 ms for Settings after Home).
            // Speedy mode inserts each rule through the CSSOM instead, which
            // jsdom parses alone.
            SC_DISABLE_SPEEDY: 'false',
        },
    },
})
