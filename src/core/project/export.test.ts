import { describe, expect, it } from "vitest";

import { redactProjectSecrets } from "./export";

describe("project export credential redaction", () => {
  it("removes nested provider credentials while preserving runnable configuration", () => {
    const project = {
      nodes: [{
        id: "image",
        workflow: {
          endpoint: "https://api.example.com/v1",
          model: "image-model",
          apiKey: "do-not-export",
          api_secret: "also-secret",
          nested: { accessToken: "session-token", token: "custom-workflow-token", prompt: "a rainy street" },
        },
      }],
    };
    const result = redactProjectSecrets(project);

    expect(result.value).toEqual({
      nodes: [{
        id: "image",
        workflow: {
          endpoint: "https://api.example.com/v1",
          model: "image-model",
          nested: { prompt: "a rainy street" },
        },
      }],
    });
    expect(result.redactedPaths).toEqual([
      "nodes[0].workflow.apiKey",
      "nodes[0].workflow.api_secret",
      "nodes[0].workflow.nested.accessToken",
      "nodes[0].workflow.nested.token",
    ]);
    expect(project.nodes[0].workflow.apiKey).toBe("do-not-export");
  });

  it("keeps ordinary wording and only removes credential-shaped keys", () => {
    const result = redactProjectSecrets({
      prompt: "describe a secret garden",
      secretGarden: "allowed label",
      tokenCount: 1024,
      values: [{ password: "private" }, { value: "safe" }],
    });

    expect(result.value).toEqual({
      prompt: "describe a secret garden",
      secretGarden: "allowed label",
      tokenCount: 1024,
      values: [{}, { value: "safe" }],
    });
    expect(result.redactedPaths).toEqual(["values[0].password"]);
  });
});
