import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  // 상대 경로 빌드: GitHub Pages 하위 경로, Capacitor/Tauri 래핑 모두 그대로 동작
  base: './',
  build: { target: 'es2022' },
  // .claude/ 아래에는 에이전트 작업용 git worktree 가 생길 수 있다: 그 안의 테스트 사본은 돌리지 않는다
  test: { exclude: [...configDefaults.exclude, '.claude/**'] },
});
