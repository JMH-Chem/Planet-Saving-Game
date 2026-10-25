import { defineConfig } from 'vite';

export default defineConfig({
  // 상대 경로 빌드: GitHub Pages 하위 경로, Capacitor/Tauri 래핑 모두 그대로 동작
  base: './',
  build: { target: 'es2022' },
});
