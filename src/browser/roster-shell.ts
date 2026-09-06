type OrbState = "working" | "searching" | "solving" | "listening" | "composing" | "shaping";

const ORB_SELECTOR = "[data-thinking-orb]";
const instances = new Map<HTMLElement, NativeThinkingOrb>();
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const stateFor = (node: HTMLElement): OrbState => {
  const state = node.dataset.orbState;
  if (state === "working" || state === "searching" || state === "solving" || state === "listening" || state === "composing" || state === "shaping") return state;
  return "listening";
};

const darkTheme = (node: HTMLElement): boolean => {
  const themed = node.closest<HTMLElement>("[data-theme]")?.dataset.theme;
  if (themed) return themed === "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
};

class NativeThinkingOrb {
  readonly canvas = document.createElement("canvas");
  private visible = true;

  constructor(readonly host: HTMLElement) {
    this.canvas.dataset.slot = "thinking-orb-canvas";
    this.canvas.setAttribute("aria-hidden", "true");
    this.host.setAttribute("role", "img");
    this.host.replaceChildren(this.canvas);
    visibility.observe(this.host);
    this.resize();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
  }

  resize(): number {
    const requested = Number(this.host.dataset.orbSize);
    const size = Number.isFinite(requested) ? Math.min(96, Math.max(16, Math.round(requested))) : 64;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (this.canvas.width !== size * ratio || this.canvas.height !== size * ratio) {
      this.canvas.width = size * ratio;
      this.canvas.height = size * ratio;
    }
    return size;
  }

  draw(now: number): void {
    if (!this.visible) return;
    const size = this.resize();
    const context = this.canvas.getContext("2d");
    if (!context) return;
    const ratio = this.canvas.width / size;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, size, size);
    const paused = reduceMotion.matches || this.host.dataset.orbPaused === "true";
    const time = paused ? 1.4 : now / 1_000;
    const ink = darkTheme(this.host) ? 244 : 20;
    const state = stateFor(this.host);
    if (state === "listening" || state === "composing") this.drawWave(context, size, time, ink);
    else if (state === "solving" || state === "shaping") this.drawShape(context, size, time, ink);
    else this.drawOrbits(context, size, time, ink, state === "searching");
  }

  private dot(context: CanvasRenderingContext2D, x: number, y: number, radius: number, ink: number, alpha: number): void {
    context.fillStyle = `rgba(${ink},${ink},${ink},${alpha})`;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  }

  private drawOrbits(context: CanvasRenderingContext2D, size: number, time: number, ink: number, scanning: boolean): void {
    const center = size / 2;
    const scale = size / 64;
    const rings = size <= 24 ? 2 : size < 48 ? 3 : 4;
    const count = size <= 24 ? 12 : size < 48 ? 18 : 24;
    for (let ring = 0; ring < rings; ring += 1) {
      const tilt = (ring / rings) * Math.PI + 0.34;
      for (let index = 0; index < count; index += 1) {
        const angle = index / count * Math.PI * 2 + time * (0.34 + ring * 0.05);
        const radius = size * (0.27 + ring * 0.035);
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius * 0.43;
        const px = center + x * Math.cos(tilt) - y * Math.sin(tilt);
        const py = center + x * Math.sin(tilt) + y * Math.cos(tilt);
        const sweep = scanning ? Math.max(0.2, Math.cos(angle - time * 1.5) ** 8) : 1;
        this.dot(context, px, py, (0.95 + 0.42 * Math.sin(angle)) * scale, ink, (0.34 + sweep * 0.64));
      }
    }
  }

  private drawWave(context: CanvasRenderingContext2D, size: number, time: number, ink: number): void {
    const scale = size / 64;
    const rows = size <= 24 ? 3 : size < 48 ? 5 : 7;
    const count = size <= 24 ? 7 : size < 48 ? 12 : 17;
    for (let row = 0; row < rows; row += 1) {
      for (let index = 0; index < count; index += 1) {
        const progress = index / (count - 1);
        const x = size * (0.16 + progress * 0.68);
        const base = size * (0.28 + row / Math.max(1, rows - 1) * 0.44);
        const wave = Math.sin(progress * Math.PI * 2.4 - time * 2.1 + row * 0.42) * size * 0.035;
        const depth = Math.sin(progress * Math.PI);
        this.dot(context, x, base + wave, (0.6 + depth * 0.55) * scale, ink, 0.3 + depth * 0.62);
      }
    }
  }

  private drawShape(context: CanvasRenderingContext2D, size: number, time: number, ink: number): void {
    const center = size / 2;
    const scale = size / 64;
    const count = size <= 24 ? 14 : size < 48 ? 24 : 38;
    const phase = (Math.sin(time * 0.85) + 1) / 2;
    for (let index = 0; index < count; index += 1) {
      const angle = index / count * Math.PI * 2;
      const circle = size * 0.31;
      const square = size * 0.25 / Math.max(Math.abs(Math.cos(angle)), Math.abs(Math.sin(angle)));
      const radius = circle * (1 - phase) + square * phase;
      this.dot(context, center + Math.cos(angle + time * 0.12) * radius, center + Math.sin(angle + time * 0.12) * radius, 0.85 * scale, ink, 0.42 + 0.48 * Math.sin(angle * 2 + time) ** 2);
    }
  }
}

const visibility = new IntersectionObserver((entries) => {
  for (const entry of entries) instances.get(entry.target as HTMLElement)?.setVisible(entry.isIntersecting);
});

const mount = (scope: ParentNode): void => {
  const nodes = scope instanceof HTMLElement && scope.matches(ORB_SELECTOR)
    ? [scope, ...scope.querySelectorAll<HTMLElement>(ORB_SELECTOR)]
    : [...scope.querySelectorAll<HTMLElement>(ORB_SELECTOR)];
  for (const node of nodes) {
    if (!instances.has(node)) instances.set(node, new NativeThinkingOrb(node));
  }
};

const frame = (now: number): void => {
  if (!document.hidden) instances.forEach((orb) => orb.draw(now));
  window.requestAnimationFrame(frame);
};

const start = (): void => {
  mount(document);
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) if (node instanceof HTMLElement) mount(node);
  }).observe(document.documentElement, { childList: true, subtree: true });
  window.requestAnimationFrame(frame);
};

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
else start();
