import { useState } from "react";
import { createRoot } from "react-dom/client";

import type { ProviderInstanceEntry } from "~/providerInstances";
import SlotMachine from "~/components/chat/slotMachine/SlotMachine";
import { buildSlotProviders } from "~/components/chat/slotMachine/slotMachineLogic";
import "./styles.css";

// Every provider counts as installed here, built from the machine's own static catalog.
const instanceEntries = buildSlotProviders([]).map(
  (provider) =>
    ({
      instanceId: provider.driverKind,
      driverKind: provider.driverKind,
      displayName: provider.displayName,
      enabled: true,
      installed: true,
      isAvailable: true,
      isDefault: false,
      status: "ready",
      snapshot: {},
      models: provider.models.map((model) => ({
        slug: model.slug,
        name: model.name,
        isLegacy: false,
        capabilities: {
          optionDescriptors: model.efforts.some((effort) => effort.id !== null)
            ? [
                {
                  type: "select",
                  id: model.effortOptionId ?? "reasoningEffort",
                  label: "Effort",
                  options: model.efforts.map((effort) => ({ id: effort.id, label: effort.label })),
                },
              ]
            : [],
        },
      })),
    }) as unknown as ProviderInstanceEntry,
);

function App() {
  const [open, setOpen] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center text-neutral-200">
      {open ? (
        <SlotMachine
          instanceEntries={instanceEntries}
          onClose={() => setOpen(false)}
          onCollect={(selection) => {
            setPicked(
              `${selection.model}${selection.effortValue ? ` · ${selection.effortValue}` : ""}`,
            );
            setOpen(false);
          }}
        />
      ) : null}
      <p className="text-sm text-neutral-400">
        {picked ? `You collected ${picked}.` : "The house always wins."}
      </p>
      <button
        type="button"
        className="rounded-md bg-red-600 px-4 py-2 font-semibold text-white hover:bg-red-500"
        onClick={() => setOpen(true)}
      >
        Pull again
      </button>
      <a className="text-xs text-neutral-500 underline" href="https://t3.codes">
        From T3 Code
      </a>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
