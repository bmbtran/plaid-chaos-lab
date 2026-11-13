/** Small deterministic PRNG (mulberry32). Same seed ⇒ same sequence. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = (seed >>> 0) ^ 0x9e3779b9;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /** Amount in dollars with cents. */
  money(min: number, max: number): number {
    return Math.round((min + this.next() * (max - min)) * 100) / 100;
  }

  hex(len: number): string {
    let s = '';
    for (let i = 0; i < len; i++) s += Math.floor(this.next() * 16).toString(16);
    return s;
  }

  shuffle<T>(items: T[]): T[] {
    const a = items.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}
