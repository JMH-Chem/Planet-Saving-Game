import { CONFIG } from '../config';
import { drawSprite, glowSprite, mixHex } from './sprites';

// 명령 피드백: 선택 병력의 무게중심에서 목표까지 흐르는 점선 경로 + 명령 종류별 목표 표식.
// '내 명령이 무엇으로 해석됐는지'를 한눈에 보여 주는 것이 목적 (특히 마우스 호버 힌트가 없는 터치에서).

export type OrderKind = 'move' | 'assault' | 'surround' | 'join' | 'line' | 'return';

export interface OrderFeedback {
  /** 선택 병력의 무게중심 */
  x0: number;
  y0: number;
  /** 목표 지점 (행성 명령이면 행성 중심, 횡대면 선의 시작점) */
  x1: number;
  y1: number;
  kind: OrderKind;
  count: number;
  /** 행성 명령: 대상 행성 반경 (포위 · 합류 고리 크기) */
  radius?: number;
  /** 횡대: 선의 끝점 */
  x2?: number;
  y2?: number;
}

interface Active extends OrderFeedback {
  age: number;
  life: number;
  color: string;
}

const STYLE: Record<OrderKind, { color: string; label: string }> = {
  move: { color: '#8fe3ff', label: '이동' },
  assault: { color: '#ff6b5b', label: '돌파' },
  surround: { color: '#ffc857', label: '포위' },
  join: { color: '#4fd8ff', label: '합류' },
  line: { color: '#7fd8ff', label: '횡대' },
  return: { color: '#7dffb0', label: '귀환' },
};

const LIFE = 1.1;
const PATH_LIFE = 0.8;

export class OrderFx {
  private list: Active[] = [];

  add(o: OrderFeedback): void {
    if (this.list.length >= 8) this.list.shift();
    this.list.push({ ...o, age: 0, life: LIFE, color: STYLE[o.kind].color });
  }

  update(dt: number): void {
    let w = 0;
    for (const o of this.list) {
      o.age += dt;
      if (o.age < o.life) this.list[w++] = o;
    }
    this.list.length = w;
  }

