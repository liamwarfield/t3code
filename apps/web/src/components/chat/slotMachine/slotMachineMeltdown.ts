type ParticleKind = "smoke" | "fire" | "spark" | "debris";

interface Particle {
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  grow: number;
  spin: number;
  age: number;
  life: number;
}

const MAX_PARTICLES = 520;

/**
 * Smoke and fire pouring out of an abused cabinet. The loop only runs while something is
 * emitting or still on screen, so an idle machine never repaints.
 */
export class SlotMeltdown {
  private particles: Particle[] = [];
  private intensity = 0;
  private smoulderUntil = 0;
  private frame = 0;
  private last = 0;
  private origin = { x: 0, y: 0, width: 0, height: 0 };

  constructor(private readonly canvas: HTMLCanvasElement) {}

  /** 0 stops emitting; 1 is a full blaze. */
  setIntensity(intensity: number, cabinet: DOMRect | undefined) {
    this.intensity = Math.max(0, Math.min(1, intensity));
    this.measure(cabinet);
    this.start();
  }

  explode(cabinet: DOMRect | undefined) {
    this.measure(cabinet);
    const { x, y, width, height } = this.origin;
    const cx = x + width / 2;
    const cy = y + height * 0.45;
    for (let index = 0; index < 90; index++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 4 + Math.random() * 16;
      this.push({
        kind: index % 3 === 0 ? "debris" : "spark",
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 6,
        r: index % 3 === 0 ? 6 + Math.random() * 14 : 2 + Math.random() * 3,
        grow: 0,
        spin: Math.random() * 6,
        age: 0,
        life: 70 + Math.random() * 60,
      });
    }
    for (let index = 0; index < 70; index++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1 + Math.random() * 7;
      this.push({
        kind: index % 2 === 0 ? "fire" : "smoke",
        x: cx + (Math.random() - 0.5) * width * 0.6,
        y: cy + (Math.random() - 0.5) * height * 0.5,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 2,
        r: 30 + Math.random() * 60,
        grow: 0.6 + Math.random() * 0.8,
        spin: 0,
        age: 0,
        life: 50 + Math.random() * 70,
      });
    }
    // The wreck smoulders for a while, then goes still; nothing animates forever.
    this.smoulderUntil = performance.now() + 8000;
    this.intensity = 0;
    this.start();
  }

  clear() {
    this.particles = [];
    this.intensity = 0;
    this.smoulderUntil = 0;
    this.canvas.getContext("2d")?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.particles = [];
  }

  private measure(cabinet: DOMRect | undefined) {
    const bounds = this.canvas.getBoundingClientRect();
    if (this.canvas.width !== Math.round(bounds.width)) {
      this.canvas.width = Math.round(bounds.width);
      this.canvas.height = Math.round(bounds.height);
    }
    if (!cabinet || bounds.width === 0) return;
    const scale = this.canvas.width / bounds.width;
    this.origin = {
      x: (cabinet.left - bounds.left) * scale,
      y: (cabinet.top - bounds.top) * scale,
      width: cabinet.width * scale,
      height: cabinet.height * scale,
    };
  }

  private start() {
    if (!this.frame) {
      this.last = 0;
      this.frame = requestAnimationFrame(this.step);
    }
  }

  private push(particle: Particle) {
    if (this.particles.length < MAX_PARTICLES) this.particles.push(particle);
  }

