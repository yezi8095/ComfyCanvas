import { describe, expect, it } from "vitest";
import {
  bindCanvasInputsToComfyWorkflow,
  collectComfyHistoryMedia,
  discoverComfyOutputTargets,
  discoverComfyPromptBindings,
  prepareComfyVisualOutput,
  scanComfyWorkflowInterface,
  selectComfyHistoryMedia,
  validateComfyWorkflow,
} from "./ComfyWorkflowParameters";

describe("ComfyUI live-schema binding", () => {
  it("writes an uploaded filename into the real LoadImage COMBO field", () => {
    const graph = {
      "1": { class_type: "LoadImage", inputs: { image: "old.png", upload: "image" } },
      "2": { class_type: "PreviewImage", inputs: { images: ["1", 0] } },
    };
    const objectInfo = {
      LoadImage: {
        input: { required: { image: [["old.png"], { image_upload: true }] } },
        output: ["IMAGE", "MASK"],
        output_name: ["IMAGE", "MASK"],
      },
      PreviewImage: {
        input: { required: { images: ["IMAGE", { forceInput: true }] } },
        output: [],
        output_node: true,
      },
    };

    const result = bindCanvasInputsToComfyWorkflow(graph, { image: ["canvas-reference.png"] }, objectInfo);
    expect(result.graph["1"].inputs?.image).toBe("canvas-reference.png");
    expect(result.bindings).toEqual([{ kind: "image", nodeId: "1", input: "image" }]);
    expect(result.interface.nodes["1"].inputs[0]).toMatchObject({ type: "COMBO", choices: ["old.png"] });
  });

  it("injects the node's own prompt using current object_info", () => {
    const graph = {
      "1": { class_type: "CLIPTextEncode", inputs: { text: "old positive", clip: ["2", 0] } },
      "2": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model.safetensors" } },
    };
    const objectInfo = {
      CLIPTextEncode: {
        input: { required: { text: ["STRING", { multiline: true, default: "" }], clip: ["CLIP", { forceInput: true }] } },
        output: ["CONDITIONING"],
      },
      CheckpointLoaderSimple: { input: { required: {} }, output: ["CLIP"] },
    };

    const result = bindCanvasInputsToComfyWorkflow(graph, { text: "女生在雨夜起舞" }, objectInfo);
    expect(result.graph["1"].inputs?.text).toBe("女生在雨夜起舞");
    expect(result.diagnostics.some((item) => item.message.includes("正向提示词"))).toBe(true);
  });

  it("injects a live STRING prompt slot even when the API JSON omitted its default value", () => {
    const graph = {
      encode: { class_type: "LivePromptEncoder", inputs: { clip: ["model", 0] } },
      model: { class_type: "Model", inputs: {} },
    };
    const objectInfo = {
      LivePromptEncoder: {
        input: { required: { text: ["STRING", { multiline: true, default: "" }], clip: ["CLIP", { forceInput: true }] } },
        output: ["CONDITIONING"],
      },
      Model: { input: { required: {} }, output: ["CLIP"] },
    };

    const result = bindCanvasInputsToComfyWorkflow(graph, { text: "从真实 STRING 槽写入" }, objectInfo);
    expect(result.graph.encode.inputs?.text).toBe("从真实 STRING 槽写入");
    expect(result.bindings).toContainEqual({ kind: "text", nodeId: "encode", input: "text" });
  });

  it("does not silently choose a prompt slot when live branches are tied", () => {
    const graph = {
      left: { class_type: "Prompt", inputs: { text: "left" } },
      right: { class_type: "Prompt", inputs: { text: "right" } },
    };
    const objectInfo = {
      Prompt: { input: { required: { text: ["STRING", { default: "" }] } }, output: ["CONDITIONING"] },
    };

    const discovered = discoverComfyPromptBindings(graph, objectInfo);
    const result = bindCanvasInputsToComfyWorkflow(graph, { text: "不应静默落到任一边" }, objectInfo);
    expect(discovered.bindings).toEqual([]);
    expect(discovered.diagnostic).toMatchObject({ level: "error", code: "prompt-slot-ambiguous" });
    expect(result.graph.left.inputs?.text).toBe("left");
    expect(result.graph.right.inputs?.text).toBe("right");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ level: "error", code: "prompt-slot-ambiguous" }));
  });

  it("does not overwrite an ambiguous media loader field", () => {
    const graph = {
      loader: { class_type: "AmbiguousImageLoader", inputs: { first: "old-a.png", second: "old-b.png" } },
    };
    const objectInfo = {
      AmbiguousImageLoader: {
        input: { required: { first: [["old-a.png"], { image_upload: true }], second: [["old-b.png"], { image_upload: true }] } },
        output: ["IMAGE"],
      },
    };

    const result = bindCanvasInputsToComfyWorkflow(graph, { image: ["canvas.png"] }, objectInfo);
    expect(result.graph.loader.inputs).toEqual({ first: "old-a.png", second: "old-b.png" });
    expect(result.bindings).toEqual([]);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "media-loader-ambiguous", nodeId: "loader" }),
    ]));
    expect(result.validationDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing-media-output", level: "error" }),
    ]));
  });

  it("does not write an unmarked COMBO merely because a node outputs IMAGE", () => {
    const graph = {
      loader: { class_type: "UnmarkedComboNode", inputs: { checkpoint: "model.safetensors" } },
      save: { class_type: "SaveImage", inputs: { images: ["loader", 0] } },
    };
    const objectInfo = {
      UnmarkedComboNode: {
        input: { required: { checkpoint: [["model.safetensors"], {}] } },
        output: ["IMAGE"],
      },
      SaveImage: { input: { required: { images: ["IMAGE", { forceInput: true }] } }, output: [], output_node: true },
    };

    const result = bindCanvasInputsToComfyWorkflow(graph, { image: ["canvas-reference.png"] }, objectInfo);
    expect(result.graph.loader.inputs?.checkpoint).toBe("model.safetensors");
    expect(result.bindings).not.toContainEqual(expect.objectContaining({ kind: "image" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ level: "error", code: "media-loader-unbound" }));
  });
});

