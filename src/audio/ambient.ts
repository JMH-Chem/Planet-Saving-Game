// 한 판 내내 깔리는 우주 배경음. 들리는 듯 마는 듯한 크기로, 전투가 격해지면 긴장 레이어가 올라온다.

/** 레이어별 최대 게인. 버스 이후 마스터/컴프레서를 거치므로 실제 출력은 이보다 작다 */
const PAD_GAIN = 0.03;
const RUMBLE_GAIN = 0.1;
const AIR_GAIN = 0.012;
const TENSION_GAIN = 0.032;

export class Ambient {
  private out: GainNode;
  private sources: AudioScheduledSourceNode[] = [];
  private nodes: AudioNode[] = [];
  private tension: GainNode;
  private tensionFilter: BiquadFilterNode;
  private padFilter: BiquadFilterNode;
  private stopped = false;

  constructor(
    private ctx: AudioContext,
    dest: AudioNode,
    noise: AudioBuffer,
  ) {
    const t = ctx.currentTime + 0.02;
    this.out = this.gain(0);
    this.out.connect(dest);
    // 판 시작 직후 갑자기 '웅' 하지 않게 몇 초에 걸쳐 스며들게 한다
    this.out.gain.setTargetAtTime(1, t, 1.5);

    // ── 패드: A 단조 근음/5도를 살짝 어긋나게(detune) 겹쳐 천천히 맥놀이하게 한다 ──
    this.padFilter = this.filter('lowpass', 280, 0.6);
    const pad = this.gain(PAD_GAIN);
    this.padFilter.connect(pad).connect(this.out);
    this.voice('sawtooth', 55, -9, 1, this.padFilter);
    this.voice('sawtooth', 55, 8, 1, this.padFilter);
    this.voice('triangle', 82.41, 0, 0.8, this.padFilter);
    this.voice('sine', 110, 4, 0.5, this.padFilter);
    // 아주 느린 LFO 로 필터를 열고 닫아 '숨 쉬는' 느낌 (주기 ~22초)
    this.lfo(0.045, 90, this.padFilter.frequency);

    // ── 저음 럼블: 노이즈를 두 번 저역 통과시켜 멀리서 울리는 엔진음처럼 ──
    const rumble = this.noiseLoop(noise, 0.5);
    const lp1 = this.filter('lowpass', 110, 0.5);
    const lp2 = this.filter('lowpass', 110, 0.5);
    const rumbleGain = this.gain(RUMBLE_GAIN);
    rumble.connect(lp1).connect(lp2).connect(rumbleGain).connect(this.out);

    // ── 공기: 중역 대역 노이즈를 좌우로 아주 천천히 흘린다 ──
    const air = this.noiseLoop(noise, 1);
    const hp = this.filter('highpass', 350, 0.5);
    const lp = this.filter('lowpass', 1300, 0.5);
    const airGain = this.gain(AIR_GAIN);
    air.connect(hp).connect(lp).connect(airGain);
    this.lfo(0.07, AIR_GAIN * 0.5, airGain.gain);
    if (typeof ctx.createStereoPanner === 'function') {
      const pan = ctx.createStereoPanner();
      this.nodes.push(pan);
      airGain.connect(pan).connect(this.out);
      this.lfo(0.031, 0.6, pan.pan);
    } else {
      airGain.connect(this.out);
    }

    // ── 긴장 레이어: 단2도(A2 · B♭2)의 불협 맥놀이. 평소엔 0, 교전량에 따라 올라온다 ──
    this.tensionFilter = this.filter('lowpass', 220, 1.8);
    this.tension = this.gain(0);
    this.tensionFilter.connect(this.tension).connect(this.out);
    this.voice('sawtooth', 110, 0, 1, this.tensionFilter);
    this.voice('sawtooth', 116.54, 0, 1, this.tensionFilter);
    this.voice('square', 55, 0, 0.5, this.tensionFilter);

    for (const s of this.sources) s.start(t);
  }

  /** 0~1 전투 강도. 게인과 필터를 부드럽게 따라가게 한다 */
  setIntensity(x: number): void {
    if (this.stopped) return;
    const t = this.ctx.currentTime;
    const k = Math.max(0, Math.min(1, x));
    this.tension.gain.setTargetAtTime(TENSION_GAIN * k * k * (3 - 2 * k), t, 0.8);
    this.tensionFilter.frequency.setTargetAtTime(220 + 900 * k, t, 1.2);
    this.padFilter.frequency.setTargetAtTime(280 + 160 * k, t, 2);
  }

  /** 일시정지 등: 배경을 반쯤 낮춘다 */
  setDucked(ducked: boolean): void {
    if (this.stopped) return;
    this.out.gain.setTargetAtTime(ducked ? 0.45 : 1, this.ctx.currentTime, 0.3);
  }

  stop(fade = 1): void {
    if (this.stopped) return;
    this.stopped = true;
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(0, t, fade / 4);
    const end = t + fade + 0.1;
    for (const s of this.sources) s.stop(end);
    this.sources[0].onended = () => {
      for (const n of this.nodes) n.disconnect();
    };
  }

  // ───────────────────────────── 부품 ─────────────────────────────

  private gain(value: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = value;
    this.nodes.push(g);
    return g;
  }

  private filter(type: BiquadFilterType, freq: number, q: number): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    this.nodes.push(f);
    return f;
  }

  private voice(type: OscillatorType, freq: number, detune: number, level: number, dest: AudioNode): void {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.detune.value = detune;
    const g = this.gain(level);
    o.connect(g).connect(dest);
    this.sources.push(o);
    this.nodes.push(o);
  }

  private noiseLoop(noise: AudioBuffer, rate: number): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = noise;
    s.loop = true;
    s.playbackRate.value = rate;
    this.sources.push(s);
    this.nodes.push(s);
    return s;
  }

  /** 사인 LFO 를 파라미터에 더한다 (파라미터의 기본값을 중심으로 ±depth) */
  private lfo(freq: number, depth: number, target: AudioParam): void {
    const o = this.ctx.createOscillator();
    o.frequency.value = freq;
    const g = this.gain(depth);
    o.connect(g).connect(target);
    this.sources.push(o);
    this.nodes.push(o);
  }
}
