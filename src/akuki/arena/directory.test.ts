import { describe, expect, it } from "vitest";

import { PrincipalDirectory, unknownPrincipalName } from "./directory.js";

function source(
  principals: readonly { id: string; name: string }[],
  onCall?: () => void,
): { calls: number; listPrincipals: () => Promise<readonly { id: string; name: string }[]> } {
  const state = {
    calls: 0,
    listPrincipals: async () => {
      state.calls += 1;
      onCall?.();
      return principals;
    },
  };
  return state;
}

describe("PrincipalDirectory", () => {
  it("resolves a name and then answers from cache", async () => {
    const backing = source([{ id: "u1", name: "Zosia" }]);
    const directory = new PrincipalDirectory(backing);

    expect(await directory.nameOf("u1")).toBe("Zosia");
    expect(await directory.nameOf("u1")).toBe("Zosia");
    expect(backing.calls).toBe(1);
  });

  it("returns a visibly synthetic name for an id the directory does not have", async () => {
    const backing = source([]);
    const directory = new PrincipalDirectory(backing);

    expect(await directory.nameOf("u-missing-and-long")).toBe(unknownPrincipalName("u-missing-and-long"));
    expect(await directory.nameOf("u-missing-and-long")).toBe("unknown:u-missin");
  });

  it("refreshes at most once per cooldown, so a permanently missing id is cheap", async () => {
    let now = 1_000;
    const backing = source([]);
    const directory = new PrincipalDirectory(backing, () => now);

    await directory.nameOf("gone");
    await directory.nameOf("gone");
    await directory.nameOf("also-gone");
    expect(backing.calls).toBe(1);

    now += 60_001;
    await directory.nameOf("gone");
    expect(backing.calls).toBe(2);
  });

  it("degrades to an unknown name instead of failing the message when lookup errors", async () => {
    const backing = {
      listPrincipals: async () => {
        throw new Error("arena unreachable");
      },
    };
    const directory = new PrincipalDirectory(backing);

    await expect(directory.nameOf("u1")).resolves.toBe(unknownPrincipalName("u1"));
  });

  it("ignores entries with a blank id or name rather than caching a useless label", async () => {
    let now = 0;
    const backing = source([
      { id: "", name: "nameless id" },
      { id: "u2", name: "" },
      { id: "u3", name: "Tomek" },
    ]);
    const directory = new PrincipalDirectory(backing, () => now);

    expect(await directory.nameOf("u3")).toBe("Tomek");
    now += 60_001;
    expect(await directory.nameOf("u2")).toBe(unknownPrincipalName("u2"));
  });
});
