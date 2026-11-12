import {
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { REASONING_EFFORT_OPTION_IDS } from "@t3tools/client-runtime/state/thread-execution";

import {
  isProviderInstancePickerReady,
  type ProviderInstanceEntry,
} from "../../../providerInstances";

export type SlotTier = 0 | 1 | 2 | 3;

export interface SlotEffort {
  readonly id: string | null;
  readonly label: string;
  readonly tier: SlotTier;
}

export interface SlotModel {
  readonly slug: string;
  readonly name: string;
  readonly tier: 1 | 2 | 3;
  readonly effortOptionId: string | null;
  readonly efforts: ReadonlyArray<SlotEffort>;
}

export interface SlotProvider {
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  /** Null when no ready instance exists; the reel still shows it, it just can't pay out. */
  readonly instanceId: ProviderInstanceId | null;
  readonly entry: ProviderInstanceEntry | null;
  readonly models: ReadonlyArray<SlotModel>;
}

export type PayoutTier = "slop" | "win" | "big" | "mega" | "jackpot";

export interface SlotOutcome {
  readonly provider: SlotProvider;
  readonly model: SlotModel;
  readonly effort: SlotEffort;
  readonly tier: PayoutTier;
  readonly payout: number;
  readonly jester: boolean;
  /** Reel index that parks the symbol that would have made a jackpot one row off the payline. */
  readonly nearMissReel: 1 | 2 | null;
  readonly teaseModel: SlotModel | null;
  readonly teaseEffort: SlotEffort | null;
  /** Reel three crawls; true for jackpots, near-misses, and occasional fake-outs. */
  readonly anticipation: boolean;
  /** A jackpot whose counter overshoots, then corrects down to the real payout. */
  readonly benchmaxxed: boolean;
  /** The rarest pull: every reel shows the AGI wild. Collecting still yields the real combo. */
  readonly agi: boolean;
  readonly quipSeed: number;
  /** A rare mid-spin 429: the reels freeze, then grudgingly resume. Cosmetic only. */
  readonly rateLimited: boolean;
  /** BIG+ only: the card is dealt one rarity low, then cracks and pays this bonus on top. */
  readonly upgradeBonus: number;
  /** The rigged 1-in-10 Fable 5.2 pull, which the machine discloses as a sponsored result. */
  readonly sponsored: boolean;
}

const driver = ProviderDriverKind.make;

export const SLOT_DRIVER_ORDER: ReadonlyArray<ProviderDriverKind> = [
  driver("claudeAgent"),
  driver("codex"),
  driver("antigravity"),
  driver("cursor"),
  driver("grok"),
  driver("opencode"),
  driver("pi"),
  driver("muse"),
  driver("fx"),
  driver("acpRegistry"),
];

const LOW: SlotEffort = { id: "low", label: "Low", tier: 0 };
const MEDIUM: SlotEffort = { id: "medium", label: "Medium", tier: 1 };
const HIGH: SlotEffort = { id: "high", label: "High", tier: 2 };
const XHIGH: SlotEffort = { id: "xhigh", label: "Extra High", tier: 3 };
const MAX: SlotEffort = { id: "max", label: "Max", tier: 3 };
const VIBES: SlotEffort = { id: null, label: "Vibes", tier: 1 };

const catalogModel = (
  slug: string,
  name: string,
  tier: 1 | 2 | 3,
  efforts: ReadonlyArray<SlotEffort> = [VIBES],
  effortOptionId: string | null = efforts[0]?.id ? "reasoningEffort" : null,
): SlotModel => ({ slug, name, tier, efforts, effortOptionId });

/** Shown for providers that aren't set up here, so every reel stop is real-looking. */
const STATIC_CATALOG: Record<string, ReadonlyArray<SlotModel>> = {
  claudeAgent: [
    catalogModel("claude-opus-5-5", "Opus 5.5", 3, [LOW, MEDIUM, HIGH, MAX], "effort"),
    catalogModel("claude-sonnet-5-5", "Sonnet 5.5", 2, [LOW, MEDIUM, HIGH, MAX], "effort"),
    catalogModel("claude-fable-5-2", "Fable 5.2", 2, [LOW, MEDIUM, HIGH], "effort"),
    catalogModel("claude-haiku-5-5", "Haiku 5.5", 1, [LOW, MEDIUM, HIGH], "effort"),
  ],
  codex: [
    catalogModel("gpt-6-astra", "GPT-6 Astra", 3, [LOW, MEDIUM, HIGH, XHIGH]),
    catalogModel("gpt-5.6-sol", "GPT-5.6 Sol", 3, [LOW, MEDIUM, HIGH, XHIGH]),
    catalogModel("gpt-5.6-terra", "GPT-5.6 Terra", 2, [LOW, MEDIUM, HIGH]),
    catalogModel("gpt-6-luna", "GPT-6 Luna", 1, [LOW, MEDIUM, HIGH]),
  ],
  antigravity: [
    catalogModel("gemini-4-argon", "Gemini 4 Argon", 3, [LOW, HIGH]),
    catalogModel("gemini-3.1-pro", "Gemini 3.1 Pro", 2, [LOW, HIGH]),
    catalogModel("gemini-3.8-flash", "Gemini 3.8 Flash", 1, [LOW, MEDIUM, HIGH]),
  ],
  cursor: [
    catalogModel("auto", "Auto", 2),
    catalogModel("composer-2", "Composer 2", 2),
    catalogModel("composer-1.5", "Composer 1.5", 1),
  ],
  grok: [
    catalogModel("grok-build", "Grok Build", 2),
    catalogModel("grok-4.6", "Grok 4.6", 3, [LOW, HIGH]),
    catalogModel("grok-4.5", "Grok 4.5", 1, [LOW, HIGH]),
  ],
  opencode: [
    catalogModel("openai/gpt-5", "GPT-5 (OpenCode)", 2, [LOW, MEDIUM, HIGH]),
    catalogModel("moonshot/kimi-k3", "Kimi K3", 2),
    catalogModel("zai/glm-5", "GLM-5", 1),
  ],
  pi: [catalogModel("default", "Pi (BYO model)", 2)],
  muse: [catalogModel("default", "Muse Auto", 2)],
  fx: [catalogModel("default", "fx Auto", 2)],
  acpRegistry: [catalogModel("default", "Mystery Agent", 2)],
};

function modelTierFromName(name: string): 1 | 2 | 3 {
  const lower = name.toLowerCase();
  if (/haiku|luna|mini|nano|spark|flash|lite|fast|small/.test(lower)) return 1;
  if (/opus|astra|argon|\bsol\b|ultra|\bmax\b|\bpro\b|4\.6/.test(lower)) return 3;
  return 2;
}

function effortTierFromId(id: string): SlotTier {
  const lower = id.toLowerCase();
  if (/^(none|minimal|low|off)$/.test(lower)) return 0;
  if (/^(medium|med|default|normal)$/.test(lower)) return 1;
  if (/^(high)$/.test(lower)) return 2;
  if (/^(xhigh|max|ultra|extra)/.test(lower)) return 3;
  return 1;
}

function slotModelFromServer(model: ServerProviderModel): SlotModel {
  const descriptor = model.capabilities?.optionDescriptors?.find(
    (candidate) =>
      candidate.type === "select" && REASONING_EFFORT_OPTION_IDS.includes(candidate.id),
  );
  const efforts: SlotEffort[] =
    descriptor?.type === "select"
      ? descriptor.options
          // Prompt-injected values (ultrathink) live in the prompt, not in model options.
          .filter((option) => !descriptor.promptInjectedValues?.includes(option.id))
          .map((option) => ({
            id: option.id,
            label: option.label,
            tier: effortTierFromId(option.id),
          }))
      : [];
  return {
    slug: model.slug,
    name: model.shortName ?? model.name,
    tier: modelTierFromName(`${model.slug} ${model.name}`),
    effortOptionId: descriptor && efforts.length > 0 ? descriptor.id : null,
    efforts: efforts.length > 0 ? efforts : [VIBES],
  };
}

export function buildSlotProviders(
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>,
): ReadonlyArray<SlotProvider> {
  return SLOT_DRIVER_ORDER.map((driverKind) => {
    const entry =
      instanceEntries.find(
        (candidate) =>
          candidate.driverKind === driverKind &&
          // The dev-only Replay fixture's "models" are test scenarios, not models.
          candidate.instanceId !== "devReplay" &&
          isProviderInstancePickerReady(candidate) &&
          candidate.models.length > 0,
      ) ?? null;
    const liveModels = entry?.models.filter((model) => !model.isLegacy).map(slotModelFromServer);
    return {
      driverKind,
      displayName: entry?.displayName ?? PROVIDER_DISPLAY_NAMES[driverKind] ?? driverKind,
      instanceId: entry?.instanceId ?? null,
      entry,
      models: liveModels && liveModels.length > 0 ? liveModels : (STATIC_CATALOG[driverKind] ?? []),
    };
  }).filter((provider) => provider.models.length > 0);
}

export function payoutTierForScore(score: number): PayoutTier {
  if (score >= 6) return "jackpot";
  if (score === 5) return "mega";
  if (score === 4) return "big";
  if (score === 3) return "win";
  return "slop";
}

export const PAYOUT_BY_TIER: Record<PayoutTier, number> = {
  slop: 10_000,
  win: 40_000,
  big: 150_000,
  mega: 280_000,
  jackpot: 800_000,
};

const AGI_PAYOUT = 3_000_000;

/** Tier is decided first, then symbols, the way real machines map a virtual reel. ~91% RTP. */
// BIG is a little rarer than it would be on its own, paying for the rigged Fable pulls.
const TIER_WEIGHTS: ReadonlyArray<readonly [PayoutTier, number]> = [
  ["slop", 48],
  ["win", 30],
  ["big", 12],
  ["mega", 7],
  ["jackpot", 3],
];

export const SPIN_COST = 100_000;
export const START_CREDITS = 1_000_000;
const FAKE_OUT_CHANCE = 0.15;
/** One pull in ten is rigged toward Fable 5.2 at High, so everyone gets to try it. */
const FEATURED_CHANCE = 0.1;
const NEAR_MISS_CHANCE = 0.35;
const BENCHMAXXED_CHANCE = 0.3;
const AGI_CHANCE_PER_JACKPOT = 0.12;
const RATE_LIMIT_CHANCE = 0.05;
const UPGRADE_CHANCE = 0.3;
const UPGRADE_BONUS = 0.25;

const pick = <T>(items: ReadonlyArray<T>, random: () => number): T =>
  items[Math.min(items.length - 1, Math.floor(random() * items.length))]!;

export function isJesterDriver(driverKind: ProviderDriverKind): boolean {
  return driverKind === "antigravity";
}

export function isJesterModel(driverKind: ProviderDriverKind, model: SlotModel): boolean {
  return isJesterDriver(driverKind) || /gemini/i.test(`${model.slug} ${model.name}`);
}

export function rollSlotOutcome(
  providers: ReadonlyArray<SlotProvider>,
  random: () => number = Math.random,
): SlotOutcome {
  const combos = providers.flatMap((provider) =>
    provider.models.flatMap((model) =>
      model.efforts.map((effort) => ({
        provider,
        model,
        effort,
        tier: payoutTierForScore(model.tier + effort.tier),
      })),
    ),
  );
  const featured = combos.find(
    (combo) =>
      combo.provider.driverKind === "claudeAgent" &&
      /fable[-\s]?5[.-]2/i.test(`${combo.model.slug} ${combo.model.name}`) &&
      combo.effort.id === "high",
  );
  const featuredPull = featured !== undefined && random() < FEATURED_CHANCE;
  const available = TIER_WEIGHTS.filter(([tier]) => combos.some((combo) => combo.tier === tier));
  const totalWeight = available.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * totalWeight;
  let tier = available[0]?.[0] ?? "slop";
  for (const [candidate, weight] of available) {
    roll -= weight;
    if (roll < 0) {
      tier = candidate;
      break;
    }
  }
  if (featuredPull) tier = featured.tier;
  const tierCombos = combos.filter((combo) => combo.tier === tier);
  // Pick the provider before the combo so chatty catalogs don't crowd out the rest, and favor
  // installed providers so most pulls pay out something collectable.
  const provider = pick(
    [...new Set(tierCombos.map((combo) => combo.provider))].flatMap((candidate) =>
      candidate.instanceId ? [candidate, candidate, candidate] : [candidate],
    ),
    random,
  );
  const combo = featuredPull
    ? featured
    : pick(
        tierCombos.filter((candidate) => candidate.provider === provider),
        random,
      );
  // A near miss only teases a symbol that really would have completed a jackpot line.
  const teaseEffort =
    combo.model.tier === 3 && combo.effort.tier < 3
      ? (combo.model.efforts.find((effort) => effort.tier === 3) ?? null)
      : null;
  const teaseModel =
    !teaseEffort && combo.effort.tier === 3 && combo.model.tier < 3
      ? (combo.provider.models.find(
          (model) => model.tier === 3 && model.efforts.some((effort) => effort.tier === 3),
        ) ?? null)
      : null;
  const nearMiss = tier !== "jackpot" && (teaseEffort || teaseModel) && random() < NEAR_MISS_CHANCE;
  const nearMissReel = nearMiss ? (teaseEffort ? 2 : 1) : null;
  const variant = jackpotVariant(tier, random);
  return {
    ...combo,
    sponsored: featuredPull,
    payout: variant.agi ? AGI_PAYOUT : PAYOUT_BY_TIER[tier],
    jester: isJesterModel(combo.provider.driverKind, combo.model),
    nearMissReel,
    teaseModel: nearMissReel === 1 ? teaseModel : null,
    teaseEffort: nearMissReel === 2 ? teaseEffort : null,
    anticipation: tier === "jackpot" || nearMissReel === 2 || random() < FAKE_OUT_CHANCE,
    ...variant,
    quipSeed: Math.floor(random() * 1000),
    rateLimited: tier !== "jackpot" && random() < RATE_LIMIT_CHANCE,
    upgradeBonus:
      (tier === "big" || tier === "mega" || tier === "jackpot") && random() < UPGRADE_CHANCE
        ? Math.round((variant.agi ? AGI_PAYOUT : PAYOUT_BY_TIER[tier]) * UPGRADE_BONUS)
        : 0,
  };
}

function jackpotVariant(tier: PayoutTier, random: () => number) {
  if (tier !== "jackpot") return { agi: false, benchmaxxed: false };
  const roll = random();
  return {
    agi: roll < AGI_CHANCE_PER_JACKPOT,
    benchmaxxed:
      roll >= AGI_CHANCE_PER_JACKPOT && roll < AGI_CHANCE_PER_JACKPOT + BENCHMAXXED_CHANCE,
  };
}

/** Rumored models that only ever appear mid-spin, never on the payline. */
export const RUMORED_MODEL_NAMES: ReadonlyArray<string> = [
  "GPT-5.1-codex-mini-high-preview-0915",
  "Gemini 3 Ultra (in 2 weeks)",
  "Opus 5.5 (New) (Final) (2)",
  "o7-pro-max-lite",
  "Grok 6 (Elon said Tuesday)",
];

export function mergeEffortSelection(
  current: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  optionId: string,
  value: string,
): ReadonlyArray<ProviderOptionSelection> {
  return [
    ...(current ?? []).filter((selection) => selection.id !== optionId),
    { id: optionId, value },
  ];
}

export function slotHeadline(outcome: SlotOutcome, installed: boolean): string {
  if (outcome.jester) return "GEMINI’D";
  if (!installed) return "FREE SPIN";
  if (outcome.sponsored) return "SPONSORED PULL";
  if (outcome.agi) return "AGI ACHIEVED";
  if (outcome.benchmaxxed) return "BENCHMAXXED";
  if (outcome.nearMissReel !== null && (outcome.tier === "slop" || outcome.tier === "win"))
    return "SO CLOSE";
  switch (outcome.tier) {
    case "jackpot":
      return "JACKPOT";
    case "mega":
      return "MEGA WIN";
    case "big":
      return "BIG WIN";
    case "win":
      return "WINNER";
    case "slop":
      return "SLOP";
  }
}

const choose = (seed: number, lines: ReadonlyArray<string>) => lines[seed % lines.length]!;

export function slotQuip(outcome: SlotOutcome, installed: boolean): string {
  const { provider, model, effort, tier, quipSeed: seed } = outcome;
  if (outcome.jester && !installed)
    return `${provider.displayName} isn't installed. The jester paid you in vibes. Next pull is free.`;
  if (outcome.jester)
    return choose(seed, [
      "Confidently wrong at a 1M context window.",
      "Gemini read your whole repo and still paid the wrong amount.",
      "Benchmarks said jackpot. The jester keeps half.",
    ]);
  if (installed && outcome.sponsored)
    return choose(seed, [
      "Brought to you by Anthropic. (It wasn't. Probably.)",
      "Paid placement. Results not typical.",
      "Benchmark run by vendor.",
    ]);
  if (!installed) return `${provider.displayName} isn't set up here. Next pull is on the house.`;
  if (outcome.agi) return `AGI achieved internally. You get ${model.name}.`;
  if (outcome.benchmaxxed) return "Initial results were not reproducible.";
  if (outcome.nearMissReel === 2 && outcome.teaseEffort)
    return `${outcome.teaseEffort.label} was right there. So was your rate limit.`;
  if (outcome.nearMissReel === 1 && outcome.teaseModel)
    return `${outcome.teaseModel.name} was right there. The reel chose violence.`;
  if (provider.driverKind === "grok") return "It wrote the code, then posted about it.";
  if (provider.driverKind === "cursor")
    return model.slug === "auto"
      ? "A model that picks a model. Bold."
      : "Pricing changed twice while the reels spun.";
  if (provider.driverKind === "acpRegistry") return "Probably a wrapper. Probably fine.";
  if (provider.driverKind === "pi") return "A truly irrational choice.";
  if (provider.driverKind === "opencode") return "Open weights, open wallet.";
  if (provider.driverKind === "muse" || provider.driverKind === "fx")
    return "Indie darling. You'll be first to tweet about it.";
  if (tier === "jackpot")
    return provider.driverKind === "claudeAgent"
      ? `${model.name} at ${effort.label}. Your usage limit felt a disturbance.`
      : `${model.name} at ${effort.label}. Credits arriving in the coming weeks.`;
  if (tier === "mega")
    return choose(seed, ["The benchmarks fear you.", "Someone at the lab will nerf this."]);
  if (tier === "big")
    return choose(seed, [
      "Ship it before the rate limit notices.",
      "A real model, with real thinking.",
    ]);
  if (tier === "win") return "You won 40K. You paid 100K.";
  return choose(seed, ["Certified slop. Ship it anyway.", "Skill issue. Pull again."]);
}

/** A rubber stamp slammed across the reels: the visual punchline for the outcome. */
export function slotStamp(outcome: SlotOutcome, installed: boolean): string | null {
  const { provider, model, tier } = outcome;
  if (outcome.jester) return "HALLUCINATED";
  if (!installed) return "NOT INSTALLED";
  if (outcome.sponsored) return "#ad";
  if (outcome.agi) return "INTERNALLY";
  if (outcome.benchmaxxed) return "NOT REPRODUCIBLE";
  if (outcome.nearMissReel !== null) return "ONE ROW AWAY";
  if (provider.driverKind === "cursor" && model.slug === "auto") return "PICKED BY ANOTHER MODEL";
  if (provider.driverKind === "cursor") return "PRICING UPDATED";
  if (provider.driverKind === "grok") return "COMMUNITY NOTED";
  if (provider.driverKind === "opencode") return "PROVIDER: ???";
  if (provider.driverKind === "acpRegistry") return "PROBABLY A WRAPPER";
  if (provider.driverKind === "claudeAgent" && (tier === "jackpot" || tier === "mega"))
    return "USAGE LIMIT APPROACHING";
  if (provider.driverKind === "codex" && (tier === "jackpot" || tier === "mega"))
    return "SHIPPING IN THE COMING WEEKS";
  if (tier === "slop") return outcome.quipSeed % 2 === 0 ? "VIBE CODED" : "LGTM 👍";
  return null;
}

/** Every provider/model/effort combination the reels can land, for the collection meter. */
export function slotComboKeys(providers: ReadonlyArray<SlotProvider>): ReadonlyArray<string> {
  return providers.flatMap((provider) =>
    provider.models.flatMap((model) =>
      model.efforts.map((effort) => `${provider.driverKind}:${model.slug}:${effort.label}`),
    ),
  );
}

export function slotComboKey(outcome: SlotOutcome): string {
  return `${outcome.provider.driverKind}:${outcome.model.slug}:${outcome.effort.label}`;
}
