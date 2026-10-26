import { describe, expect, it } from 'vitest';
import { FlingTracker } from '../src/input/controller';
import { Camera } from '../src/render/camera';

/** 1000×600 맵, 800×500 화면, HUD 여백 없음 */
function makeCamera(): Camera {
  const cam = new Camera();
  cam.resize(800, 500);
  cam.setBounds(1000, 600, { top: 0, right: 0, bottom: 0, left: 0 });
  cam.jumpTo(500, 300, 1);
  return cam;
}

describe('두 손가락 관성 속도 (FlingTracker)', () => {
  /** 손가락 둘이 같은 터치 이벤트에서 따로 오는 pointermove: 시각이 같거나 0.1ms 차이, 중점은 반씩 움직인다 */
  function pairedMoves(stepPx: number, frames: number, frameMs: number, pairGapMs: number): FlingTracker {
    const v = new FlingTracker();
    for (let i = 1; i <= frames; i++) {
      const t = 1000 + i * frameMs;
      v.track(stepPx / 2, 0, t);
      v.track(stepPx / 2, 0, t + pairGapMs);
    }
    return v;
  }

  it('손가락별 pointermove 가 같은 시각이어도 실제 속도를 낸다 (0 으로 리셋되지 않음)', () => {
    const v = pairedMoves(15, 8, 16, 0);
    const r = v.release(1000 + 8 * 16 + 10);
    expect(r).not.toBeNull();
    // 15px / 16ms ≈ 937 px/s (첫 표본은 지수 평균으로 덜 반영되므로 넉넉히)
    expect(r!.vx).toBeGreaterThan(800);
    expect(r!.vx).toBeLessThan(1000);
  });

  it('0.1ms 간격의 짝 이벤트로 수만 px/s 가 나오지 않는다', () => {
    const v = pairedMoves(15, 8, 16, 0.1);
    const r = v.release(1000 + 8 * 16 + 10);
    expect(r!.vx).toBeGreaterThan(800);
    expect(r!.vx).toBeLessThan(1000);
  });

  it('손을 떼기 전 잠시 멈췄으면 관성이 없다', () => {
    const v = pairedMoves(15, 8, 16, 0);
    expect(v.release(1000 + 8 * 16 + 200)).toBeNull();
  });
});

describe('카메라 관성', () => {
  it('속도 상한: 아무리 빠르게 던져도 4000 px/s 를 넘지 않는다', () => {
    const cam = makeCamera();
    cam.fling(-40000, 30000);
    expect(cam.flingSpeed).toBeCloseTo(4000, 6);
  });

  it('맵 끝에 막힌 축은 관성이 사라진다 (멈춘 화면을 짚은 탭이 먹히지 않게)', () => {
    const cam = makeCamera();
    // 오른쪽 아래 끝까지 붙인 뒤 계속 오른쪽(+x)으로 보려고 던진다: x 는 막히고 y 는 위로 움직일 수 있다
    cam.jumpTo(1000, 600, 1);
    const x0 = cam.x;
    cam.fling(-2000, 600);
    cam.update(1 / 60);
    expect(cam.x).toBeCloseTo(x0, 9);
    cam.update(1 / 60);
    expect(cam.flingSpeed).toBeGreaterThan(0);
    expect(cam.flingSpeed).toBeLessThan(600);
    // 끝에 막히지 않은 쪽은 계속 미끄러진다
    const y1 = cam.y;
    cam.update(1 / 60);
    expect(cam.y).toBeLessThan(y1);
  });

  it('맵 가운데에서는 감쇠하며 멈춘다', () => {
    const cam = makeCamera();
    cam.fling(300, 0);
    for (let i = 0; i < 120; i++) cam.update(1 / 60);
    expect(cam.flingSpeed).toBe(0);
  });
});
