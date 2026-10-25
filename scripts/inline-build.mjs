// vite build 결과(dist/)의 JS · CSS 를 index.html 하나에 인라인한다.
// 파일 하나로 공유하거나 오프라인으로 열 때 쓴다.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;
let html = readFileSync(join(dist, 'index.html'), 'utf8');

html = html.replace(/<script type="module" crossorigin src="\.\/(assets\/[^"]+\.js)"><\/script>/, (_, file) => {
  const js = readFileSync(join(dist, file), 'utf8').replace(/<\/script/gi, '<\\/script');
  return `<script type="module">${js}</script>`;
});
html = html.replace(/<link rel="stylesheet" crossorigin href="\.\/(assets\/[^"]+\.css)">/, (_, file) => {
  return `<style>${readFileSync(join(dist, file), 'utf8')}</style>`;
});

if (/src="\.\/assets|href="\.\/assets/.test(html)) {
  console.error('인라인하지 못한 에셋 참조가 남아 있습니다.');
  process.exit(1);
}
writeFileSync(join(dist, 'index.html'), html);
console.log(`dist/index.html (${(html.length / 1024).toFixed(1)} KB, 단일 파일)`);