describe("ComfyUI live-schema contracts", () => {
  it("reads image, video, audio, text and latent slot types directly from current object_info", () => {
    const graph = {
      source: { class_type: "AllKindsSource", inputs: {} },
      sink: {
        class_type: "AllKindsSink",
        inputs: {
          image: ["source", 0],
          video: ["source", 1],
          audio: ["source", 2],
          text: ["source", 3],
          latent: ["source", 4],
        },
      },
      save: { class_type: "SaveImage", inputs: { images: ["source", 0] } },
    };
    const objectInfo = {
      AllKindsSource: { input: { required: {} }, output: ["IMAGE", "VIDEO", "AUDIO", "STRING", "LATENT"] },
      AllKindsSink: {
        input: { required: {
          image: ["IMAGE", { forceInput: true }],
          video: ["VIDEO", { forceInput: true }],
          audio: ["AUDIO", { forceInput: true }],
          text: ["STRING", { forceInput: true }],
          latent: ["LATENT", { forceInput: true }],
        } },
        output: [],
      },
      SaveImage: { input: { required: { images: ["IMAGE", { forceInput: true }] } }, output: [], output_node: true },
    };

    const iface = scanComfyWorkflowInterface(graph, objectInfo);
    expect(iface.nodes.source.outputs.map((slot) => slot.type)).toEqual(["IMAGE", "VIDEO", "AUDIO", "STRING", "LATENT"]);
    expect(iface.nodes.sink.inputs.map((slot) => slot.type)).toEqual(["IMAGE", "VIDEO", "AUDIO", "STRING", "LATENT"]);
    expect(validateComfyWorkflow(graph, objectInfo).diagnostics.some((item) => item.code === "slot-type-mismatch")).toBe(false);
  });

  it("does not guess a VAE/image branch for an unconnected real output", () => {
    const graph = {
      "vae-a": { class_type: "AnyDecoder", inputs: {} },
      "vae-b": { class_type: "AnotherDecoder", inputs: {} },
      save: { class_type: "VHS_VideoCombine", inputs: { images: null } },
    };
    const objectInfo = {
      AnyDecoder: { input: { required: {} }, output: ["IMAGE"] },
      AnotherDecoder: { input: { required: {} }, output: ["IMAGE"] },
      VHS_VideoCombine: {
        input: { required: { images: ["IMAGE", { forceInput: true }] } },
        output: ["VHS_FILENAMES"],
        output_node: true,
      },
    };

    const prepared = prepareComfyVisualOutput(graph, objectInfo);
    const checked = validateComfyWorkflow(prepared.graph, objectInfo);

    expect(prepared.graph.save.inputs?.images).toBeNull();
    expect(prepared.outputTargets).toEqual(["save"]);
    expect(checked.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "output-media-input-missing", nodeId: "save", input: "images", expectedType: "IMAGE" }),
    ]));
    expect(checked.diagnostics.some((item) => item.message.includes("已按 IMAGE 类型"))).toBe(false);
  });

  it("uses only actual output nodes, not an IMAGE decoder or a save-like class name", () => {
    const graph = {
      decode: { class_type: "VAEDecode", inputs: {} },
      misleading: { class_type: "SaveLikeImageProcessor", inputs: { image: ["decode", 0] } },
      output: { class_type: "CustomMovieSaver", inputs: { frames: ["decode", 0] } },
    };
    const objectInfo = {
      VAEDecode: { input: { required: {} }, output: ["IMAGE"] },
      SaveLikeImageProcessor: { input: { required: { image: ["IMAGE", { forceInput: true }] } }, output: ["IMAGE"] },
      CustomMovieSaver: {
        input: { required: { frames: ["IMAGE", { forceInput: true }] } },
        output: [],
        output_node: true,
      },
    };

    const discovered = discoverComfyOutputTargets(graph, objectInfo);
    expect(discovered.targets).toEqual([
      expect.objectContaining({ nodeId: "output", declaredBySchema: true }),
    ]);
  });

  it("does not trust a familiar saver class when the live schema no longer declares an output node", () => {
    const graph = {
      source: { class_type: "Source", inputs: {} },
      save: { class_type: "SaveImage", inputs: { images: ["source", 0] } },
    };
    const objectInfo = {
      Source: { input: { required: {} }, output: ["IMAGE"] },
      SaveImage: { input: { required: { images: ["IMAGE", { forceInput: true }] } }, output: [] },
    };

    expect(discoverComfyOutputTargets(graph, objectInfo).targets).toEqual([]);
    expect(validateComfyWorkflow(graph, objectInfo).diagnostics).toContainEqual(
      expect.objectContaining({ level: "error", code: "missing-media-output" }),
    );
  });

  it("returns media only from verified output nodes and preserves independent final saver groups", () => {
    const media = collectComfyHistoryMedia({
      preview: { images: [{ filename: "wrong-branch.png" }] },
      imageSaver: { images: [{ filename: "final.png" }] },
      videoSaver: { gifs: [{ filename: "combined.mp4" }] },
      audioSaver: { audio: [{ filename: "voice.wav" }] },
    }, ["imageSaver", "videoSaver", "audioSaver"]);

    expect(media).toEqual([
      expect.objectContaining({ outputNodeId: "imageSaver", kind: "image", file: { filename: "final.png" } }),
      expect.objectContaining({ outputNodeId: "videoSaver", kind: "video", file: { filename: "combined.mp4" } }),
      expect.objectContaining({ outputNodeId: "audioSaver", kind: "audio", file: { filename: "voice.wav" } }),
    ]);
  });

  it("renders a custom saver MP4 as video even when ComfyUI places it in images", () => {
    const media = collectComfyHistoryMedia({
      minimaxSaver: { images: [{ filename: "MiniMax_H3_00004_.mp4" }] },
    }, ["minimaxSaver"]);

    expect(media).toEqual([
      expect.objectContaining({ outputNodeId: "minimaxSaver", kind: "video", file: { filename: "MiniMax_H3_00004_.mp4" } }),
    ]);
  });

  it("drops temporary PreviewImage media while keeping durable SaveImage output", () => {
    const selection = selectComfyHistoryMedia({
      preview: { images: [{ filename: "preview.png", type: "temp" }] },
      saver: { images: [{ filename: "final.png", type: "output" }] },
    }, ["preview", "saver"]);

    expect(selection.media).toEqual([
      expect.objectContaining({ outputNodeId: "saver", kind: "image", file: { filename: "final.png", type: "output" } }),
    ]);
    expect(selection.discarded).toEqual([
      expect.objectContaining({ outputNodeId: "preview", reason: "intermediate-file" }),
    ]);
  });

  it("keeps only the muxed video when one saver also reports a thumbnail and companion audio", () => {
    const selection = selectComfyHistoryMedia({
      combine: {
        images: [{ filename: "shot-thumbnail.png", type: "output" }],
        gifs: [{ filename: "shot-audio.mp4", type: "output" }],
        audio: [{ filename: "shot.wav", type: "output" }],
      },
      saveAudio: { audio: [{ filename: "dialogue.wav", type: "output" }] },
    }, ["combine", "saveAudio"]);

    expect(selection.media).toEqual([
      expect.objectContaining({ outputNodeId: "combine", kind: "video", file: expect.objectContaining({ filename: "shot-audio.mp4" }) }),
      expect.objectContaining({ outputNodeId: "saveAudio", kind: "audio", file: expect.objectContaining({ filename: "dialogue.wav" }) }),
    ]);
    expect(selection.discarded).toEqual(expect.arrayContaining([
      expect.objectContaining({ outputNodeId: "combine", kind: "image", reason: "video-companion" }),
      expect.objectContaining({ outputNodeId: "combine", kind: "audio", reason: "video-companion" }),
    ]));
  });

  it("requires explicit output files when history is the compatibility fallback", () => {
    const selection = selectComfyHistoryMedia({
      preview: { images: [{ filename: "preview-without-type.png" }] },
      tempVideo: { gifs: [{ filename: "temporary.mp4", type: "temp" }] },
      customSaver: { images: [{ filename: "final.mp4", type: "output" }] },
    }, ["preview", "tempVideo", "customSaver"], { requireExplicitOutputType: true });

    expect(selection.media).toEqual([
      expect.objectContaining({ outputNodeId: "customSaver", kind: "video", file: expect.objectContaining({ filename: "final.mp4" }) }),
    ]);
    expect(selection.discarded).toEqual(expect.arrayContaining([
      expect.objectContaining({ outputNodeId: "preview", reason: "unverified-file" }),
      expect.objectContaining({ outputNodeId: "tempVideo", reason: "intermediate-file" }),
    ]));
  });

  it("deduplicates the same history file if a custom node repeats it in multiple media groups", () => {
    const selection = selectComfyHistoryMedia({
      saver: {
        gifs: [{ filename: "final.mp4", subfolder: "video", type: "output" }],
        videos: [{ filename: "final.mp4", subfolder: "video", type: "output" }],
      },
    }, ["saver"]);

    expect(selection.media).toHaveLength(1);
    expect(selection.discarded).toEqual([
      expect.objectContaining({ reason: "duplicate-file" }),
    ]);
  });

  it("keeps each exact slot type and reports the source node, output index and target slot", () => {
    const graph = {
      picture: { class_type: "ImageSource", inputs: {} },
      consumer: { class_type: "AudioConsumer", inputs: { audio: ["picture", 0] } },
      save: { class_type: "SaveImage", inputs: { images: ["picture", 0] } },
    };
    const objectInfo = {
      ImageSource: { input: { required: {} }, output: ["IMAGE"] },
      AudioConsumer: { input: { required: { audio: ["AUDIO", { forceInput: true }] } }, output: [] },
      SaveImage: { input: { required: { images: ["IMAGE", { forceInput: true }] } }, output: [], output_node: true },
    };

    const result = validateComfyWorkflow(graph, objectInfo);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "slot-type-mismatch",
        nodeId: "consumer",
        input: "audio",
        sourceNodeId: "picture",
        sourceOutputIndex: 0,
        expectedType: "AUDIO",
        actualType: "IMAGE",
      }),
    ]));
  });

  it("reports a missing source node and a missing source output slot instead of accepting unknown links", () => {
    const graph = {
      consumerA: { class_type: "ImageSink", inputs: { image: ["gone", 0] } },
      consumerB: { class_type: "ImageSink", inputs: { image: ["source", 2] } },
      source: { class_type: "OneImage", inputs: {} },
      save: { class_type: "SaveImage", inputs: { images: ["source", 0] } },
    };
    const objectInfo = {
      ImageSink: { input: { required: { image: ["IMAGE", { forceInput: true }] } }, output: [] },
      OneImage: { input: { required: {} }, output: ["IMAGE"] },
      SaveImage: { input: { required: { images: ["IMAGE", { forceInput: true }] } }, output: [], output_node: true },
    };

    const result = validateComfyWorkflow(graph, objectInfo);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "source-node-missing", nodeId: "consumerA", input: "image", sourceNodeId: "gone" }),
      expect.objectContaining({ code: "source-output-missing", nodeId: "consumerB", input: "image", sourceNodeId: "source", sourceOutputIndex: 2 }),
    ]));
  });

  it("has a clear error when no true media output exists", () => {
    const graph = { decode: { class_type: "VAEDecode", inputs: {} } };
    const objectInfo = { VAEDecode: { input: { required: {} }, output: ["IMAGE"] } };

    const result = validateComfyWorkflow(graph, objectInfo);
    expect(result.outputTargets).toEqual([]);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing-media-output", level: "error" }),
    ]));
  });

  it("rescans the current graph and never carries an old node id into a changed workflow", () => {
    const objectInfo = {
      SaveImage: { input: { required: { images: ["IMAGE", { forceInput: true }] } }, output: [], output_node: true },
      Source: { input: { required: {} }, output: ["IMAGE"] },
    };
    const first = scanComfyWorkflowInterface({ old: { class_type: "Source", inputs: {} } }, objectInfo);
    const second = scanComfyWorkflowInterface({ current: { class_type: "Source", inputs: {} }, save: { class_type: "SaveImage", inputs: { images: ["current", 0] } } }, objectInfo);

    expect(first.nodes).toHaveProperty("old");
    expect(second.nodes).toHaveProperty("current");
    expect(second.nodes).not.toHaveProperty("old");
    expect(validateComfyWorkflow({ current: { class_type: "Source", inputs: {} }, save: { class_type: "SaveImage", inputs: { images: ["current", 0] } } }, objectInfo).outputTargets).toEqual(["save"]);
  });
});
