import { describe, expect, it } from "vitest";
import { chooseCompatibleModel } from "./modelSelection";

describe("capability-safe model selection", () => {
  it("does not insert a mismatched provider default", () => {
    expect(chooseCompatibleModel(["wan2.6-t2v"], "deepseek-v4-flash")).toBe("wan2.6-t2v");
  });

  it("leaves the node unconfigured when no compatible model exists", () => {
    expect(chooseCompatibleModel([], "deepseek-v4-flash")).toBe("");
  });

  it("keeps a preferred model only when it is compatible", () => {
    expect(chooseCompatibleModel(["wan2.6-t2v", "wan2.6-i2v-flash"], "wan2.6-i2v-flash")).toBe("wan2.6-i2v-flash");
  });
});
