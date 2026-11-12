import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal, flushSync } from "react-dom";

import type { ProviderInstanceEntry } from "../../../providerInstances";
import { ProviderInstanceIcon } from "../ProviderInstanceIcon";
import { createSlotAudio, type SlotAudio } from "./slotMachineAudio";
import {
  PAYOUT_BY_TIER,
  SPIN_COST,
  START_CREDITS,
  buildSlotProviders,
  isJesterDriver,
  isJesterModel,
  rollSlotOutcome,
  slotHeadline,
  slotQuip,
  slotStamp,
  slotComboKey,
  slotComboKeys,
  RUMORED_MODEL_NAMES,
  type PayoutTier,
  type SlotOutcome,
  type SlotProvider,
} from "./slotMachineLogic";
import "./SlotMachine.css";

export interface SlotCollectSelection {
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly effortOptionId: string | null;
  readonly effortValue: string | null;
}

interface ReelSymbol {
  readonly key: string;
  readonly label: string;
  readonly caption: string;
  readonly driverKind: ProviderDriverKind;
  readonly level: number;
  readonly jackpot: boolean;
  readonly jester: boolean;
  readonly dim: boolean;
  readonly wild?: boolean;
}

interface ReelPlan {
  readonly start: number;
  readonly end: number;
  readonly mainDuration: number;
  readonly crawl: ReadonlyArray<number>;
  /** Near-miss: the jackpot symbol sits on the payline, hangs, then slips one row past. */
  readonly slip?: boolean;
}

const ROW = 92;
const WINDUP = 160;
const BOUNCE = 0.32;
const STOP_SETTLE = 280;
const LANDING_BEAT_MS = 240;
const JACKPOT_BLACKOUT_MS = 650;
const HEAT_MAX = 3;
const RATE_LIMIT_AT_MS = 650;
const RATE_LIMIT_FREEZE_MS = 1200;
const CODEX_STALL_MS = 1400;
const TAKEOVER_TAIL_MS = 700;
const REVEAL_STEP_MS = 120;
const TIER_HIT_STOP_MS = 160;
const LOCK_HOLD_MS = 760;
const UPGRADE_IN_TAKEOVER_MS = 1600;
const TIER_THRESHOLDS = [150_000, 280_000, 800_000];
// The takeover headline climbs with the count; the last threshold reveals the real word.
const GIANT_WORDS = ["BIG WIN", "MEGA WIN"];
const DEX_COMPLETE_BONUS = 100_000;
const MARQUEE_LINES = [
  "vibes-based model selection · est. 2026",
  "now with 2× usage limits* (*for 2 hours)",
  "SWE-bench verified™ (by us)",
  "slop detected · proceeding anyway",
  "results not reproducible · odds not audited",
];
const STATE_KEY = "t3code:slot-machine-state";
const PERKS = [
  "+1 retry (no refunds)",
  "context ×2 (until compaction)",
  "rate-limit immunity (expired)",
  "free compute weekend (terms apply)",
  "priority queue (position 4,812)",
  "early access (waitlist)",
];
// The roll climbs this ladder like VS beam colours, settling on the real pre-upgrade rarity.
const ROLL_LADDER = ["UNCOMMON", "RARE", "EPIC", "LEGENDARY"] as const;
const ROLL_TICKS = 5;
const rollTargetStep = (level: number) => Math.max(1, Math.min(3, level - 1));
const rollRarityStep = (tick: number, target: number) =>
  Math.min(target, Math.floor((tick * (target + 1)) / (ROLL_TICKS + 1)));

const RARITY_BELOW: Record<string, string> = {
  RARE: "UNCOMMON",
  EPIC: "RARE",
  LEGENDARY: "EPIC",
  MYTHIC: "LEGENDARY",
};

interface PersistedSlotState {
  readonly tokens: number;
  readonly heat: number;
  readonly dex: ReadonlyArray<string>;
  readonly pool?: number;
}

const POOL_SEED = 2_500_000;
const POOL_SHARE = 0.08;

/** Tokens, heat and the collection survive closing the machine; it's a machine, not a modal. */
function loadSlotState(): PersistedSlotState {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(STATE_KEY) ?? "null");
    if (parsed && typeof parsed.tokens === "number" && Array.isArray(parsed.dex)) {
      return {
        tokens: parsed.tokens,
        heat: typeof parsed.heat === "number" ? parsed.heat : 0,
        dex: parsed.dex.filter((key: unknown) => typeof key === "string"),
        pool: typeof parsed.pool === "number" ? parsed.pool : POOL_SEED,
      };
    }
  } catch {
    // A corrupt save just starts a fresh machine.
  }
  return { tokens: START_CREDITS, heat: 0, dex: [], pool: POOL_SEED };
}

function saveSlotState(state: PersistedSlotState) {
  globalThis.localStorage?.setItem(STATE_KEY, JSON.stringify(state));
}
const TIER_LEVEL: Record<PayoutTier, number> = { slop: 0, win: 1, big: 2, mega: 3, jackpot: 4 };
// A WIN never beats the pull cost, so it only dribbles; real profit gets the fountain.
const COINS_BY_LEVEL = [0, 6, 80, 160, 320];
// A WIN is a loss in disguise: it snaps to its value so you're back at the lever fast.
const COUNT_MS_BY_LEVEL = [450, 450, 1500, 2000, 2600];
const MUTE_KEY = "t3code:slot-machine-muted";

const easeOutCubic = (u: number) => 1 - (1 - u) ** 3;
/** Eases out but keeps some speed at the end, so the crawl that follows feels continuous. */
const easeOutKeepSpeed = (u: number) => (1 - (1 - u * 0.82) ** 3) / (1 - 0.18 ** 3);
const SLIP_HOLD = 0.62;
const easeOutBack = (u: number) => {
  const c1 = 2.4;
  return 1 + (c1 + 1) * (u - 1) ** 3 + c1 * (u - 1) ** 2;
};

function reelPosition(plan: ReelPlan, t: number): { p: number; done: boolean; phase: number } {
  if (t < WINDUP)
    return { p: plan.start - 0.45 * Math.sin((Math.PI * t) / WINDUP), done: false, phase: -1 };
  const mainEnd = plan.end - plan.crawl.length + (plan.crawl.length === 0 ? BOUNCE : 0);
  const tm = t - WINDUP;
  if (tm < plan.mainDuration) {
    const u = tm / plan.mainDuration;
    const ease = plan.crawl.length > 0 ? easeOutKeepSpeed(u) : easeOutCubic(u);
    return { p: plan.start + (mainEnd - plan.start) * ease, done: false, phase: 0 };
  }
  let tc = tm - plan.mainDuration;
  if (plan.crawl.length === 0) {
    if (tc >= STOP_SETTLE) return { p: plan.end, done: true, phase: 1 };
    const v = tc / STOP_SETTLE;
    return {
      p: plan.end + BOUNCE * Math.exp(-5 * v) * Math.cos(2.5 * Math.PI * v),
      done: false,
      phase: 1,
    };
  }
  const base = plan.end - plan.crawl.length;
  for (let index = 0; index < plan.crawl.length; index++) {
    const duration = plan.crawl[index]!;
    if (tc < duration) {
      const u = tc / duration;
      const last = index === plan.crawl.length - 1;
      // The hang reads as "it landed!", then a sudden slip makes it obvious it didn't.
      const eased =
        plan.slip && last
          ? u < SLIP_HOLD
            ? 0.04 * Math.sin((u / SLIP_HOLD) * Math.PI)
            : easeOutBack((u - SLIP_HOLD) / (1 - SLIP_HOLD))
          : easeOutBack(u);
      return { p: base + index + eased, done: false, phase: 2 + index };
    }
    tc -= duration;
  }
  return { p: plan.end, done: true, phase: 2 + plan.crawl.length };
}

const pick = <T,>(items: ReadonlyArray<T>): T => items[Math.floor(Math.random() * items.length)]!;

function providerSymbol(provider: SlotProvider): ReelSymbol {
  return {
    key: provider.driverKind,
    label: provider.displayName,
    caption: "",
    driverKind: provider.driverKind,
    level: 0,
    jackpot: false,
    jester: isJesterDriver(provider.driverKind),
    dim: provider.instanceId === null,
  };
}

function modelSymbol(provider: SlotProvider, model: SlotProvider["models"][number]): ReelSymbol {
  return {
    key: `${provider.driverKind}:${model.slug}`,
    label: model.name,
    caption: provider.displayName,
    driverKind: provider.driverKind,
    level: model.tier,
    jackpot: model.tier === 3,
    jester: isJesterModel(provider.driverKind, model),
    dim: false,
  };
}

function effortSymbol(label: string, tier: number, driverKind: ProviderDriverKind): ReelSymbol {
  return {
    key: label,
    label,
    caption: "effort",
    driverKind,
    level: tier + 1,
    jackpot: tier === 3,
    jester: false,
    dim: false,
  };
}

function buildStrips(
  providers: ReadonlyArray<SlotProvider>,
  outcome: SlotOutcome,
  previous: ReadonlyArray<ReadonlyArray<ReelSymbol>>,
  previousCenters: ReadonlyArray<number>,
): ReelSymbol[][] {
  const lengths = [20, 30, 40];
  const allModels = providers.flatMap((provider) =>
    provider.models.map((model) => modelSymbol(provider, model)),
  );
  const allEfforts = providers.flatMap((provider) =>
    provider.models.flatMap((model) =>
      model.efforts.map((effort) => effortSymbol(effort.label, effort.tier, provider.driverKind)),
    ),
  );
  const rumored = RUMORED_MODEL_NAMES.map((name) => ({
    ...modelSymbol(outcome.provider, outcome.model),
    key: `rumor:${name}`,
    label: name,
    caption: "rumored",
    level: 3,
    jackpot: false,
  }));
  // Installed providers fill more of the strip so not-installed tiles don't dominate it.
  const providerPool = providers.flatMap((provider) =>
    provider.instanceId
      ? [providerSymbol(provider), providerSymbol(provider)]
      : [providerSymbol(provider)],
  );
  const pools = [providerPool, [...allModels, ...rumored], allEfforts];
  const wild = (reel: number): ReelSymbol => ({
    key: `agi:${reel}`,
    label: "AGI",
    caption: "wild",
    driverKind: outcome.provider.driverKind,
    level: 3,
    jackpot: true,
    jester: false,
    dim: false,
    wild: true,
  });
  const finals: ReelSymbol[] = outcome.agi
    ? [wild(0), wild(1), wild(2)]
    : [
        providerSymbol(outcome.provider),
        modelSymbol(outcome.provider, outcome.model),
        effortSymbol(outcome.effort.label, outcome.effort.tier, outcome.provider.driverKind),
      ];
  return [0, 1, 2].map((reel) => {
    const prior = previous[reel] ?? [];
    const center = previousCenters[reel] ?? 1;
    const strip: ReelSymbol[] =
      prior.length > 0 ? prior.slice(center - 1, center + 2) : [pick(pools[reel]!)];
    // Neighbours never repeat: a strip of LOW, LOW, LOW reads as a fake reel.
    const fresh = (avoid: ReadonlyArray<string | undefined>) => {
      let next = pick(pools[reel]!);
      for (let attempt = 0; attempt < 8 && avoid.includes(next.label); attempt++) {
        next = pick(pools[reel]!);
      }
      return next;
    };
    const push = (symbol: ReelSymbol | null) => {
      if (!symbol) {
        strip.push(fresh([strip.at(-1)?.label]));
        return;
      }
      if (strip.length > 1 && strip.at(-1)?.label === symbol.label) {
        strip[strip.length - 1] = fresh([strip.at(-2)?.label, symbol.label]);
      }
      strip.push(symbol);
    };
    while (strip.length < 3) push(null);
    for (let index = 0; index < lengths[reel]!; index++) push(null);
    const tease =
      outcome.nearMissReel === reel
        ? reel === 2 && outcome.teaseEffort
          ? effortSymbol(
              outcome.teaseEffort.label,
              outcome.teaseEffort.tier,
              outcome.provider.driverKind,
            )
          : reel === 1 && outcome.teaseModel
            ? modelSymbol(outcome.provider, outcome.teaseModel)
            : null
        : null;
    push(tease);
    push(finals[reel]!);
    push(null);
    return strip.map((symbol, index) => ({ ...symbol, key: `${reel}:${index}:${symbol.key}` }));
  });
}

