export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** 월드 ↔ 화면 좌표 변환. (x, y) 는 화면 중앙에 오는 월드 좌표 */
export class Camera {
  x = 0;
  y = 0;
  zoom = 1;
  /** CSS 픽셀 단위 뷰포트 크기 */
  width = 1;
  height = 1;
  minZoom = 0.2;
  maxZoom = 4;

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  /** 월드 전체가 HUD 를 피해 화면에 들어오도록 맞춘다 */
  fit(worldW: number, worldH: number, insets: Insets): void {
    const w = Math.max(50, this.width - insets.left - insets.right);
    const h = Math.max(50, this.height - insets.top - insets.bottom);
    this.zoom = Math.min(w / worldW, h / worldH);
    this.minZoom = this.zoom * 0.6;
    this.maxZoom = Math.max(3, this.zoom * 6);
    // 인셋이 비대칭이면 보이는 영역의 중심에 월드 중심이 오도록 보정
    this.x = worldW / 2 - (insets.left - insets.right) / 2 / this.zoom;
    this.y = worldH / 2 - (insets.top - insets.bottom) / 2 / this.zoom;
  }

  toScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: (wx - this.x) * this.zoom + this.width / 2, y: (wy - this.y) * this.zoom + this.height / 2 };
  }

  toWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.width / 2) / this.zoom + this.x, y: (sy - this.height / 2) / this.zoom + this.y };
  }

  /** 화면 좌표 (sx, sy) 를 고정점으로 확대/축소 */
  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.toWorld(sx, sy);
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor));
    const after = this.toWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }

  panScreen(dx: number, dy: number): void {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
  }

  clampTo(worldW: number, worldH: number): void {
    const m = 200;
    this.x = Math.min(worldW + m, Math.max(-m, this.x));
    this.y = Math.min(worldH + m, Math.max(-m, this.y));
  }
}