  /** 경로 (병력 아래) */
  drawPaths(ctx: CanvasRenderingContext2D, zoom: number): void {
    if (this.list.length === 0) return;
    const px = 1 / zoom;
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const o of this.list) {
      if (o.age > PATH_LIFE || o.count === 0) continue;
      const [tx, ty] = o.kind === 'line' ? [(o.x1 + (o.x2 ?? o.x1)) / 2, (o.y1 + (o.y2 ?? o.y1)) / 2] : [o.x1, o.y1];
      const dx = tx - o.x0, dy = ty - o.y0;
      const len = Math.hypot(dx, dy);
      const stop = stopRadius(o);
      if (len < stop + 14 * px) continue;
      const ux = dx / len, uy = dy / len;
      const sx = o.x0 + ux * 6 * px, sy = o.y0 + uy * 6 * px;
      const ex = tx - ux * stop, ey = ty - uy * stop;
      const t = o.age / PATH_LIFE;
      const fade = 1 - t * t;

      ctx.globalAlpha = 0.18 * fade;
      ctx.strokeStyle = o.color;
      ctx.lineWidth = 5 * px;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.stroke();

      // 목표 쪽으로 흐르는 점선
      ctx.setLineDash([7 * px, 6 * px]);
      ctx.lineDashOffset = -o.age * 60 * px;
      ctx.globalAlpha = 0.75 * fade;
      ctx.lineWidth = 1.6 * px;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;

      // 경로를 따라 날아가는 빛 한 점
      const k = Math.min(1, o.age / 0.35);
      const e = 1 - Math.pow(1 - k, 3);
      const r = 7 * px;
      ctx.globalAlpha = (1 - k * 0.6) * fade;
      drawSprite(ctx, glowSprite(o.color), sx + (ex - sx) * e, sy + (ey - sy) * e, r);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** 목표 표식과 병력 수 (병력 위) */
  drawMarkers(ctx: CanvasRenderingContext2D, zoom: number, clock: number): void {
    if (this.list.length === 0) return;
    const px = 1 / zoom;
    for (const o of this.list) {
      const t = o.age / o.life;
      const fade = t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25;
      const ease = 1 - Math.pow(1 - Math.min(1, o.age / 0.3), 3);
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = o.color;
      ctx.lineCap = 'round';
      ctx.globalAlpha = fade;
      const R = o.radius ?? 0;

      switch (o.kind) {
        case 'move': {
          // 안쪽으로 모여드는 세 개의 꺾쇠 + 줄어드는 고리
          const rr = (20 - 11 * ease) * px;
          ctx.lineWidth = 1.8 * px;
          for (let i = 0; i < 3; i++) {
            const a = -Math.PI / 2 + (i * Math.PI * 2) / 3 + o.age * 1.2;
            const cx = o.x1 + Math.cos(a) * rr, cy = o.y1 + Math.sin(a) * rr;
            const s = 4.5 * px;
            ctx.beginPath();
            ctx.moveTo(cx + Math.cos(a + 0.9) * s, cy + Math.sin(a + 0.9) * s);
            ctx.lineTo(cx, cy);
            ctx.lineTo(cx + Math.cos(a - 0.9) * s, cy + Math.sin(a - 0.9) * s);
            ctx.stroke();
          }
          ctx.globalAlpha = fade * (1 - ease * 0.5);
          ctx.lineWidth = 1.2 * px;
          ctx.beginPath();
          ctx.arc(o.x1, o.y1, (14 - 9 * ease) * px, 0, Math.PI * 2);
          ctx.stroke();
          this.dot(ctx, o.x1, o.y1, 4 * px, o.color, fade);
          break;
        }
        case 'assault': {
          // 회전하며 조여드는 조준 꺾쇠
          const rr = R + 10 + (1 - ease) * 18;
          const rot = o.age * 2.2;
          ctx.lineWidth = Math.max(2.2 * px, 1.6);
          ctx.beginPath();
          for (let i = 0; i < 4; i++) {
            const a = rot + (i * Math.PI) / 2 + Math.PI / 4;
            ctx.moveTo(o.x1 + Math.cos(a - 0.28) * rr, o.y1 + Math.sin(a - 0.28) * rr);
            ctx.arc(o.x1, o.y1, rr, a - 0.28, a + 0.28);
          }
          ctx.stroke();
          ctx.lineWidth = Math.max(1.4 * px, 1);
          ctx.beginPath();
          for (let i = 0; i < 4; i++) {
            const a = (i * Math.PI) / 2 - rot * 0.5;
            ctx.moveTo(o.x1 + Math.cos(a) * (rr + 3), o.y1 + Math.sin(a) * (rr + 3));
            ctx.lineTo(o.x1 + Math.cos(a) * (rr - 7), o.y1 + Math.sin(a) * (rr - 7));
          }
          ctx.stroke();
          ctx.globalAlpha = fade * 0.5 * (1 - ease);
          ctx.lineWidth = 6 * px;
          ctx.beginPath();
          ctx.arc(o.x1, o.y1, rr, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case 'surround': {
          // 대형이 설 고리(대기권 바로 밖)를 점선으로
          const rr = R + CONFIG.surroundAltitude + (1 - ease) * 14;
          ctx.setLineDash([6 * px, 5 * px]);
          ctx.lineDashOffset = -clock * 20 * px;
          ctx.lineWidth = Math.max(2 * px, 1.5);
          ctx.beginPath();
          ctx.arc(o.x1, o.y1, rr, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.lineDashOffset = 0;
          ctx.globalAlpha = fade * 0.25;
          ctx.lineWidth = 7 * px;
          ctx.stroke();
          break;
        }
        case 'join':
        case 'return': {
          // 궤도 고리로 내려앉는 원
          const orbit = R + (CONFIG.orbitBand[0] + CONFIG.orbitBand[1]) / 2;
          const rr = orbit + (1 - ease) * 16;
          ctx.lineWidth = Math.max(2 * px, 1.4);
          ctx.beginPath();
          ctx.arc(o.x1, o.y1, rr, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = fade * 0.3;
          ctx.lineWidth = 6 * px;
          ctx.stroke();
          ctx.globalAlpha = fade;
          for (let i = 0; i < 6; i++) {
            const a = o.age * 1.5 + (i * Math.PI) / 3;
            this.dot(ctx, o.x1 + Math.cos(a) * rr, o.y1 + Math.sin(a) * rr, 3.5 * px, o.color, fade);
          }
          break;
        }
        case 'line': {
          const x2 = o.x2 ?? o.x1, y2 = o.y2 ?? o.y1;
          ctx.lineWidth = 7 * px;
          ctx.globalAlpha = fade * 0.25;
          ctx.beginPath();
          ctx.moveTo(o.x1, o.y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          ctx.lineWidth = 1.8 * px;
          ctx.globalAlpha = fade;
          ctx.stroke();
          // 선을 따라 훑고 지나가는 빛
          const k = Math.min(1, o.age / 0.45);
          this.dot(ctx, o.x1 + (x2 - o.x1) * k, o.y1 + (y2 - o.y1) * k, 8 * px, o.color, fade * (1 - k * 0.5));
          this.dot(ctx, o.x1, o.y1, 4 * px, o.color, fade);
          this.dot(ctx, x2, y2, 4 * px, o.color, fade);
          break;
        }
      }
      ctx.globalCompositeOperation = 'source-over';

      // 병력 수
      if (o.count > 0 && o.kind !== 'return') {
        const [lx, ly] = o.kind === 'line' ? [(o.x1 + (o.x2 ?? o.x1)) / 2, (o.y1 + (o.y2 ?? o.y1)) / 2] : [o.x1, o.y1];
        const above = (o.kind === 'move' || o.kind === 'line' ? 22 * px : stopRadius(o) + 12 * px) + (1 - ease) * 6 * px;
        ctx.globalAlpha = fade;
        ctx.font = `800 ${12 * px}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const text = `${STYLE[o.kind].label} ${o.count}`;
        ctx.lineWidth = 3 * px;
        ctx.strokeStyle = 'rgba(3,5,12,0.85)';
        ctx.strokeText(text, lx, ly - above);
        ctx.fillStyle = mixHex(o.color, '#ffffff', 0.35);
        ctx.fillText(text, lx, ly - above);
      }
    }
    ctx.globalAlpha = 1;
  }

  private dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, a: number): void {
    const prev = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = a;
    drawSprite(ctx, glowSprite(color), x, y, r);
    ctx.globalCompositeOperation = prev;
  }
}

/** 경로 점선이 멈출 거리 (표식과 겹치지 않게) */
function stopRadius(o: OrderFeedback): number {
  const R = o.radius ?? 0;
  switch (o.kind) {
    case 'assault':
      return R + 12;
    case 'surround':
      return R + CONFIG.surroundAltitude + 4;
    case 'join':
    case 'return':
      return R + CONFIG.orbitBand[1] + 4;
    default:
      return 12;
  }
}

export const orderColor = (kind: OrderKind) => STYLE[kind].color;
