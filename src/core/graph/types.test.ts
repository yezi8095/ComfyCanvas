import { describe, expect, it } from "vitest";

import { canConnectPortKinds, type PortDataKind } from "./types";

describe("canConnectPortKinds", () => {
  it.each<PortDataKind>(["text", "image", "video", "audio", "latent", "workflow", "any"])(
    "connects matching %s ports",
    (kind) => {
      expect(canConnectPortKinds(kind, kind)).toBe(true);
    },
  );

  it.each<[PortDataKind, PortDataKind]>([
    ["any", "image"],
    ["video", "any"],
    ["any", "any"],
  ])("treats any as a wildcard for %s -> %s", (source, target) => {
    expect(canConnectPortKinds(source, target)).toBe(true);
  });

  it.each<[PortDataKind, PortDataKind]>([
    ["text", "image"],
    ["image", "video"],
    ["audio", "latent"],
    ["workflow", "text"],
  ])("rejects incompatible %s -> %s ports", (source, target) => {
    expect(canConnectPortKinds(source, target)).toBe(false);
  });
});
