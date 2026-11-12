import { describe, expect, it } from "vite-plus/test";

import {
  SLOT_DRIVER_ORDER,
  buildSlotProviders,
  mergeEffortSelection,
  SPIN_COST,
  payoutTierForScore,
  rollSlotOutcome,
} from "./slotMachineLogic";

const seeded = (seed: number) => () => {
  seed = (seed * 1_664_525 + 1_013_904_223) % 2 ** 32;
  return seed / 2 ** 32;
};

const sequence = (...values: number[]) => {
  let index = 0;
  return () => values[index++ % values.length]!;
};

describe("slot machine logic", () => {
  it("puts every provider on the reel even when none are installed", () => {
    const providers = buildSlotProviders([]);
    expect(providers.map((provider) => provider.driverKind)).toEqual(SLOT_DRIVER_ORDER);
    expect(providers.every((provider) => provider.instanceId === null)).toBe(true);
  });

  it("lands on a combo whose symbols score the rolled tier", () => {
    const providers = buildSlotProviders([]);
    for (const roll of [0, 0.3, 0.6, 0.85, 0.99]) {
      const outcome = rollSlotOutcome(providers, sequence(roll, 0.5, 0.5, 0.9));
      expect(payoutTierForScore(outcome.model.tier + outcome.effort.tier)).toBe(outcome.tier);
      expect(outcome.model.efforts).toContain(outcome.effort);
    }
  });

  it("rigs one pull in ten to Fable 5.2 at High", () => {
    const providers = buildSlotProviders([]);
    const featured = rollSlotOutcome(providers, sequence(0.05, 0.99, 0.5, 0.5, 0.9));
    expect([featured.model.name, featured.effort.id, featured.sponsored]).toEqual([
      "Fable 5.2",
      "high",
      true,
    ]);
    expect(payoutTierForScore(featured.model.tier + featured.effort.tier)).toBe(featured.tier);
    for (const providerRoll of [0, 0.5, 0.99]) {
      const outcome = rollSlotOutcome(providers, sequence(0.05, 0.99, providerRoll, 0.5, 0.9));
      expect(outcome.jester).toBe(false);
    }
    const random = seeded(3);
    let hits = 0;
    for (let index = 0; index < 5000; index++) {
      const outcome = rollSlotOutcome(providers, random);
      if (outcome.model.name === "Fable 5.2" && outcome.effort.id === "high") hits++;
    }
    expect(hits / 5000).toBeGreaterThan(0.09);
    expect(hits / 5000).toBeLessThan(0.13);
  });

  it("only near-misses with a symbol that would have completed a jackpot", () => {
    const providers = buildSlotProviders([]);
    const random = seeded(7);
    let nearMisses = 0;
    for (let index = 0; index < 4000; index++) {
      const outcome = rollSlotOutcome(providers, random);
      if (outcome.nearMissReel === null) continue;
      nearMisses++;
      const teaseScore =
        outcome.nearMissReel === 2
          ? outcome.model.tier + outcome.teaseEffort!.tier
          : outcome.teaseModel!.tier + outcome.effort.tier;
      expect(payoutTierForScore(teaseScore)).toBe("jackpot");
      expect(outcome.tier).not.toBe("jackpot");
    }
    expect(nearMisses).toBeGreaterThan(0);
  });

  it("keeps the house edge: average payout stays below the pull cost", () => {
    const providers = buildSlotProviders([]);
    const random = seeded(42);
    let total = 0;
    const pulls = 20_000;
    for (let index = 0; index < pulls; index++) {
      const outcome = rollSlotOutcome(providers, random);
      total += outcome.payout + outcome.upgradeBonus;
    }
    expect(total / pulls).toBeLessThan(SPIN_COST);
    expect(total / pulls).toBeGreaterThan(SPIN_COST * 0.8);
  });

  it("replaces only the effort option when collecting", () => {
    expect(
      mergeEffortSelection(
        [
          { id: "fastMode", value: true },
          { id: "effort", value: "low" },
        ],
        "effort",
        "max",
      ),
    ).toEqual([
      { id: "fastMode", value: true },
      { id: "effort", value: "max" },
    ]);
  });
});
