// 효과음 합성의 기본 부품. 오디오 파일 없이 오실레이터 · 노이즈 · 필터 · 엔벨로프만으로 소리를 만든다.

/** 지수 램프는 0 에 닿을 수 없으므로 '사실상 무음'(-80dB) 을 바닥으로 쓴다 */
export const FLOOR = 0.0001;

/** MIDI 음 번호 → 주파수(Hz). 화음/아르페지오를 음이름 대신 숫자로 적기 위해 */
export const midi = (n: number): number => 440 * 2 ** ((n - 69) / 12);

/**
 * 타악기형 엔벨로프: 짧은 선형 어택 + 지수 감쇠.
 * 0 에서 출발해 바닥값으로 끝나므로 시작/끝에서 '틱' 하는 클릭음이 생기지 않는다.
 */
export function pluck(p: AudioParam, t: number, peak: number, attack: number, decay: number): void {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + attack);
  p.exponentialRampToValueAtTime(FLOOR, t + attack + decay);
}

/** 지속음 엔벨로프: 어택 → 유지 → 릴리스 (경보, 호른, 패드) */
export function hold(p: AudioParam, t: number, peak: number, attack: number, sustain: number, release: number): void {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + attack);
  p.setValueAtTime(peak, t + attack + sustain);
  p.exponentialRampToValueAtTime(FLOOR, t + attack + sustain + release);
}

/** 주파수(또는 필터 컷오프) 지수 스윕. 사람 귀는 음높이를 로그로 듣기 때문에 지수가 자연스럽다 */
export function sweep(p: AudioParam, t: number, from: number, to: number, dur: number): void {
  p.setValueAtTime(from, t);
  p.exponentialRampToValueAtTime(to, t + dur);
}

/** 2초짜리 화이트 노이즈. 모든 폭발/바람 소리가 이 버퍼 하나를 오프셋만 바꿔 재사용한다 */
export function makeNoise(ctx: BaseAudioContext, seconds = 2): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

/**
 * 한 번 울리고 사라지는 소리 하나. 노드를 만들 때 등록해 두고, 가장 늦게 끝나는 소스가
 * 끝나면 전부 disconnect 해서 오디오 그래프에 찌꺼기가 쌓이지 않게 한다.
 */
export class Voice {
  /** 이 소리의 출력. 여기에 연결하면 (패닝 →) 버스로 간다 */
  readonly out: GainNode;
  private nodes: AudioNode[] = [];
  private tail: AudioScheduledSourceNode | null = null;
  private tailEnd = -1;

  constructor(
    readonly ctx: AudioContext,
    dest: AudioNode,
    pan: number,
    /** 공유 노이즈 버퍼 (makeNoise) */
    private noiseBuffer: AudioBuffer,
  ) {
    this.out = ctx.createGain();
    this.nodes.push(this.out);
    const panner = pan !== 0 ? this.panner(pan) : null;
    if (panner) this.out.connect(panner).connect(dest);
    else this.out.connect(dest);
  }

  /** 초기값 0 인 게인 (엔벨로프를 걸기 전에 새어 나오는 소리가 없도록) */
  gain(value = 0): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = value;
    this.nodes.push(g);
    return g;
  }

  filter(type: BiquadFilterType, freq: number, q = 0.7): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    this.nodes.push(f);
    return f;
  }

  /** 구형 사파리 등 StereoPanner 가 없으면 null (패닝 없이 가운데서 들린다) */
  panner(pan: number): StereoPannerNode | null {
    if (typeof this.ctx.createStereoPanner !== 'function') return null;
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    this.nodes.push(p);
    return p;
  }

  osc(type: OscillatorType, freq: number, t0: number, t1: number): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    this.schedule(o, t0, t1);
    return o;
  }

  /** 공유 노이즈 버퍼의 무작위 구간을 재생. rate 로 질감(거칠기)을 바꾼다 */
  noise(t0: number, t1: number, rate = 1): AudioBufferSourceNode {
    const buffer = this.noiseBuffer;
    const s = this.ctx.createBufferSource();
    s.buffer = buffer;
    s.playbackRate.value = rate;
    const len = (t1 - t0) * rate;
    if (len >= buffer.duration) {
      s.loop = true;
      this.schedule(s, t0, t1);
    } else {
      this.nodes.push(s);
      s.start(t0, Math.random() * (buffer.duration - len));
      this.mark(s, t1);
    }
    return s;
  }

  /** 모든 소스를 예약한 뒤 한 번 호출: 마지막 소스가 끝나면 노드를 정리한다 */
  done(): void {
    const nodes = this.nodes;
    if (!this.tail) return;
    this.tail.onended = () => {
      for (const n of nodes) n.disconnect();
    };
  }

  private schedule(s: AudioScheduledSourceNode, t0: number, t1: number): void {
    this.nodes.push(s);
    s.start(t0);
    this.mark(s, t1);
  }

  private mark(s: AudioScheduledSourceNode, t1: number): void {
    s.stop(t1);
    if (t1 >= this.tailEnd) {
      this.tailEnd = t1;
      this.tail = s;
    }
  }
}
