import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../config/index.js";
import { offlineMaintenanceConfig } from "./offline-setup.js";

describe("offlineMaintenanceConfig", () => {
  it("returns the shared config unchanged when no offline model is configured", () => {
    expect(DEFAULT_CONFIG.anthropic.models.offline).toBeUndefined();
    expect(offlineMaintenanceConfig(DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG);
  });

  it("points the background and extraction roles at the offline model", () => {
    const shared = {
      ...DEFAULT_CONFIG,
      anthropic: {
        ...DEFAULT_CONFIG.anthropic,
        models: {
          ...DEFAULT_CONFIG.anthropic.models,
          cognition: "claude-opus-5",
          background: "claude-opus-5",
          extraction: "claude-opus-5",
          offline: "claude-sonnet-5",
        },
      },
    };

    const offline = offlineMaintenanceConfig(shared);

    expect(offline.anthropic.models.background).toBe("claude-sonnet-5");
    expect(offline.anthropic.models.extraction).toBe("claude-sonnet-5");
    // Roles the offline processes do not route through the slot keep their models.
    expect(offline.anthropic.models.cognition).toBe("claude-opus-5");
    expect(offline.anthropic.models.recallExpansion).toBe(
      DEFAULT_CONFIG.anthropic.models.recallExpansion,
    );
    // Live turns read the shared config, which must not change.
    expect(shared.anthropic.models.background).toBe("claude-opus-5");
    expect(shared.anthropic.models.extraction).toBe("claude-opus-5");
  });
});