  private emit(dt: number, smouldering: boolean) {
    const { x, y, width, height } = this.origin;
    const heat = smouldering ? 0.12 : this.intensity;
    const smoke = heat * 3.2 * dt;
    for (let index = 0; index < smoke; index++) {
      if (Math.random() > smoke - index) break;
      // Smoke leaks from the marquee seam, the coin tray and the lever housing.
      const vent = Math.random();
      this.push({
        kind: "smoke",
        x:
          vent < 0.5
            ? x + width * (0.15 + Math.random() * 0.7)
            : vent < 0.8
              ? x + width * (0.3 + Math.random() * 0.4)
              : x + width * 0.98,
        y: vent < 0.5 ? y + 12 : vent < 0.8 ? y + height - 10 : y + height * 0.45,
        vx: (Math.random() - 0.5) * 1.2,
        vy: -(0.8 + Math.random() * 1.6) * (0.6 + heat),
        r: 10 + Math.random() * 14,
        grow: 0.35 + Math.random() * 0.4,
        spin: 0,
        age: 0,
        life: 70 + Math.random() * 60,
      });
    }
    if (smouldering || heat < 0.35) return;
    const fire = (heat - 0.35) * 5 * dt;
    for (let index = 0; index < fire; index++) {
      if (Math.random() > fire - index) break;
      const side = Math.random();
      this.push({
        kind: "fire",
        x: side < 0.6 ? x + width * Math.random() : side < 0.8 ? x : x + width,
        y: side < 0.6 ? y + 6 : y + height * (0.2 + Math.random() * 0.6),
        vx: (Math.random() - 0.5) * 1.6,
        vy: -(1.5 + Math.random() * 2.5),
        r: 10 + Math.random() * 18 * heat,
        grow: -0.12,
        spin: 0,
        age: 0,
        life: 24 + Math.random() * 22,
      });
      if (Math.random() < heat * 0.5) {
        this.push({
          kind: "spark",
          x: x + width * Math.random(),
          y: y + 8,
          vx: (Math.random() - 0.5) * 6,
          vy: -(4 + Math.random() * 6),
          r: 1.5 + Math.random() * 2,
          grow: 0,
          spin: 0,
          age: 0,
          life: 30 + Math.random() * 30,
        });
      }
    }
  }

  private step = (now: number) => {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const dt = this.last ? Math.min(100, now - this.last) / 16.67 : 1;
    this.last = now;
    const smouldering = now < this.smoulderUntil;
    this.emit(dt, smouldering);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.particles = this.particles.filter((particle) => particle.age < particle.life);
    for (const particle of this.particles) {
      particle.age += dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.r = Math.max(0.5, particle.r + particle.grow * dt);
      const fade = 1 - particle.age / particle.life;
      if (particle.kind === "smoke") {
        particle.vx *= 0.99;
        const gradient = ctx.createRadialGradient(
          particle.x,
          particle.y,
          0,
          particle.x,
          particle.y,
          particle.r,
        );
        gradient.addColorStop(0, `rgba(70, 66, 64, ${0.42 * fade})`);
        gradient.addColorStop(1, "rgba(40, 38, 38, 0)");
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.r, 0, Math.PI * 2);
        ctx.fill();
      } else if (particle.kind === "fire") {
        const gradient = ctx.createRadialGradient(
          particle.x,
          particle.y,
          0,
          particle.x,
          particle.y,
          particle.r,
        );
        gradient.addColorStop(0, `rgba(255, 244, 190, ${0.9 * fade})`);
        gradient.addColorStop(0.4, `rgba(255, 140, 30, ${0.7 * fade})`);
        gradient.addColorStop(1, "rgba(200, 30, 0, 0)");
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.r, 0, Math.PI * 2);
        ctx.fill();
      } else if (particle.kind === "spark") {
        particle.vy += 0.35 * dt;
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = `rgba(255, 210, 90, ${fade})`;
        ctx.fillRect(particle.x, particle.y, particle.r, particle.r);
      } else {
        particle.vy += 0.5 * dt;
        particle.spin += 0.2 * dt;
        ctx.globalCompositeOperation = "source-over";
        ctx.save();
        ctx.translate(particle.x, particle.y);
        ctx.rotate(particle.spin);
        ctx.fillStyle = `rgba(48, 34, 30, ${Math.min(1, fade * 1.6)})`;
        ctx.fillRect(-particle.r / 2, -particle.r / 4, particle.r, particle.r / 2);
        ctx.restore();
      }
    }
    ctx.globalCompositeOperation = "source-over";
    const emitting = this.intensity > 0 || smouldering;
    this.frame = emitting || this.particles.length > 0 ? requestAnimationFrame(this.step) : 0;
  };
}