function drawCoinSprite(hue: number, saturation: number): HTMLCanvasElement {
  const size = 64;
  const sprite = document.createElement("canvas");
  sprite.width = size;
  sprite.height = size;
  const ctx = sprite.getContext("2d")!;
  const center = size / 2;
  const face = ctx.createRadialGradient(center - 9, center - 11, 2, center, center, center);
  face.addColorStop(0, `hsl(${hue} ${saturation}% 92%)`);
  face.addColorStop(0.35, `hsl(${hue} ${saturation}% 62%)`);
  face.addColorStop(1, `hsl(${hue} ${saturation}% 34%)`);
  ctx.fillStyle = `hsl(${hue} ${saturation}% 26%)`;
  ctx.beginPath();
  ctx.arc(center, center, center - 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = face;
  ctx.beginPath();
  ctx.arc(center, center, center - 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = `hsl(${hue} ${saturation}% 80% / 0.8)`;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(center, center, center - 11, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = `hsl(${hue} ${saturation}% 30% / 0.75)`;
  ctx.font = "bold 26px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("T", center, center + 1);
  return sprite;
}

/** Coins fountain from behind the cabinet so they frame the result instead of covering it. */
class CoinShower {
  private particles: Array<{
    x: number;
    y: number;
    vx: number;
    vy: number;
    r: number;
    spin: number;
    spinRate: number;
    age: number;
    sprite: HTMLCanvasElement;
  }> = [];
  private frame = 0;
  private pending = 0;
  private surge = 0;
  private emitUntil = 0;
  private sprites: HTMLCanvasElement[] = [];
  private last = 0;
  private origin = { x: 0, y: 0, width: 0, height: 0 };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    /** The front layer erupts out of the payout tray, over the cabinet, then gets out of the way. */
    private readonly fromTray = false,
  ) {}

  burst(count: number, jester: boolean, durationMs: number, cabinet: DOMRect | undefined) {
    // Coins are small and fast; 1x pixels keep this huge canvas cheap to clear and redraw.
    const dpr = 1;
    const bounds = this.canvas.getBoundingClientRect();
    this.canvas.width = this.canvas.clientWidth * dpr;
    this.canvas.height = this.canvas.clientHeight * dpr;
    const scale = this.canvas.width / bounds.width;
    if (cabinet) {
      this.origin = {
        x: (cabinet.left - bounds.left) * scale,
        y: (cabinet.top - bounds.top) * scale,
        width: cabinet.width * scale,
        height: cabinet.height * scale,
      };
    }
    this.sprites = jester
      ? [drawCoinSprite(285, 80), drawCoinSprite(95, 85), drawCoinSprite(48, 95)]
      : [drawCoinSprite(45, 95), drawCoinSprite(40, 90)];
    // A third of the coins erupt on impact; the rest sustain the shower through the count.
    this.surge = Math.ceil(count * 0.35);
    this.pending += count - this.surge;
    this.emitUntil = performance.now() + durationMs;
    if (!this.frame) this.frame = requestAnimationFrame(this.step);
  }

  clear() {
    this.pending = 0;
    this.surge = 0;
    this.particles = [];
    this.canvas.getContext("2d")?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private step = (now: number) => {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    // Real elapsed time, so a slow frame never stretches the shower into slow motion.
    const dt = this.last ? Math.min(100, now - this.last) / 16.67 : 1;
    this.last = now;
    const { width, height } = this.canvas;
    const scale = width / this.canvas.clientWidth;
    const remaining = Math.max(1, this.emitUntil - now);
    const spawn =
      (this.pending > 0 ? Math.max(1, Math.ceil((this.pending * 16.67) / remaining)) : 0) +
      this.surge;
    this.pending += this.surge;
    this.surge = 0;
    const { x, y, width: cabinetWidth, height: cabinetHeight } = this.origin;
    for (let index = 0; index < spawn && this.pending > 0; index++) {
      this.pending--;
      // Alternate between the two shoulders of the cabinet and the top of the marquee.
      const lane = Math.random();
      const side = lane < 0.5 ? -1 : 1;
      const fromTop = lane > 0.8;
      if (this.fromTray) {
        this.particles.push({
          x: x + cabinetWidth * (0.5 + (Math.random() - 0.5) * 0.3),
          y: y + cabinetHeight - 24 * scale,
          // Strong sideways kick: the eruption clears the prize card within a few frames.
          vx: (Math.random() < 0.5 ? -1 : 1) * (12 + Math.random() * 14) * scale,
          vy: -(13 + Math.random() * 11) * scale,
          r: (11 + Math.random() * 7) * scale,
          spin: Math.random() * Math.PI * 2,
          spinRate: 0.15 + Math.random() * 0.25,
          age: 0,
          sprite: pick(this.sprites),
        });
        continue;
      }
      this.particles.push({
        x: fromTop
          ? x + cabinetWidth * (0.2 + Math.random() * 0.6)
          : x + cabinetWidth * (side < 0 ? 0.08 : 0.92),
        y: fromTop ? y + 20 * scale : y + cabinetHeight * (0.35 + Math.random() * 0.4),
        vx: fromTop ? (Math.random() - 0.5) * 14 * scale : side * (6 + Math.random() * 16) * scale,
        vy: -(fromTop ? 18 + Math.random() * 12 : 12 + Math.random() * 18) * scale,
        r: (6 + Math.random() ** 2 * 16) * scale,
        spin: Math.random() * Math.PI * 2,
        spinRate: 0.15 + Math.random() * 0.25,
        age: 0,
        sprite: pick(this.sprites),
      });
    }
    ctx.clearRect(0, 0, width, height);
    const gravity = 0.6 * scale;
    this.particles = this.particles.filter(
      (particle) => particle.y < height + 60 && particle.age < 180,
    );
    for (const particle of this.particles) {
      particle.vy += gravity * dt;
      particle.vx *= 0.996;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      // Coins hit the floor of the screen and hop once before sliding out, like a real spill.
      if (particle.y > height - particle.r && particle.vy > 0 && particle.age < 120) {
        particle.y = height - particle.r;
        particle.vy *= -0.42;
        particle.vx *= 0.7;
        particle.age = Math.max(particle.age, 120);
      }
      particle.spin += particle.spinRate * dt;
      particle.age += dt;
      const squash = Math.cos(particle.spin);
      const widthScale = Math.max(0.14, Math.abs(squash));
      ctx.save();
      ctx.translate(particle.x, particle.y);
      ctx.scale(widthScale, 1);
      ctx.drawImage(particle.sprite, -particle.r, -particle.r, particle.r * 2, particle.r * 2);
      // Edge-on flash: the coin catches the light as it turns.
      if (widthScale < 0.3) {
        ctx.fillStyle = "rgb(255 250 220 / 0.85)";
        ctx.fillRect(-particle.r * 0.25, -particle.r, particle.r * 0.5, particle.r * 2);
      }
      ctx.restore();
    }
    if (this.particles.length > 0 || this.pending > 0) {
      this.frame = requestAnimationFrame(this.step);
    } else {
      this.frame = 0;
      this.last = 0;
    }
  };

  dispose() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }
}

function formatTokens(value: number) {
  return Math.round(value).toLocaleString("en-US");
}

type Phase = "idle" | "spinning" | "result";

export default function SlotMachine(props: {
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly getModelDisabledReason?: (
    instanceId: ProviderInstanceId,
    model: string,
  ) => string | null;
  readonly onCollect: (selection: SlotCollectSelection) => void;
  readonly onClose: () => void;
}) {
  const providers = buildSlotProviders(props.instanceEntries);
  const [saved] = useState(loadSlotState);
  const [strips, setStrips] = useState<ReelSymbol[][]>(() => {
    const seed = rollSlotOutcome(providers);
    return buildStrips(providers, { ...seed, nearMissReel: null }, [], []).map((strip) =>
      strip.slice(-3),
    );
  });
  const [phase, setPhase] = useState<Phase>("idle");
  const [stopped, setStopped] = useState(3);
  const [hot, setHot] = useState(false);
  const [beam, setBeam] = useState(0);
  const [teasing, setTeasing] = useState(false);
  const [outcome, setOutcome] = useState<SlotOutcome | null>(null);
  const [credits, setCredits] = useState(saved.tokens);
  const [counting, setCounting] = useState(false);
  const [heat, setHeat] = useState(saved.heat);
  const [hotPull, setHotPull] = useState(false);
  const [dex, setDex] = useState<ReadonlyArray<string>>(saved.dex);
  const [discovered, setDiscovered] = useState(false);
  const [rateLimited, setRateLimited] = useState(false);
  const [trickling, setTrickling] = useState(false);
  const [rollIndex, setRollIndex] = useState(0);
  const [billedTokens, setBilledTokens] = useState(0);
  const [tell, setTell] = useState<string | null>(null);
  const [earnedShown, setEarnedShown] = useState(0);
  const [slammed, setSlammed] = useState(false);
  const [dexOpen, setDexOpen] = useState(false);
  const [firePull, setFirePull] = useState(false);
  // Some big wins deal one rarity low, then crack and re-deal the real one.
  const [rarityUpgrade, setRarityUpgrade] = useState(false);
  const [perkCount, setPerkCount] = useState(0);
  const [takeover, setTakeover] = useState(0);
  const [floatText, setFloatText] = useState("");
  const [freeSpin, setFreeSpin] = useState(false);
  const freeSpinRef = useRef(false);
  const [floatDelayMs, setFloatDelayMs] = useState(500);
  const [giantRarity, setGiantRarity] = useState("UNCOMMON");
  const [streakProtected, setStreakProtected] = useState(false);
  const [pullCount, setPullCount] = useState(0);
  const [hallucinating, setHallucinating] = useState(false);
  const [turbo, setTurbo] = useState(false);
  const [pile, setPile] = useState(0);
  const [pricingNotice, setPricingNotice] = useState(false);
  const [completedProvider, setCompletedProvider] = useState<string | null>(null);
  const dexRef = useRef(saved.dex);
  const poolRef = useRef(saved.pool ?? POOL_SEED);
  const [pool, setPool] = useState(saved.pool ?? POOL_SEED);
  const giantRef = useRef<HTMLSpanElement | null>(null);
  const giantWordRef = useRef<HTMLSpanElement | null>(null);
  // Spins run across rAF and timeout callbacks, so these read through refs, not render closures.
  const heatRef = useRef(saved.heat);
  const hotPullRef = useRef(false);
  const stripsRef = useRef(strips);
  const [muted, setMuted] = useState(() => globalThis.localStorage?.getItem(MUTE_KEY) === "1");
  const [raysKey, setRaysKey] = useState(0);
  const [raysVisible, setRaysVisible] = useState(false);
  const [upgraded, setUpgraded] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [blackout, setBlackout] = useState(false);
  // 1–3 pop the payline symbols one by one, 4 deals the loot card.
  const [revealStep, setRevealStep] = useState(0);
  const [netLoss, setNetLoss] = useState<number | null>(null);
  const [limitSince, setLimitSince] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [waitedOut, setWaitedOut] = useState(false);
  const hurryRef = useRef(false);
  const turboRef = useRef(false);
  const skipCountRef = useRef<(() => void) | null>(null);
  const revealTimers = useRef<number[]>([]);
  const winMeterRef = useRef<HTMLDivElement>(null);

  const audioRef = useRef<SlotAudio | null>(null);
  const stripRefs = useRef<Array<HTMLDivElement | null>>([]);
  const reelRefs = useRef<Array<HTMLDivElement | null>>([]);
  const centersRef = useRef<number[]>([1, 1, 1]);
  const frameRef = useRef(0);
  const beatRef = useRef(0);
  const leverRef = useRef<HTMLDivElement>(null);
  const leverProgress = useRef(0);
  const leverFrame = useRef(0);
  const dragRef = useRef<{ startY: number; moved: boolean } | null>(null);
  const creditsValue = useRef(saved.tokens);
  const creditsRef = useRef<HTMLSpanElement>(null);
  const winRef = useRef<HTMLSpanElement>(null);
  const coinsRef = useRef<CoinShower | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frontCanvasRef = useRef<HTMLCanvasElement>(null);
  const frontCoinsRef = useRef<CoinShower | null>(null);
  const flashRef = useRef<HTMLDivElement>(null);
  const cabinetRef = useRef<HTMLDivElement>(null);
  const spinningRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const audio = () => {
    audioRef.current ??= createSlotAudio();
    audioRef.current.resume();
    audioRef.current.setMuted(muted);
    return audioRef.current;
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the AudioContext, rAF loops and canvas, which outlive renders.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) coinsRef.current = new CoinShower(canvas);
    if (frontCanvasRef.current)
      frontCoinsRef.current = new CoinShower(frontCanvasRef.current, true);
    if (creditsRef.current) creditsRef.current.textContent = formatTokens(creditsValue.current);
    if (winRef.current) winRef.current.textContent = "0";
    rootRef.current?.focus();
    return () => {
      cancelAnimationFrame(frameRef.current);
      cancelAnimationFrame(leverFrame.current);
      window.clearTimeout(beatRef.current);
      for (const timer of revealTimers.current) window.clearTimeout(timer);
      coinsRef.current?.dispose();
      frontCoinsRef.current?.dispose();
      audioRef.current?.dispose();
      audioRef.current = null;
    };
  }, []);

  const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const installed = (result: SlotOutcome) =>
    result.provider.instanceId !== null &&
    (props.getModelDisabledReason?.(result.provider.instanceId, result.model.slug) ?? null) ===
      null;

  const setLever = (progress: number) => {
    leverProgress.current = progress;
    leverRef.current?.style.setProperty("--pull", progress.toFixed(3));
  };

  const springLeverHome = () => {
    cancelAnimationFrame(leverFrame.current);
    let velocity = 0;
    const step = () => {
      const position = leverProgress.current;
      velocity = (velocity - position * 0.16) * 0.78;
      const next = position + velocity;
      if (Math.abs(next) < 0.002 && Math.abs(velocity) < 0.002) {
        setLever(0);
        return;
      }
      setLever(Math.max(-0.08, next));
      leverFrame.current = requestAnimationFrame(step);
    };
    leverFrame.current = requestAnimationFrame(step);
  };

  const showCredits = (value: number, win: number) => {
    if (creditsRef.current) creditsRef.current.textContent = formatTokens(value);
    if (winRef.current) winRef.current.textContent = formatTokens(win);
  };

  /** Rolls the meters; `peak` overshoots first and then corrects down, for comedic payouts. */
  const rollCounter = (input: {
    from: number;
    to: number;
    peak: number;
    durationMs: number;
    onTurn?: () => void;
    onDone: () => void;
    showWin?: boolean;
    /** Where the WIN meter counts from; bonus climbs keep counting the whole pull's winnings. */
    winFrom?: number;
    /** Also drives the takeover's giant number, so it and the meters never disagree. */
    giant?: boolean;
    /** Freezes the count partway, for payouts that arrive "in the coming weeks". */
    pause?: { at: number; ms: number; onChange: (paused: boolean) => void };
  }) => {
    const { from, to, peak, durationMs } = input;
    const overshoot = peak !== to;
    const riseMs = overshoot ? durationMs * 0.7 : durationMs;
    let start: number | null = null;
    let turned = false;
    let skipped = false;
    let nextPulse = 0.25;
    // A bonus climb starts above tiers already crossed; only new thresholds get a hit.
    let nextTier = TIER_THRESHOLDS.filter(
      (threshold) => from - (input.winFrom ?? from) >= threshold - 500,
    ).length;
    skipCountRef.current = () => {
      skipped = true;
    };
    let pauseUntil: number | null = null;
    let pauseDone = false;
    let holdUntil = 0;
    const step = (time: number) => {
      start ??= time;
      // A tier hit-stop holds the shown value; `start` already moved forward by the hold.
      if (time < holdUntil && !skipped) {
        frameRef.current = requestAnimationFrame(step);
        return;
      }
      if (input.pause && !pauseDone && !skipped && (time - start) / durationMs >= input.pause.at) {
        if (pauseUntil === null) {
          pauseUntil = time + input.pause.ms;
          input.pause.onChange(true);
        }
        if (time < pauseUntil) {
          frameRef.current = requestAnimationFrame(step);
          return;
        }
        start += input.pause.ms;
        pauseDone = true;
        input.pause.onChange(false);
      }
      const elapsed = skipped ? durationMs : time - start;
      if (input.showWin !== false && elapsed / durationMs >= nextPulse && nextPulse < 1) {
        nextPulse += 0.25;
        pulseWinMeter(1.18);
      }
      let value: number;
      if (elapsed < riseMs) {
        const u = elapsed / riseMs;
        // Slow start, fast middle, slow finish: the chest-counter rhythm.
        const eased = u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2;
        value = from + (peak - from) * eased;
        audioRef.current?.countTick(u);
      } else {
        if (!turned && overshoot) {
          turned = true;
          input.onTurn?.();
        }
        const u = Math.min(1, (elapsed - riseMs) / Math.max(1, durationMs - riseMs));
        value = peak + (to - peak) * easeOutCubic(u);
      }
      showCredits(value, input.showWin === false ? 0 : value - (input.winFrom ?? from));
      if (input.giant && giantRef.current) {
        const won = value - (input.winFrom ?? from);
        giantRef.current.textContent = `+${formatTokens(Math.max(0, won))}`;
        // Crossing each paytable tier mid-count punches the number: BIG… MEGA… JACKPOT.
        while (
          nextTier < TIER_THRESHOLDS.length &&
          Math.round(won) >= TIER_THRESHOLDS[nextTier]! - 500
        ) {
          nextTier++;
          audioRef.current?.revealPop(Math.min(3, nextTier));
          // Each tier crossing is its own hit: flash, a shake that grows, a sub drop, a coin spurt.
          audioRef.current?.subBoom(Math.min(4, nextTier + 1));
          // Only JACKPOT breaks out of the lower panel and swallows the reels: a different shape, not more glow.
          if (nextTier >= TIER_THRESHOLDS.length)
            giantRef.current.parentElement?.setAttribute("data-slot-broken-out", "");
          // MEGA and JACKPOT crossings freeze the count for a beat and kick the whole cabinet.
          if (nextTier >= 2 && start !== null) {
            start += TIER_HIT_STOP_MS;
            holdUntil = time + TIER_HIT_STOP_MS;
            cabinetRef.current?.animate([{ scale: "1" }, { scale: "1.04" }, { scale: "1" }], {
              duration: 260,
              easing: "cubic-bezier(0.2, 1.6, 0.4, 1)",
            });
          }
          audioRef.current?.holdPayout(true);
          window.setTimeout(() => audioRef.current?.holdPayout(false), 140);
          flash(0.08 + nextTier * 0.04);
          shake(4 + nextTier * 4, 220);
          coinsRef.current?.burst(
            12 * nextTier,
            false,
            300,
            cabinetRef.current?.getBoundingClientRect(),
          );
          setGiantRarity(ROLL_LADDER[Math.min(nextTier, ROLL_LADDER.length - 1)]!);
          const word = giantWordRef.current;
          if (word) {
            word.textContent =
              nextTier >= TIER_THRESHOLDS.length
                ? (word.dataset.slotFinal ?? "JACKPOT")
                : (GIANT_WORDS[nextTier - 1] ?? word.textContent);
            word.animate([{ transform: "scale(1.5)" }, { transform: "scale(1)" }], {
              duration: 300,
              easing: "cubic-bezier(0.2, 1.8, 0.4, 1)",
            });
          }
          giantRef.current.animate([{ transform: "scale(1.22)" }, { transform: "scale(1)" }], {
            duration: 260,
            easing: "cubic-bezier(0.2, 1.8, 0.4, 1)",
          });
        }
      }
      if (elapsed < durationMs) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        skipCountRef.current = null;
        showCredits(to, input.showWin === false ? 0 : to - (input.winFrom ?? from));
        if (input.showWin !== false) pulseWinMeter(1.18);
        input.onDone();
      }
    };
    frameRef.current = requestAnimationFrame(step);
  };

  const pulseWinMeter = (scale: number) => {
    if (reduceMotion()) return;
    winMeterRef.current?.animate(
      [
        { transform: `scale(${scale})`, filter: "brightness(1.8)" },
        { transform: "scale(1)", filter: "brightness(1)" },
      ],
      { duration: scale > 1.3 ? 420 : 220, easing: "cubic-bezier(0.2, 1.6, 0.4, 1)" },
    );
  };

  const clearRevealTimers = () => {
    for (const timer of revealTimers.current) window.clearTimeout(timer);
    revealTimers.current = [];
  };

  /** The chest beat: each payline symbol pops forward in turn, then the loot card is dealt. */
  const runReveal = (level: number, perks: number, offsetMs: number) => {
    clearRevealTimers();
    if (level < 2) return;
    const cardAt = offsetMs + 3 * REVEAL_STEP_MS + 150;
    const perksAt = cardAt + 700;
    // The VS item roll: candidate cards flicker past, slowing down, before the real card lands.
    const rollDelays = [90, 110, 140, 180, 230];
    let rollAt = cardAt - rollDelays.reduce((sum, delay) => sum + delay, 0);
    rollDelays.forEach((delay, index) => {
      revealTimers.current.push(
        window.setTimeout(() => {
          setRollIndex(index + 1);
          audioRef.current?.tick(1 - index / rollDelays.length);
          const step = rollRarityStep(index + 1, rollTargetStep(level));
          if (step > rollRarityStep(index, rollTargetStep(level))) audioRef.current?.heatPip(step);
        }, rollAt),
      );
      rollAt += delay;
    });
    for (let index = 0; index < perks; index++) {
      revealTimers.current.push(window.setTimeout(() => popWithDuck(index), perksAt + index * 320));
    }
    [0, 1, 2, 3].forEach((index) => {
      revealTimers.current.push(
        window.setTimeout(
          () => {
            setRevealStep((step) => Math.max(step, index + 1));
            popWithDuck(index);
            shake(index === 3 ? 9 : 4, index === 3 ? 420 : 220);
            if (index === 3) {
              flash(0.15);
              audioRef.current?.subBoom(2);
            }
          },
          offsetMs + index * REVEAL_STEP_MS + (index === 3 ? 150 : 0),
        ),
      );
    });
  };

  /** The takeover lock: a held breath of silence, then the number slams with a sub-boom. */
  const lockGiant = () => {
    audioRef.current?.holdPayout(true);
    revealTimers.current.push(
      window.setTimeout(() => {
        audioRef.current?.holdPayout(false);
        audioRef.current?.subBoom(4);
        audioRef.current?.kaching();
        shake(16, 420);
        giantRef.current?.animate([{ transform: "scale(1.45)" }, { transform: "scale(1)" }], {
          duration: 380,
          easing: "cubic-bezier(0.2, 1.8, 0.4, 1)",
        });
      }, 320),
    );
  };

  /** Each reveal accent briefly ducks the payout band so it cuts through. */
  const popWithDuck = (index: number) => {
    audioRef.current?.holdPayout(true);
    audioRef.current?.revealPop(index);
    revealTimers.current.push(window.setTimeout(() => audioRef.current?.holdPayout(false), 220));
  };

  const flash = (opacity: number) => {
    if (reduceMotion()) return;
    flashRef.current?.animate([{ opacity }, { opacity: 0 }], {
      duration: 320,
      easing: "ease-out",
    });
  };

  const shake = (amplitude: number, durationMs: number) => {
    if (reduceMotion()) return;
    cabinetRef.current?.animate(
      [0, -1, 1, -0.8, 0.7, -0.5, 0.35, -0.2, 0].map((sign) => ({
        transform: `translate(${sign * amplitude}px, ${-sign * amplitude * 0.4}px) rotate(${sign * amplitude * 0.04}deg)`,
      })),
      { duration: durationMs, easing: "ease-out" },
    );
  };

  const impactReel = (reel: number) => {
    rootRef.current
      ?.querySelector("[data-slot-payline]")
      ?.animate([{ filter: "brightness(2.4)" }, { filter: "brightness(1)" }], {
        duration: 240,
        easing: "ease-out",
      });
    reelRefs.current[reel]?.animate([{ filter: "brightness(1.9)" }, { filter: "brightness(1)" }], {
      duration: 260,
      easing: "ease-out",
    });
    if (reduceMotion()) return;
    cabinetRef.current?.animate(
      [{ transform: "translateY(5px)" }, { transform: "translateY(0)" }],
      { duration: 160, easing: "ease-out" },
    );
  };

  const payoutEffects = (input: {
    result: SlotOutcome;
    before: number;
    after: number;
    wasHot: boolean;
    canCollect: boolean;
    reachedHotStreak: boolean;
    discovered: boolean;
    heatRose: boolean;
    perks: number;
    baseAfter: number;
    bonus: number;
    pricingCut: number;
    completeBonus: number;
  }) => {
    const { result, before, after, wasHot, canCollect, baseAfter, bonus, pricingCut } = input;
    const sound = audioRef.current;
    const level = canCollect ? TIER_LEVEL[result.tier] : 0;
    const multiplier = wasHot ? 2 : 1;
    const comedic = result.jester || (canCollect && result.benchmaxxed) || pricingCut > 0;
    // Gemini always "hallucinates" a big number first, even when the spin is only a refund.
    const peak =
      pricingCut > 0
        ? baseAfter + pricingCut
        : comedic
          ? before + result.payout * multiplier * (result.jester ? 1 : 2)
          : baseAfter;
    // Comedic counts get room to visibly drain back down, so the correction reads as a gag.
    let durationMs = COUNT_MS_BY_LEVEL[level]! + (comedic ? 1600 : 0);
    setRevealed(true);
    // Jackpots take over the screen with one giant number before the card is dealt.
    // The takeover count, its music and its ka-ching share one clock: durationMs.
    const baseTakeoverMs = level >= 3 ? durationMs + TAKEOVER_TAIL_MS : 0;
    // Codex only "thinks" on half its big wins, so the gag stays a surprise.
    const codexStalls =
      canCollect &&
      result.provider.driverKind === "codex" &&
      level >= 3 &&
      result.quipSeed % 2 === 0;
    // The takeover lasts as long as everything it shows: the count, Codex's stall, and the
    // upgrade climb, so the whole climax plays out in one place and never recounts after.
    const takeoverMs =
      baseTakeoverMs > 0
        ? baseTakeoverMs +
          (level - 2) * TIER_HIT_STOP_MS +
          (codexStalls ? CODEX_STALL_MS : 0) +
          (bonus > 0 ? UPGRADE_IN_TAKEOVER_MS : 0)
        : 0;
    // runReveal resets the reveal timers, so the takeover's end is scheduled after it.
    // Outside a takeover the card lands as the count does, never ahead of the meter.
    const revealOffsetMs = takeoverMs || Math.max(0, durationMs - 3 * REVEAL_STEP_MS - 150);
    runReveal(result.agi ? 4 : level, input.perks, revealOffsetMs);
    // The banked pill waits for the count to land, so it never announces the total early.
    setFloatDelayMs(
      (takeoverMs || durationMs) + (codexStalls && takeoverMs === 0 ? CODEX_STALL_MS : 0),
    );
    if (takeoverMs > 0) {
      setGiantRarity("UNCOMMON");
      setTakeover(level);
      revealTimers.current.push(window.setTimeout(() => setTakeover(0), takeoverMs));
    }
    const cardReadyAt = performance.now() + revealOffsetMs + 3 * REVEAL_STEP_MS + 150 + 700;
    if (canCollect && after - before < SPIN_COST) setNetLoss(SPIN_COST - (after - before));
    if (input.heatRose) audioRef.current?.heatPip(heatRef.current);
    // One sting at a time: the joke or the sad trombone lands first, then the payout music.
    let musicDelay = 0;
    if (result.jester) {
      sound?.jester();
      musicDelay = 1200;
      // The model reel "hallucinates": it slips to a wrong answer, then snaps back with a honk.
      revealTimers.current.push(
        window.setTimeout(() => {
          const strip = stripRefs.current[1];
          if (!strip || reduceMotion()) return;
          const current = strip.style.transform;
          strip.animate(
            [
              { transform: current },
              { transform: `${current} translateY(-${ROW}px)`, offset: 0.35 },
              { transform: `${current} translateY(-${ROW}px)`, offset: 0.7 },
              { transform: current },
            ],
            { duration: 600, easing: "ease-in-out" },
          );
          audioRef.current?.honk();
        }, 1500),
      );
    } else if (
      canCollect &&
      result.provider.driverKind === "cursor" &&
      result.model.slug === "auto"
    ) {
      sound?.win(level);
    } else if (result.nearMissReel !== null && level <= 1) {
      sound?.nearMiss();
      musicDelay = 1300;
    } else if (level === 4) {
      sound?.jackpotFanfare();
      if (result.agi) sound?.agiChoir();
      musicDelay = 900;
    } else if (level > 0) {
      sound?.win(level);
    }
    // A sting that opens the payout stretches the count, so the count plays out under it.

    const stalls = codexStalls;
    // The music, and its closing ka-ching, end exactly when the counter lands (stall included).
    // MEGA and JACKPOT crossings each hold the count, so the music waits out those holds too.
    const hitStopsMs = takeoverMs > 0 ? (level - 2) * TIER_HIT_STOP_MS : 0;
    const musicMs = durationMs - musicDelay + (stalls ? CODEX_STALL_MS : 0) + hitStopsMs;
    // In a takeover the lock hit owns the ka-ching, so the music ends without its own.
    if (level > 0 && musicMs > 400)
      sound?.payout(level, musicMs, result.jester, musicDelay, takeoverMs === 0);
    else
      revealTimers.current.push(
        window.setTimeout(
          () => audioRef.current?.kaching(),
          Math.max(durationMs - 60, musicDelay + 800),
        ),
      );
    if (level >= 2) sound?.subBoom(level);
    if (input.discovered) {
      revealTimers.current.push(
        window.setTimeout(() => audioRef.current?.heatPip(6), musicDelay + 450),
      );
    }
    if (level >= 2) {
      setRaysKey((key) => key + 1);
      setRaysVisible(true);
      flash(level >= 3 ? 0.1 : 0.18);
    }
    if (level >= 2) shake(level === 4 ? 18 : level === 3 ? 12 : 7, 420 + level * 110);
    const coins = COINS_BY_LEVEL[level]! * multiplier + (result.jester ? 50 : 0);
    if (coins > 0) {
      const cabinet = cabinetRef.current?.getBoundingClientRect();
      const total = reduceMotion() ? Math.ceil(coins / 6) : coins;
      coinsRef.current?.burst(total, result.jester, durationMs * 0.8, cabinet);
      // A short eruption out of the tray, in front of the cabinet, sells the "it's paying out" beat.
      // Delayed so the headline lands before anything crosses it.
      // Only takeovers cover the paytable, so only they may spray coins in front of it.
      if (level >= 3)
        revealTimers.current.push(
          window.setTimeout(
            () => frontCoinsRef.current?.burst(Math.ceil(total * 0.2), result.jester, 500, cabinet),
            600,
          ),
        );
    }
    setCounting(true);
    // During a takeover the count is the takeover: one tween, sized to finish before it ends.
    const countMs = durationMs;
    rollCounter({
      from: before,
      to: baseAfter,
      peak,
      durationMs: countMs,
      giant: takeoverMs > 0,
      onTurn: () => {
        if (result.jester) {
          sound?.honk();
          setHallucinating(true);
        } else sound?.womp();
        if (pricingCut > 0) setPricingNotice(true);
      },
      ...(stalls
        ? {
            pause: {
              at: 0.45,
              ms: CODEX_STALL_MS,
              onChange: (held: boolean) => {
                setTrickling(held);
                audioRef.current?.holdPayout(held);
              },
            },
          }
        : {}),
      onDone: () => {
        const startBonuses = () =>
          runBonuses(baseAfter, [
            ...(bonus > 0 ? [{ amount: bonus, kind: "upgrade" as const }] : []),
            ...(input.completeBonus > 0
              ? [{ amount: input.completeBonus, kind: "complete" as const }]
              : []),
          ]);
        if (takeoverMs > 0) {
          // The base total closes on its own lock hit, then the bonus climb gets a fresh beat.
          lockGiant();
          revealTimers.current.push(window.setTimeout(startBonuses, LOCK_HOLD_MS));
        } else startBonuses();
      },
    });
    const settle = () => {
      setCounting(false);
      if (after < SPIN_COST && !freeSpinRef.current) {
        sound?.limitReached();
        setLimitSince(Date.now());
        setNow(Date.now());
      }
    };
    // Bonuses pay out as their own beats after the base count: a second climb, a second hit.
    const runBonuses = (
      from: number,
      queue: ReadonlyArray<{ amount: number; kind: "upgrade" | "complete" }>,
    ) => {
      const [next, ...rest] = queue;
      if (!next) {
        settle();
        return;
      }
      // The upgrade waits for the card to be on screen: you can't crack a card you haven't seen.
      // Outside a takeover, the upgrade waits for the card to be on screen.
      const wait =
        next.kind === "upgrade" && takeoverMs === 0
          ? Math.max(0, cardReadyAt - performance.now())
          : 0;
      if (wait > 0) {
        revealTimers.current.push(window.setTimeout(() => runBonuses(from, queue), wait));
        return;
      }
      if (next.kind === "upgrade") {
        setRevealStep(5);
        setEarnedShown((shown) => shown + next.amount);
        setFloatDelayMs(500);
        setFloatText(`+${formatTokens(next.amount)} BONUS`);
        // The bonus climb announces its cause before it counts.
        if (giantWordRef.current) giantWordRef.current.textContent = "⬆ UPGRADE +25%";
      } else {
        setCompletedProvider(result.provider.displayName);
      }
      flash(0.15);
      shake(12, 460);
      audioRef.current?.subBoom(3);
      audioRef.current?.win(2);
      coinsRef.current?.burst(60, result.jester, 700, cabinetRef.current?.getBoundingClientRect());
      setCounting(true);
      rollCounter({
        from,
        to: from + next.amount,
        peak: from + next.amount,
        winFrom: before,
        giant: takeoverMs > 0,
        durationMs: 1100,
        onDone: () => {
          audioRef.current?.kaching();
          runBonuses(from + next.amount, rest);
        },
      });
    };
    // The winnings stay piled in the tray until the next pull.
    if (canCollect && level >= 2) setPile(level);
    if (input.reachedHotStreak) {
      window.setTimeout(() => audioRef.current?.hotStreak(), durationMs);
    }
  };

  const finish = (result: SlotOutcome, before: number, wasHot: boolean) => {
    const sound = audioRef.current;
    sound?.motorStop();
    sound?.droneStop();
    // Bank the result now, so pulling again mid-celebration never loses a payout.
    const canCollect = installed(result);
    const level = TIER_LEVEL[result.tier];
    const multiplier = wasHot ? 2 : 1;
    // AGI pays out the progressive pool your losses have been funding, then the pool reseeds.
    const basePayout = result.agi ? poolRef.current : result.payout;
    if (canCollect && result.agi) {
      poolRef.current = POOL_SEED;
      setPool(POOL_SEED);
    }
    const gross = canCollect
      ? Math.round((result.jester ? basePayout / 2 : basePayout) * multiplier)
      : 0;
    // A pick you can't equip pays nothing, but the next pull is genuinely free.
    freeSpinRef.current = !canCollect;
    setFreeSpin(!canCollect);
    // Cursor's pricing changes mid-count: the payout visibly shrinks by a fifth.
    const pricingCut =
      canCollect && result.provider.driverKind === "cursor" && level > 0
        ? Math.round(gross * 0.2)
        : 0;
    const earnedBase = gross - pricingCut;
    const bonus = canCollect ? result.upgradeBonus * multiplier : 0;
    const earned = earnedBase + bonus;
    setEarnedShown(canCollect ? earnedBase : 0);
    setFloatText(`+${formatTokens(canCollect ? earnedBase : 0)}`);
    let reachedHotStreak = false;
    const heatBefore = heatRef.current;
    if (canCollect) {
      // Heat only builds on pulls that actually beat the pull cost; a 40K "win" just holds it.
      // A paid placement is not luck, so it never feeds the streak.
      const profitable = earned > SPIN_COST && !result.sponsored;
      const nextHeat = wasHot
        ? 0
        : level === 0
          ? 0
          : profitable
            ? Math.min(HEAT_MAX, heatRef.current + 1)
            : heatRef.current;
      reachedHotStreak = nextHeat === HEAT_MAX && heatRef.current < HEAT_MAX;
      setStreakProtected(!wasHot && level > 0 && !profitable && heatRef.current > 0);
      heatRef.current = reachedHotStreak ? 0 : nextHeat;
      if (reachedHotStreak) hotPullRef.current = true;
    }
    const comboKey = slotComboKey(result);
    const discovered = canCollect && !dexRef.current.includes(comboKey);
    if (discovered) dexRef.current = [...dexRef.current, comboKey];
    const providerKeys = slotComboKeys([result.provider]);
    const completeBonus =
      discovered && providerKeys.every((key) => dexRef.current.includes(key))
        ? DEX_COMPLETE_BONUS
        : 0;
    const after = before + earned + completeBonus;
    creditsValue.current = after;
    saveSlotState({
      tokens: after,
      heat: heatRef.current,
      dex: dexRef.current,
      pool: poolRef.current,
    });
    const blackout = canCollect && level === 4;
    const upgrade = canCollect && bonus > 0;
    const perks = !canCollect ? 0 : result.agi ? 3 : level === 4 ? 2 : level === 3 ? 1 : 0;
    setRarityUpgrade(upgrade);
    setPerkCount(perks);
    setHot(false);
    setTeasing(false);
    setBeam(0);
    setPhase("result");
    setRevealed(false);
    setBlackout(blackout);
    setCredits(after);
    setHeat(hotPullRef.current ? HEAT_MAX : heatRef.current);
    setHotPull(hotPullRef.current);
    setDex(dexRef.current);
    setDiscovered(discovered);
    spinningRef.current = false;
    // The "it landed" beat comes before the "you won" beat; jackpots get lights-out and a drumroll.
    flash(0.12);
    if (blackout) shake(6, 160);
    if (blackout) sound?.drumroll(JACKPOT_BLACKOUT_MS);
    beatRef.current = window.setTimeout(
      () => {
        setBlackout(false);
        payoutEffects({
          result,
          before,
          after,
          wasHot,
          canCollect,
          reachedHotStreak,
          discovered,
          heatRose: heatRef.current > heatBefore,
          perks,
          baseAfter: before + earnedBase,
          bonus,
          pricingCut,
          completeBonus,
        });
      },
      blackout ? JACKPOT_BLACKOUT_MS : LANDING_BEAT_MS,
    );
  };

  const spin = () => {
    if (spinningRef.current) return;
    const cost = freeSpinRef.current ? 0 : SPIN_COST;
    if (creditsValue.current < cost) return;
    freeSpinRef.current = false;
    setFreeSpin(false);
    const sound = audio();
    const wasHot = hotPullRef.current;
    const before = creditsValue.current - cost;
    const result = rollSlotOutcome(providers);
    const level = TIER_LEVEL[result.tier];
    const anticipate = result.anticipation || wasHot;
    const nextStrips = buildStrips(providers, result, stripsRef.current, centersRef.current);
    stripsRef.current = nextStrips;
    hotPullRef.current = false;
    if (wasHot) heatRef.current = 0;
    hurryRef.current = false;
    skipCountRef.current = null;
    clearRevealTimers();
    spinningRef.current = true;
    cancelAnimationFrame(frameRef.current);
    window.clearTimeout(beatRef.current);
    coinsRef.current?.clear();
    sound.stopPayout();
    creditsValue.current = before;
    poolRef.current += Math.round(cost * POOL_SHARE);
    saveSlotState({
      tokens: before,
      heat: heatRef.current,
      dex: dexRef.current,
      pool: poolRef.current,
    });
    flushSync(() => {
      setStrips(nextStrips);
      setOutcome(result);
      setPhase("spinning");
      setStopped(0);
      setCredits(before);
      setCounting(false);
      setUpgraded(false);
      setRevealed(false);
      setBlackout(false);
      setRevealStep(0);
      setNetLoss(null);
      setDiscovered(false);
      setRateLimited(false);
      setTrickling(false);
      setRollIndex(0);
      setBilledTokens(0);
      setSlammed(false);
      setDexOpen(false);
      setFirePull(wasHot);
      setTakeover(0);
      setPool(poolRef.current);
      setStreakProtected(false);
      setPullCount((count) => count + 1);
      setPricingNotice(false);
      setHallucinating(false);
      setPile(0);
      setCompletedProvider(null);
      // The chest-beam tell: the lever pull already hints at the tier (with the odd fake-out).
      setTell(null);
      setLimitSince(null);
      setWaitedOut(false);
      setHotPull(false);
      if (wasHot) setHeat(0);
    });
    // Reels are positioned imperatively; new strips start back at their first center row.
    for (const node of stripRefs.current) {
      if (node) node.style.transform = "translate3d(0, 0, 0)";
    }
    showCredits(before, 0);
    sound.motorStart();

    const plans: ReelPlan[] = nextStrips.map((strip, reel) => {
      const crawl =
        reel === 2 && anticipate
          ? level === 4
            ? [300, 400, 560, 820]
            : result.nearMissReel === 2
              ? [480, 1300]
              : [480, 900]
          : reel === 1 && result.nearMissReel === 1
            ? [1000]
            : [];
      // Ordinary pulls settle fast; only anticipated pulls earn the long reel-three crawl.
      const durations = anticipate
        ? [1000, 1500, 2000]
        : turboRef.current
          ? [380, 560, 740]
          : [750, 1100, 1450];
      return {
        start: 1,
        end: strip.length - 2,
        mainDuration: durations[reel]!,
        crawl,
        slip: result.nearMissReel === reel,
      };
    });
    // Beam colour hints the tier the way chest light does; near-misses flash gold to sting.
    const beamLevel = result.nearMissReel !== null ? 4 : Math.max(2, level);
    const fakeTell = Math.random() < 0.1;
    const lastTick = [1, 1, 1];
    const lastPhase = [-1, -1, -1];
    const lastP = [1, 1, 1];
    const done = [false, false, false];
    let previousNow = 0;
    let t = 0;
    let stopCount = 0;
    let frozenFor = result.rateLimited ? RATE_LIMIT_FREEZE_MS : 0;
    let hitStop = 0;

    const frame = (time: number) => {
      // Capped only against tab-switch gaps, so slow frames stay wall-clock true, not slow motion.
      const dt = previousNow ? Math.min(250, time - previousNow) : 0;
      previousNow = time;
      // Slam-stop fast-forwards the free spin, but never rushes a crawl that's already teasing.
      const crawling = plans.some((plan, reel) => !done[reel] && lastPhase[reel]! >= 2);
      // A rare 429 seizes every reel mid-spin, then lets them grind back up to speed.
      if (frozenFor > 0 && t >= RATE_LIMIT_AT_MS) {
        if (frozenFor === RATE_LIMIT_FREEZE_MS) {
          setRateLimited(true);
          sound.rateLimit();
          shake(5, 200);
        }
        frozenFor -= dt;
        if (frozenFor <= 0) {
          setRateLimited(false);
          sound.motorResume();
        }
        frameRef.current = requestAnimationFrame(frame);
        return;
      }
      // A short hit-stop after every reel lands: the whole machine holds its breath.
      if (hitStop > 0) {
        hitStop -= dt;
        frameRef.current = requestAnimationFrame(frame);
        return;
      }
      t += dt * (hurryRef.current && !crawling ? 5 : 1);
      plans.forEach((plan, reel) => {
        if (done[reel]) return;
        const { p, done: reelDone, phase: reelPhase } = reelPosition(plan, t);
        const node = stripRefs.current[reel];
        const speed = Math.abs(p - lastP[reel]!) / (dt / 1000);
        if (node) {
          node.style.transform = `translate3d(0, ${(-(p - 1) * ROW).toFixed(2)}px, 0)`;
          reelRefs.current[reel]?.setAttribute(
            "data-blur",
            speed > 26 ? "2" : speed > 12 ? "1" : "0",
          );
        }
        lastP[reel] = p;
        const row = Math.round(p);
        if (row !== lastTick[reel]) {
          lastTick[reel] = row;
          sound.tick(Math.min(1, speed / 40));
        }
        if (reelPhase !== lastPhase[reel]) {
          if (plan.crawl.length === 0 && reelPhase === 1) {
            // The tell builds as reels land: a hint after reel one, a stronger one after reel two.
            if (reel === 0 && (level >= 2 || fakeTell)) setTell("blue");
            if (reel === 1 && (level >= 3 || (fakeTell && level >= 2))) setTell("purple");
            sound.reelStop(reel, level === 4);
            impactReel(reel);
            if (reel === 0) sound.motorDuck();
          }
          if (reelPhase >= 2 && reelPhase < 2 + plan.crawl.length) {
            sound.heartbeat((reelPhase - 2) / plan.crawl.length);
            if (reel === 2 && reelPhase === 2 + plan.crawl.length - 1) setTeasing(true);
          }
          if (plan.crawl.length > 0 && reelPhase === 2 + plan.crawl.length) {
            sound.reelStop(reel, level === 4);
            impactReel(reel);
          }
          lastPhase[reel] = reelPhase;
        }
        if (reelDone) {
          if (reel < 2) hitStop = 70;
          done[reel] = true;
          centersRef.current[reel] = plan.end;
          stopCount++;
          setStopped(stopCount);
          reelRefs.current[reel]?.setAttribute("data-blur", "0");
          if (reel === 1 && anticipate) {
            setHot(true);
            setBeam(beamLevel);
            sound.motorStop();
            sound.droneStart();
            sound.tierHint(beamLevel - 1);
          }
        }
      });
      if (done.every(Boolean)) {
        finish(result, before, wasHot);
        return;
      }
      frameRef.current = requestAnimationFrame(frame);
    };
    frameRef.current = requestAnimationFrame(frame);
  };

  const outOfTokens =
    !freeSpin &&
    credits < SPIN_COST &&
    phase !== "spinning" &&
    !counting &&
    (phase !== "result" || revealed);

  const upgrade = () => {
    const sound = audio();
    const before = creditsValue.current;
    creditsValue.current = START_CREDITS;
    sound.kaching();
    setUpgraded(true);
    setCounting(true);
    rollCounter({
      from: before,
      to: START_CREDITS,
      peak: START_CREDITS,
      durationMs: 900,
      showWin: false,
      onDone: () => {
        setCounting(false);
        setCredits(START_CREDITS);
        setLimitSince(null);
      },
    });
    saveSlotState({
      tokens: START_CREDITS,
      heat: heatRef.current,
      dex: dexRef.current,
      pool: poolRef.current,
    });
  };

  /** Space or the lever mid-action: slam-stop the reels, then skip the count, then pull. */
  const press = () => {
    if (spinningRef.current) {
      if (!hurryRef.current) {
        hurryRef.current = true;
        setSlammed(true);
        audioRef.current?.leverClunk();
        shake(5, 160);
      }
      return;
    }
    if (skipCountRef.current) {
      skipCountRef.current();
      skipCountRef.current = null;
      audioRef.current?.stopPayout();
      return;
    }
    autoPull();
  };

  const autoPull = () => {
    if (
      spinningRef.current ||
      (counting && creditsValue.current < SPIN_COST && !freeSpinRef.current)
    )
      return;
    if (outOfTokens) {
      upgrade();
      return;
    }
    const sound = audio();
    cancelAnimationFrame(leverFrame.current);
    let start: number | null = null;
    const step = (now: number) => {
      start ??= now;
      const u = Math.min(1, (now - start) / 150);
      const progress = easeOutCubic(u);
      setLever(progress);
      sound.ratchet(progress);
      if (u < 1) {
        leverFrame.current = requestAnimationFrame(step);
      } else {
        release(true);
      }
    };
    leverFrame.current = requestAnimationFrame(step);
  };

  const release = (pulled: boolean) => {
    if (pulled) {
      audio().leverClunk();
      spin();
    }
    springLeverHome();
  };

  const onLeverPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (spinningRef.current) {
      press();
      return;
    }
    if (outOfTokens) return;
    audio();
    event.currentTarget.setPointerCapture(event.pointerId);
    cancelAnimationFrame(leverFrame.current);
    dragRef.current = { startY: event.clientY, moved: false };
  };
  const onLeverPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const distance = event.clientY - drag.startY;
    if (Math.abs(distance) > 4) drag.moved = true;
    const progress = Math.max(0, Math.min(1, distance / 260));
    setLever(progress);
    audioRef.current?.ratchet(progress);
  };
  const onLeverPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (!drag.moved) {
      autoPull();
      return;
    }
    release(leverProgress.current > 0.62);
  };

  const collect = () => {
    if (!outcome || phase !== "result" || !installed(outcome) || !outcome.provider.instanceId)
      return;
    const selection = {
      instanceId: outcome.provider.instanceId,
      model: outcome.model.slug,
      effortOptionId: outcome.model.effortOptionId,
      effortValue: outcome.effort.id,
    };
    audioRef.current?.revealPop(3);
    audioRef.current?.kaching();
    // The prize flies down toward the composer's model chip before the machine closes.
    const prize =
      rootRef.current?.querySelector<HTMLElement>("[data-slot-loot]") ??
      rootRef.current?.querySelector<HTMLElement>("[data-slot-payline]");
    if (!prize || reduceMotion()) {
      props.onCollect(selection);
      return;
    }
    const chip = document.querySelector<HTMLElement>("[data-chat-provider-model-picker]");
    const from = prize.getBoundingClientRect();
    const to = chip?.getBoundingClientRect();
    // The stage is CSS-scaled, so screen deltas convert back into its local pixels.
    const scale = from.width / Math.max(1, prize.offsetWidth);
    const dx = to ? (to.left + to.width / 2 - (from.left + from.width / 2)) / scale : 0;
    const dy = to ? (to.top + to.height / 2 - (from.top + from.height / 2)) / scale : 520;
    // The prize flies as a detached clone, so it stays fully opaque while the machine fades out.
    const flyer = prize.cloneNode(true) as HTMLElement;
    Object.assign(flyer.style, {
      position: "fixed",
      left: `${from.left}px`,
      top: `${from.top}px`,
      width: `${prize.offsetWidth}px`,
      height: `${prize.offsetHeight}px`,
      margin: "0",
      zIndex: "1000",
      transformOrigin: "center",
      transform: `scale(${scale})`,
      pointerEvents: "none",
    });
    flyer.style.translate = `${((scale - 1) * prize.offsetWidth) / 2}px ${((scale - 1) * prize.offsetHeight) / 2}px`;
    document.body.appendChild(flyer);
    prize.style.visibility = "hidden";
    rootRef.current?.parentElement?.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 220,
      easing: "ease-in",
      fill: "forwards",
    });
    const land = () => {
      flyer.remove();
      audioRef.current?.revealPop(2);
      props.onCollect(selection);
      chip?.animate(
        [
          { transform: "scale(1)", filter: "brightness(1)" },
          { transform: "scale(1.3)", filter: "brightness(2)", offset: 0.3 },
          { transform: "scale(1)", filter: "brightness(1)" },
        ],
        { duration: 620, easing: "cubic-bezier(0.2, 1.6, 0.4, 1)" },
      );
      chip?.animate(
        [
          { boxShadow: "0 0 0 0 rgb(255 204 51 / 0.9)" },
          { boxShadow: "0 0 0 14px rgb(255 204 51 / 0)" },
        ],
        { duration: 700, easing: "ease-out" },
      );
    };
    const sx = dx * scale;
    const sy = dy * scale;
    flyer
      .animate(
        [
          { transform: `scale(${scale})` },
          { transform: `translateY(-40px) scale(${scale * 1.1})`, offset: 0.2 },
          {
            transform: `translate(${sx * 0.6}px, ${sy * 0.35 - 120}px) scale(${scale * 0.55}) rotate(-8deg)`,
            offset: 0.6,
          },
          { transform: `translate(${sx}px, ${sy}px) scale(${scale * 0.14}) rotate(-14deg)` },
        ],
        { duration: 700, easing: "cubic-bezier(0.45, 0, 0.55, 1)", fill: "forwards" },
      )
      .finished.then(land, land);
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    globalThis.localStorage?.setItem(MUTE_KEY, next ? "1" : "0");
    audioRef.current?.setMuted(next);
  };

  const totalCombos = slotComboKeys(providers).length;
  // The roulette spins through the won provider's own models, so it resolves the reels' answer.
  const ownEntries =
    outcome !== null && phase === "result"
      ? outcome.provider.models.map((model) => ({ provider: outcome.provider, model }))
      : [];
  const rollingEntries =
    ownEntries.length >= 3
      ? ownEntries
      : providers.flatMap((provider) => provider.models.map((model) => ({ provider, model })));
  const rollingEntry =
    ownEntries.find((entry) => entry.model.slug === outcome?.model.slug) ??
    rollingEntries[
      ownEntries.length >= 3
        ? (Math.max(
            0,
            ownEntries.findIndex((entry) => entry.model.slug === outcome?.model.slug),
          ) +
            ROLL_TICKS -
            rollIndex) %
          ownEntries.length
        : (rollIndex * 7 + (outcome?.quipSeed ?? 0)) % rollingEntries.length
    ];
  const resultInstalled = outcome ? installed(outcome) : false;
  const showResult = phase === "result" && outcome !== null;
  const level = outcome ? TIER_LEVEL[outcome.tier] : 0;
  const palette =
    showResult && outcome.jester
      ? "jester"
      : showResult && outcome.agi && revealed
        ? "agi"
        : showResult && outcome.provider.driverKind === "grok"
          ? "edgelord"
          : "house";
  const rawStamp = showResult && revealed ? slotStamp(outcome, resultInstalled) : null;
  const nearMissShown = showResult && revealed && outcome.nearMissReel !== null;
  const willDealLoot = showResult && resultInstalled && (level >= 2 || outcome.agi);
  const lootCard = willDealLoot && revealStep >= 4;
  const rarity = !showResult
    ? ""
    : outcome.agi
      ? "MYTHIC"
      : level === 4
        ? "LEGENDARY"
        : level === 3
          ? "EPIC"
          : "RARE";
  const shownRarity = rarityUpgrade && revealStep < 5 ? (RARITY_BELOW[rarity] ?? rarity) : rarity;
  const rolling = !lootCard && rollIndex > 0 && willDealLoot && !takeover;
  const rollRarity =
    ROLL_LADDER[
      rollRarityStep(
        rollIndex,
        Math.max(1, ROLL_LADDER.indexOf(shownRarity as (typeof ROLL_LADDER)[number])),
      )
    ] ?? "LEGENDARY";
  const perkLabels = showResult
    ? Array.from(
        { length: perkCount },
        (_, index) => PERKS[(outcome.quipSeed + index) % PERKS.length]!,
      )
    : [];
  const limitRemaining =
    limitSince === null ? 0 : Math.max(0, 5 * 3600 - Math.floor((now - limitSince) / 1000));
  const limitClock = `${Math.floor(limitRemaining / 3600)}:${String(
    Math.floor((limitRemaining % 3600) / 60),
  ).padStart(2, "0")}:${String(limitRemaining % 60).padStart(2, "0")}`;
  const headline = blackout
    ? "· · ·"
    : outOfTokens
      ? "USAGE LIMIT REACHED"
      : upgraded && phase !== "spinning"
        ? "MAX PLAN ACTIVATED"
        : showResult
          ? revealed && !takeover
            ? slotHeadline(outcome, resultInstalled)
            : "· · ·"
          : phase === "spinning"
            ? slammed && !hot
              ? "SLAM!"
              : hot
                ? teasing
                  ? "!!!"
                  : "HOLD..."
                : hotPull
                  ? "ON FIRE x2"
                  : "GOOD LUCK"
            : hotPull
              ? "ON FIRE x2"
              : "PULL THE LEVER";
  const quip = blackout
    ? ""
    : trickling
      ? "Remaining payout arriving in the coming weeks…"
      : outOfTokens
        ? waitedOut
          ? "Still waiting? Respect. (Or $8/mo at t3.chat, but that's a different app.)"
          : "You're out of tokens. They reset in 5 hours. Or you could simply give us $200."
        : upgraded && phase !== "spinning"
          ? "Tokens refilled. Limits may still apply. Limits will always apply."
          : showResult
            ? slotQuip(outcome, resultInstalled)
            : phase === "spinning"
              ? hot
                ? "Something's happening on reel three..."
                : "Reels are hot. Fortune favors the vibe coder."
              : hotPull
                ? "Heat maxed. Next pull pays double and the reels know it."
                : "Drag the lever, or press Space. Collect with Enter.";
  const stamp = rawStamp && rawStamp !== headline ? rawStamp : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ticks the reasoning-token bill only while Codex's stall is on screen.
  useEffect(() => {
    if (!trickling) return;
    const timer = window.setInterval(() => setBilledTokens((tokens) => tokens + 4_096), 90);
    return () => window.clearInterval(timer);
  }, [trickling]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a 1 Hz wall clock for the usage-limit countdown, only while it is shown.
  useEffect(() => {
    if (limitSince === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [limitSince]);

  return createPortal(
    <div
      data-slot-overlay
      data-takeover={takeover || undefined}
      role="dialog"
      aria-modal="true"
      aria-label="Model slot machine"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !spinningRef.current) props.onClose();
      }}
    >
      <div
        ref={rootRef}
        tabIndex={-1}
        data-slot-stage
        data-palette={palette}
        data-phase={phase}
        data-hot={hot || undefined}
        data-on-fire={hotPull || firePull || undefined}
        data-blackout={blackout || undefined}
        data-takeover={takeover || undefined}
        data-tell={phase === "spinning" ? (tell ?? undefined) : undefined}
        data-heat={heat}
        data-level={showResult ? level : undefined}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (!spinningRef.current) props.onClose();
          } else if (event.key === " ") {
            event.preventDefault();
            press();
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (phase === "result" && resultInstalled) collect();
            else autoPull();
          }
        }}
      >
        {raysVisible && showResult && level >= 2 ? (
          <div
            data-slot-rays
            key={`rays-${raysKey}`}
            aria-hidden
            onAnimationEnd={() => setRaysVisible(false)}
          />
        ) : null}
        <canvas ref={canvasRef} data-slot-coins aria-hidden />
        <div data-slot-cabinet ref={cabinetRef}>
          <div data-slot-marquee>
            <div data-slot-bulbs aria-hidden />
            <div data-slot-title>
              <span data-slot-title-kicker>
                {hotPull
                  ? "🔥 HOT STREAK · NEXT PULL PAYS x2 🔥"
                  : streakProtected
                    ? "STREAK PROTECTED (it was a loss)"
                    : heat === HEAT_MAX - 1
                      ? "⚠ ONE MORE WIN FOR 🔥 ON FIRE ⚠"
                      : `AGI POOL ${formatTokens(pool)} · funded by your losses`}
              </span>
              <span data-slot-title-main>ONE-ARMED BENCHMARK</span>
              <span data-slot-title-sub>{MARQUEE_LINES[pullCount % MARQUEE_LINES.length]}</span>
            </div>
            {palette === "jester" ? (
              <div data-slot-jester-hat aria-hidden>
                🃏
              </div>
            ) : null}
          </div>

          <div data-slot-body>
            <div data-slot-meters>
              {showResult && revealed && floatText.endsWith("BONUS") ? (
                <span
                  data-slot-float
                  key={floatText}
                  style={{ animationDelay: `${floatDelayMs}ms` }}
                  aria-hidden
                >
                  {floatText}
                </span>
              ) : null}
              <div data-slot-meter>
                <span data-slot-meter-label>TOKENS</span>
                <span data-slot-meter-value ref={creditsRef} />
              </div>
              <div data-slot-meter ref={winMeterRef}>
                <span
                  data-slot-meter-label
                  data-loss={netLoss !== null && !counting ? true : undefined}
                >
                  {hallucinating
                    ? "WIN · HALLUCINATED ✗"
                    : pricingNotice
                      ? "WIN · PRICING UPDATED −20%"
                      : showResult && revealed && !resultInstalled
                        ? "WIN · NEXT PULL FREE"
                        : netLoss !== null && !counting
                          ? `WIN · NET −${netLoss / 1000}K`
                          : "WIN"}
                </span>
                <span data-slot-meter-value ref={winRef} />
              </div>
              <div
                data-slot-meter
                data-slot-meter-small
                data-slot-dex-meter
                role="button"
                tabIndex={0}
                aria-label="Open the model dex"
                onClick={() => setDexOpen((open) => !open)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.stopPropagation();
                    setDexOpen((open) => !open);
                  }
                }}
              >
                <span data-slot-meter-label>DEX ▾</span>
                <span data-slot-meter-value data-slot-dex>
                  {dex.length}/{totalCombos}
                </span>
              </div>
              <div data-slot-meter data-slot-meter-small>
                <span data-slot-meter-label>HEAT</span>
                <span data-slot-heat aria-label={`Heat ${heat} of ${HEAT_MAX}`}>
                  {Array.from({ length: HEAT_MAX }, (_, index) => (
                    <i key={index} data-on={index < heat || undefined} />
                  ))}
                </span>
              </div>
            </div>

            <div data-slot-window>
              <div data-slot-reel-labels aria-hidden>
                <span>PROVIDER</span>
                <span>MODEL</span>
                <span>EFFORT</span>
              </div>
              <div data-slot-reels>
                {strips.map((strip, reel) => (
                  <div
                    // oxlint-disable-next-line react/no-array-index-key -- reels are a fixed set of three columns.
                    key={reel}
                    ref={(node) => {
                      reelRefs.current[reel] = node;
                    }}
                    data-slot-reel
                    data-reel={reel}
                    data-stopped={stopped > reel || undefined}
                    data-hot={hot && reel === 2 ? true : undefined}
                    data-beam={hot && reel === 2 ? beam : undefined}
                    data-dimmed={hot && reel < 2 ? true : undefined}
                  >
                    <div
                      data-slot-strip
                      ref={(node) => {
                        stripRefs.current[reel] = node;
                      }}
                    >
                      {strip.map((symbol, index) => {
                        const isPayline = showResult && index === strip.length - 2;
                        const isTease =
                          showResult && outcome.nearMissReel === reel && index === strip.length - 3;
                        const popped = isPayline && revealStep > reel;
                        return (
                          <div
                            key={symbol.key}
                            data-slot-symbol
                            data-kind={reel}
                            data-jackpot={symbol.jackpot || undefined}
                            data-dim={symbol.dim || undefined}
                            data-payline={isPayline || undefined}
                            data-tease={isTease || undefined}
                            data-jester={symbol.jester || undefined}
                            data-pop={popped || undefined}
                            data-rarity={popped ? rarity : undefined}
                            data-wild={symbol.wild || undefined}
                          >
                            {symbol.wild ? (
                              <>
                                <span data-slot-wild-label>AGI</span>
                                <span data-slot-symbol-caption>wild · achieved internally</span>
                              </>
                            ) : reel === 0 ? (
                              <>
                                <ProviderInstanceIcon
                                  driverKind={symbol.driverKind}
                                  displayName={symbol.label}
                                  className="size-10"
                                  iconClassName="size-9"
                                />
                                <span data-slot-symbol-label>{symbol.label}</span>
                                {symbol.caption ? (
                                  <span data-slot-symbol-caption>{symbol.caption}</span>
                                ) : null}
                              </>
                            ) : reel === 1 ? (
                              <>
                                <span data-slot-symbol-stars aria-hidden>
                                  {"★".repeat(symbol.level)}
                                  <span data-slot-star-off>{"★".repeat(3 - symbol.level)}</span>
                                </span>
                                <span
                                  data-slot-symbol-label
                                  data-slot-model-name
                                  data-long={symbol.label.length > 18 || undefined}
                                >
                                  {symbol.label}
                                </span>
                                <span data-slot-symbol-caption>{symbol.caption}</span>
                              </>
                            ) : (
                              <>
                                <span data-slot-effort-bars aria-hidden>
                                  {[1, 2, 3, 4].map((bar) => (
                                    <i key={bar} data-on={bar <= symbol.level || undefined} />
                                  ))}
                                </span>
                                <span
                                  data-slot-symbol-label
                                  data-slot-effort-name
                                  data-long={symbol.label.length > 7 || undefined}
                                >
                                  {symbol.jackpot ? `🔥 ${symbol.label}` : symbol.label}
                                </span>
                              </>
                            )}
                            {isTease ? <span data-slot-tease-tag>JACKPOT?!</span> : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
              <div
                data-slot-payline
                data-win={showResult && level > 0 ? true : undefined}
                aria-hidden
              >
                <span data-slot-payline-arrow>▶</span>
                <span data-slot-payline-arrow>◀</span>
              </div>
              <div data-slot-glass aria-hidden />
              {firePull ? (
                <div data-slot-x2 aria-hidden>
                  🔥 ×2
                </div>
              ) : null}

              {dexOpen ? (
                <div data-slot-dex-panel>
                  <div data-slot-dex-title>
                    MODEL DEX · {dex.length}/{totalCombos} collected
                  </div>
                  {providers.map((provider) => (
                    <div key={provider.driverKind} data-slot-dex-row>
                      <span data-slot-dex-provider>
                        {provider.displayName}{" "}
                        <span data-slot-dex-count>
                          {dex.filter((key) => key.startsWith(`${provider.driverKind}:`)).length}/
                          {provider.models.reduce((sum, model) => sum + model.efforts.length, 0)}
                        </span>
                      </span>
                      <span data-slot-dex-cells>
                        {provider.models.flatMap((model) =>
                          model.efforts.map((effort) => {
                            const key = `${provider.driverKind}:${model.slug}:${effort.label}`;
                            const found = dex.includes(key);
                            return (
                              <span key={key} data-slot-dex-cell data-found={found || undefined}>
                                {found ? `${model.name} · ${effort.label}` : "???"}
                              </span>
                            );
                          }),
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
              {rateLimited ? (
                <div data-slot-429 aria-live="assertive">
                  {outcome?.provider.driverKind === "claudeAgent" ? (
                    <>
                      <span>529</span>
                      <span>OVERLOADED · Claude is at capacity · please hold</span>
                    </>
                  ) : (
                    <>
                      <span>429</span>
                      <span>RATE LIMITED · please slow down and also pay more</span>
                    </>
                  )}
                </div>
              ) : null}
            </div>

            {takeover ? (
              <div data-slot-giant data-stalled={trickling || undefined} aria-hidden>
                <span
                  data-slot-giant-word
                  data-slot-final={
                    level === 4 ? (outcome?.agi ? "AGI ACHIEVED" : "JACKPOT") : "MEGA WIN"
                  }
                  ref={(node) => {
                    giantWordRef.current = node;
                  }}
                >
                  WIN
                </span>
                <span
                  data-slot-giant-amount
                  ref={(node) => {
                    giantRef.current = node;
                  }}
                >
                  +{formatTokens(earnedShown * 0.04)}
                </span>
                <span data-slot-giant-model>
                  {outcome?.model.name} · {outcome?.effort.label}
                </span>
                <span data-slot-giant-label data-stall={trickling || undefined}>
                  {trickling
                    ? `CODEX IS THINKING… ${formatTokens(billedTokens)} REASONING TOKENS BILLED`
                    : `${giantRarity} · TOKENS`}
                </span>
              </div>
            ) : null}
            <div data-slot-banner data-level={showResult ? level : undefined} aria-live="polite">
              {nearMissShown ? <span data-slot-nearmiss>ONE ROW AWAY</span> : null}
              <span data-slot-headline hidden={nearMissShown} key={headline}>
                {headline}
              </span>
              <span data-slot-quip>{quip}</span>
              {completedProvider ? (
                <span data-slot-new>
                  🏆 {completedProvider.toUpperCase()} DEX COMPLETE · +
                  {formatTokens(DEX_COMPLETE_BONUS)}
                </span>
              ) : null}
              {discovered && revealed && !lootCard && !nearMissShown ? (
                <span data-slot-new>✨ NEW IN YOUR DEX</span>
              ) : null}
              {stamp && !lootCard && !willDealLoot && outcome?.nearMissReel == null ? (
                <div data-slot-stamp key={`${stamp}-${outcome?.quipSeed}`} aria-hidden>
                  {stamp}
                </div>
              ) : null}
            </div>

            {/* The loot card is dealt over the paytable, so the cabinet never changes height. */}
            <div data-slot-result-slot>
              <div
                data-slot-paytable
                data-under-card={lootCard || rolling || undefined}
                aria-hidden
              >
                <div
                  data-slot-paytable-row
                  data-special
                  data-lit={showResult && revealed && outcome.agi ? true : undefined}
                >
                  <span>AGI</span>
                  <span data-slot-paytable-combo>3 AGI wilds · achieved internally</span>
                  <span>{formatTokens(pool)}</span>
                </div>
                <div
                  data-slot-paytable-row
                  data-special
                  data-lit={showResult && revealed && outcome.jester ? true : undefined}
                >
                  <span>GEMINI</span>
                  <span data-slot-paytable-combo>any Gemini · payout hallucinated</span>
                  <span>½ × ???</span>
                </div>
                {(["jackpot", "mega", "big", "win", "slop"] as const).map((tier) => (
                  <div
                    key={tier}
                    data-slot-paytable-row
                    data-lit={
                      showResult &&
                      revealed &&
                      resultInstalled &&
                      !outcome.agi &&
                      !outcome.jester &&
                      outcome.tier === tier
                        ? true
                        : undefined
                    }
                  >
                    <span>{tier === "slop" ? "SLOP" : tier.toUpperCase()}</span>
                    <span data-slot-paytable-combo>
                      {tier === "jackpot"
                        ? "★★★ + 🔥"
                        : tier === "mega"
                          ? "★★★ + high · ★★ + 🔥"
                          : tier === "big"
                            ? "★★★ + med · ★★ + high · ★ + 🔥"
                            : tier === "win"
                              ? "★★★ + low · ★★ + med · ★ + high"
                              : "anything less"}
                    </span>
                    <span>{formatTokens(PAYOUT_BY_TIER[tier])}</span>
                  </div>
                ))}
              </div>
              {rolling && rollingEntry ? (
                <div data-slot-loot data-rolling data-rarity={rollRarity} aria-hidden>
                  <ProviderInstanceIcon
                    driverKind={rollingEntry.provider.driverKind}
                    displayName={rollingEntry.provider.displayName}
                    className="size-12"
                    iconClassName="size-10"
                  />
                  <div data-slot-loot-text>
                    <span data-slot-loot-rarity>{rollRarity} · APPRAISING…</span>
                    <span data-slot-loot-model>{rollingEntry.model.name}</span>
                  </div>
                </div>
              ) : null}
              {lootCard ? (
                <div
                  data-slot-loot
                  data-rarity={shownRarity}
                  data-upgraded={rarityUpgrade && revealStep >= 5 ? true : undefined}
                  data-from-roll={rollIndex > 0 || undefined}
                  key={`loot-${outcome.quipSeed}-${shownRarity}`}
                >
                  <ProviderInstanceIcon
                    driverKind={outcome.provider.driverKind}
                    displayName={outcome.provider.displayName}
                    className="size-16"
                    iconClassName="size-14"
                  />
                  <div data-slot-loot-text>
                    <span data-slot-loot-rarity>
                      {rarityUpgrade && revealStep >= 5 ? "⬆ UPGRADED · " : ""}
                      {shownRarity}
                      {discovered ? " · ✨ NEW" : ""}
                    </span>
                    <span data-slot-loot-model>{outcome.model.name}</span>
                    <span data-slot-loot-payout>+{formatTokens(earnedShown)} tokens</span>
                    <span data-slot-loot-meta>
                      {outcome.provider.displayName} · {"★".repeat(outcome.model.tier)} ·{" "}
                      {outcome.effort.label} effort · ⏎ to equip
                    </span>
                    {perkLabels.length > 0 ? (
                      <span data-slot-perks>
                        {perkLabels.map((perk, index) => (
                          <span
                            key={perk}
                            data-slot-perk
                            style={{
                              animationDelay: `${(rarityUpgrade ? 1500 : 700) + index * 320}ms`,
                            }}
                          >
                            + {perk}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </div>
                  {outcome.benchmaxxed ? (
                    <svg data-slot-chart viewBox="0 0 180 70" aria-hidden>
                      <rect x="22" y="8" width="40" height="46" data-us />
                      <rect x="98" y="34" width="40" height="20" data-them />
                      <text x="42" y="5" textAnchor="middle">
                        69.1%
                      </text>
                      <text x="118" y="31" textAnchor="middle">
                        74.9%
                      </text>
                      <text x="42" y="66" textAnchor="middle">
                        US
                      </text>
                      <text x="118" y="66" textAnchor="middle">
                        THEM
                      </text>
                      <line x1="10" y1="54" x2="170" y2="54" stroke="currentColor" />
                    </svg>
                  ) : null}

                  {stamp ? (
                    <div data-slot-stamp data-on-card aria-hidden>
                      {stamp}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div data-slot-controls>
              <button
                type="button"
                data-slot-button
                data-slot-button-ghost
                data-on={turbo || undefined}
                aria-pressed={turbo}
                onClick={() => {
                  turboRef.current = !turboRef.current;
                  setTurbo(turboRef.current);
                }}
              >
                ⚡ {turbo ? "TURBO ON" : "TURBO"}
              </button>
              <button type="button" data-slot-button data-slot-button-ghost onClick={toggleMute}>
                {muted ? "🔇 Unmute" : "🔊 Mute"}
              </button>
              <button
                type="button"
                data-slot-button
                data-slot-button-spin
                disabled={phase === "spinning" || (counting && outOfTokens)}
                onClick={autoPull}
              >
                {outOfTokens
                  ? "UPGRADE TO MAX · $200"
                  : freeSpin
                    ? "SPIN · FREE"
                    : `${hotPull ? "🔥 SPIN x2" : "SPIN"} −${SPIN_COST / 1000}K`}
              </button>
              {outOfTokens ? (
                <button
                  type="button"
                  data-slot-button
                  data-slot-button-ghost
                  onClick={() => setWaitedOut(true)}
                >
                  ⏳ WAIT {limitClock}
                </button>
              ) : (
                <button
                  type="button"
                  data-slot-button
                  data-slot-button-collect
                  disabled={!showResult || !revealed}
                  // A free spin isn't a dead end: the button pulls again instead of collecting.
                  onClick={resultInstalled ? collect : autoPull}
                >
                  {showResult && !resultInstalled ? "↻ FREE SPIN" : "COLLECT ⏎"}
                </button>
              )}
            </div>
          </div>

          <div data-slot-tray data-pile={pile || undefined} aria-hidden>
            <div data-slot-tray-slot />
            {pile > 0 ? <div data-slot-pile key={`pile-${pullCount}`} /> : null}
          </div>
          <div data-slot-flash ref={flashRef} aria-hidden />
        </div>

        <canvas ref={frontCanvasRef} data-slot-coins data-front aria-hidden />
        <div data-slot-lever-housing aria-hidden>
          <div
            ref={leverRef}
            data-slot-lever
            onPointerDown={onLeverPointerDown}
            onPointerMove={onLeverPointerMove}
            onPointerUp={onLeverPointerUp}
            onPointerCancel={onLeverPointerUp}
          >
            <div data-slot-lever-rod />
            <div data-slot-lever-ball />
          </div>
          <div data-slot-lever-hub />
        </div>
      </div>
    </div>,
    document.body,
  );
}
