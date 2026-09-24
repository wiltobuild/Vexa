import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ base: process.env.VITE_BASE ?? '/', plugins: [react()], server: { port: 5173, strictPort: true, proxy: { '/api': {target:'http://127.0.0.1:3001',rewrite:path=>path.replace(/^\/api/,'')}, '/gateway': {target:'ws://127.0.0.1:3002',ws:true} } } });
