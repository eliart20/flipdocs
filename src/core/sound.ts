import type { FlipBookSoundSettings } from "../types";

/**
 * Page-turn audio. Everything is lazy: no AudioContext exists until the first
 * enabled play call, which always happens inside a user gesture or an
 * animation started by one, so autoplay policies are satisfied.
 */
export class PageTurnSound {
  private settings: FlipBookSoundSettings;
  private context?: AudioContext;
  private noise?: AudioBuffer;
  private clip?: AudioBuffer;
  private clipUrl?: string;
  private clipLoading = false;

  constructor(settings: FlipBookSoundSettings) {
    this.settings = { ...settings };
  }

  setSettings(settings: FlipBookSoundSettings): void {
    this.settings = { ...settings };
  }

  play(durationMs: number): void {
    if (!this.settings.enabled || this.settings.volume <= 0) return;
    const context = this.ensureContext();
    if (!context) return;
    if (context.state === "suspended") void context.resume();

    if (this.settings.src) {
      this.playClip(context);
      return;
    }
    this.playSwish(context, Math.max(0.14, Math.min(0.5, durationMs / 1000)));
  }

  private ensureContext(): AudioContext | undefined {
    if (this.context) return this.context;
    const Constructor =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Constructor) return undefined;
    this.context = new Constructor();
    return this.context;
  }

  private playClip(context: AudioContext): void {
    const url = this.settings.src;
    if (!url) return;
    if (this.clip && this.clipUrl === url) {
      const source = context.createBufferSource();
      source.buffer = this.clip;
      const gain = context.createGain();
      gain.gain.value = this.settings.volume;
      source.connect(gain).connect(context.destination);
      source.start();
      return;
    }
    if (this.clipLoading) return;
    this.clipLoading = true;
    void fetch(url)
      .then((response) => response.arrayBuffer())
      .then((buffer) => context.decodeAudioData(buffer))
      .then((decoded) => {
        this.clip = decoded;
        this.clipUrl = url;
      })
      .catch(() => undefined)
      .finally(() => {
        this.clipLoading = false;
      });
  }

  /** A filtered-noise swish: rising then falling band sweep, like paper. */
  private playSwish(context: AudioContext, duration: number): void {
    if (!this.noise) {
      const sampleRate = context.sampleRate;
      const buffer = context.createBuffer(1, Math.ceil(sampleRate * 0.6), sampleRate);
      const channel = buffer.getChannelData(0);
      let hold = 0;
      for (let index = 0; index < channel.length; index += 1) {
        // Lightly low-passed white noise reads as paper rather than static.
        hold = hold * 0.6 + (Math.random() * 2 - 1) * 0.4;
        channel[index] = hold;
      }
      this.noise = buffer;
    }

    const now = context.currentTime;
    const source = context.createBufferSource();
    source.buffer = this.noise;

    const filter = context.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 0.85;
    filter.frequency.setValueAtTime(650, now);
    filter.frequency.exponentialRampToValueAtTime(2400, now + duration * 0.55);
    filter.frequency.exponentialRampToValueAtTime(500, now + duration);

    const gain = context.createGain();
    const peak = this.settings.volume * 0.5;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, peak), now + duration * 0.35);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    source.connect(filter).connect(gain).connect(context.destination);
    source.start(now, 0, duration + 0.05);
  }

  dispose(): void {
    void this.context?.close().catch(() => undefined);
    this.context = undefined;
  }
}
