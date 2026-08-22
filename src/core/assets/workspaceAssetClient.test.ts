import { describe, expect, it } from "vitest";

import {
  DesktopMediaStoreUnavailableError,
  WorkspaceAssetUploadError,
  cacheComfyOutputMedia,
  deleteWorkspaceAsset,
  importWorkspaceAssetFromPath,
  invokeDesktopWorkspaceAsset,
  listWorkspaceAssets,
  normalizeManagedWorkspaceAsset,
  uploadWorkspaceAsset,
  type WorkspaceAssetInvoker,
} from "./workspaceAssetClient";

const namedBlob = (contents: string, name = "hero.png", type = "image/png") => {
  const blob = new Blob([contents], { type }) as Blob & { name?: string };
  blob.name = name;
  return blob;
};

describe("workspace asset client", () => {
  it("imports an authorized native-drop path without reading it into WebView memory", async () => {
    const calls: Array<{ command: string; arguments_: Record<string, unknown> }> = [];
    const asset = await importWorkspaceAssetFromPath({
      projectId: "project-a",
      assetId: "asset-drop-1",
      sourcePath: "D:\\素材\\镜头.mp4",
      fileName: "镜头.mp4",
      mimeType: "video/mp4",
    }, {
      invoke: async (command, arguments_) => {
        calls.push({ command, arguments_ });
        return {
          project_id: "project-a",
          asset_id: "asset-drop-1",
          local_path: "D:\\workspace\\asset-drop-1--镜头.mp4",
          file_name: "镜头.mp4",
          mime_type: "video/mp4",
          bytes: 4096,
        };
      },
    });

    expect(calls).toEqual([{
      command: "import_workspace_asset_from_path",
      arguments_: {
        projectId: "project-a",
        assetId: "asset-drop-1",
        filename: "镜头.mp4",
        mimeType: "video/mp4",
        sourcePath: "D:\\素材\\镜头.mp4",
      },
    }]);
    expect(asset).toMatchObject({
      localPath: "D:\\workspace\\asset-drop-1--镜头.mp4",
      fileName: "镜头.mp4",
      size: 4096,
    });
  });

  it("streams chunks in order and maps snake_case commit metadata", async () => {
    const calls: Array<{ command: string; arguments_: Record<string, unknown> }> = [];
    const reads: number[] = [];
    const invoke: WorkspaceAssetInvoker = async (command, arguments_) => {
      calls.push({ command, arguments_ });
      if (command === "begin_workspace_asset") return { upload_id: "upload-7" };
      if (command === "commit_workspace_asset") {
        return {
          asset: {
            project_id: "project-from-rust",
            asset_id: "asset-from-rust",
            local_path: "D:\\ComfyCanvas\\media\\hero.png",
            file_name: "stored-hero.png",
            mime_type: "image/png",
            total_bytes: "5",
          },
        };
      }
      return undefined;
    };

    const asset = await uploadWorkspaceAsset({
      projectId: "project-a",
      assetId: "asset_hero-1",
      file: namedBlob("abcde"),
      chunkBytes: 2,
    }, {
      invoke,
      readChunkAsBase64: async (chunk) => {
        reads.push(chunk.size);
        return `chunk-${reads.length}`;
      },
    });

    expect(reads).toEqual([2, 2, 1]);
    expect(calls).toEqual([
      {
        command: "begin_workspace_asset",
        arguments_: {
          projectId: "project-a",
          assetId: "asset_hero-1",
          filename: "hero.png",
          mimeType: "image/png",
          totalBytes: 5,
        },
      },
      { command: "append_workspace_asset_chunk", arguments_: { uploadId: "upload-7", base64Chunk: "chunk-1" } },
      { command: "append_workspace_asset_chunk", arguments_: { uploadId: "upload-7", base64Chunk: "chunk-2" } },
      { command: "append_workspace_asset_chunk", arguments_: { uploadId: "upload-7", base64Chunk: "chunk-3" } },
      { command: "commit_workspace_asset", arguments_: { uploadId: "upload-7" } },
    ]);
    expect(asset).toEqual({
      projectId: "project-from-rust",
      assetId: "asset-from-rust",
      localPath: "D:\\ComfyCanvas\\media\\hero.png",
      fileName: "stored-hero.png",
      mimeType: "image/png",
      size: 5,
    });
  });

  it("aborts exactly once when appending a chunk fails and retains the primary failure", async () => {
    const commands: string[] = [];
    const invoke: WorkspaceAssetInvoker = async (command) => {
      commands.push(command);
      if (command === "begin_workspace_asset") return { uploadId: "upload-fail" };
      if (command === "append_workspace_asset_chunk") throw new Error("disk full");
      return undefined;
    };

    await expect(uploadWorkspaceAsset({
      projectId: "project-a",
      assetId: "asset-a",
      file: namedBlob("abc"),
      chunkBytes: 2,
    }, {
      invoke,
      readChunkAsBase64: async () => "encoded",
    })).rejects.toMatchObject({
      name: "WorkspaceAssetUploadError",
      stage: "append",
      message: expect.stringContaining("disk full"),
    });
    expect(commands).toEqual([
      "begin_workspace_asset",
      "append_workspace_asset_chunk",
      "abort_workspace_asset",
    ]);
  });

  it("aborts when commit or chunk reading fails, even if abort itself also fails", async () => {
    const commitCommands: string[] = [];
    const commitInvoker: WorkspaceAssetInvoker = async (command) => {
      commitCommands.push(command);
      if (command === "begin_workspace_asset") return "commit-upload";
      if (command === "commit_workspace_asset") throw new Error("commit unavailable");
      if (command === "abort_workspace_asset") throw new Error("abort unavailable");
      return undefined;
    };

    try {
      await uploadWorkspaceAsset({
        projectId: "project-a",
        assetId: "asset-a",
        file: namedBlob("a"),
      }, {
        invoke: commitInvoker,
        readChunkAsBase64: async () => "encoded",
      });
      throw new Error("expected upload to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceAssetUploadError);
      expect(error).toMatchObject({ stage: "commit", abortError: expect.any(Error) });
    }
    expect(commitCommands).toEqual([
      "begin_workspace_asset",
      "append_workspace_asset_chunk",
      "commit_workspace_asset",
      "abort_workspace_asset",
    ]);

    const readCommands: string[] = [];
    await expect(uploadWorkspaceAsset({
      projectId: "project-a",
      assetId: "asset-b",
      file: namedBlob("a"),
    }, {
      invoke: async (command) => {
        readCommands.push(command);
        return command === "begin_workspace_asset" ? { uploadId: "read-upload" } : undefined;
      },
      readChunkAsBase64: async () => {
        throw new Error("read failed");
      },
    })).rejects.toMatchObject({ stage: "read" });
    expect(readCommands).toEqual(["begin_workspace_asset", "abort_workspace_asset"]);
  });

  it("uses caller metadata when a compatible backend returns no asset body", async () => {
    const asset = await uploadWorkspaceAsset({
      projectId: "project-a",
      assetId: "asset-a",
      file: namedBlob("abc", "portrait.jpg", "image/jpeg"),
    }, {
      invoke: async (command) => command === "begin_workspace_asset" ? { uploadId: "fallback" } : undefined,
      readChunkAsBase64: async () => "encoded",
    });

    expect(asset).toEqual({
      projectId: "project-a",
      assetId: "asset-a",
      fileName: "portrait.jpg",
      mimeType: "image/jpeg",
      size: 3,
    });
  });

  it("normalizes direct/camel response data without trusting invalid values", () => {
    expect(normalizeManagedWorkspaceAsset({
      projectId: "",
      assetId: "remote-id",
      localPath: "C:\\workspace\\item.webp",
      mimeType: "image/webp",
      size: -1,
    }, {
      projectId: "project-local",
      assetId: "asset-local",
      fileName: "local.webp",
      mimeType: "image/png",
      size: 99,
    })).toEqual({
      projectId: "project-local",
      assetId: "remote-id",
      localPath: "C:\\workspace\\item.webp",
      fileName: "local.webp",
      mimeType: "image/webp",
      size: 99,
    });
  });

  it("rejects unsafe asset ids before opening an upload and exposes the browser-only error clearly", async () => {
    let invoked = false;
    await expect(uploadWorkspaceAsset({
      projectId: "project-a",
      assetId: "../unsafe",
      file: namedBlob("a"),
    }, {
      invoke: async () => {
        invoked = true;
        return undefined;
      },
    })).rejects.toMatchObject({ stage: "validate" });
    expect(invoked).toBe(false);

    // Node/Vitest has no Tauri globals, exactly like a normal browser tab.
    // The client must not silently store a data URL in that case.
    await expect(invokeDesktopWorkspaceAsset("begin_workspace_asset", {}))
      .rejects.toBeInstanceOf(DesktopMediaStoreUnavailableError);
    expect(new DesktopMediaStoreUnavailableError().message).toBe("桌面媒体仓储只在桌面版可用");
  });

  it("delegates Comfy output caching to the backend without renderer media bytes", async () => {
    const calls: Array<{ command: string; arguments_: Record<string, unknown> }> = [];
    const asset = await cacheComfyOutputMedia({
      endpoint: "http://127.0.0.1:8188/",
      filename: "LTX2_00081-audio.mp4",
      subfolder: "LTX2",
      projectId: "project-a",
      assetId: "asset-video",
    }, {
      invoke: async (command, arguments_) => {
        calls.push({ command, arguments_ });
        return {
          project_id: "project-a",
          asset_id: "asset-video",
          file_name: "LTX2_00081-audio.mp4",
          mime_type: "video/mp4",
          bytes: 6462907,
          local_path: "D:\\managed\\LTX2_00081-audio.mp4",
        };
      },
    });

    expect(calls).toEqual([{
      command: "cache_comfy_output_media",
      arguments_: {
        endpoint: "http://127.0.0.1:8188",
        filename: "LTX2_00081-audio.mp4",
        subfolder: "LTX2",
        projectId: "project-a",
        assetId: "asset-video",
      },
    }]);
    expect(asset).toEqual({
      projectId: "project-a",
      assetId: "asset-video",
      fileName: "LTX2_00081-audio.mp4",
      mimeType: "video/mp4",
      size: 6462907,
      localPath: "D:\\managed\\LTX2_00081-audio.mp4",
    });
    expect(JSON.stringify(calls)).not.toContain("base64");
  });

  it("rejects unsafe Comfy cache paths before invoking the backend", async () => {
    let invoked = false;
    const invoke: WorkspaceAssetInvoker = async () => {
      invoked = true;
      return undefined;
    };
    await expect(cacheComfyOutputMedia({
      endpoint: "http://127.0.0.1:8188",
      filename: "../secret.mp4",
      projectId: "project-a",
      assetId: "asset-a",
    }, { invoke })).rejects.toThrow("文件名");
    await expect(cacheComfyOutputMedia({
      endpoint: "file:///D:/ComfyUI",
      filename: "video.mp4",
      projectId: "project-a",
      assetId: "asset-a",
    }, { invoke })).rejects.toThrow("http://");
    expect(invoked).toBe(false);
  });

  it("lists and deletes only validated exact managed identities", async () => {
    const calls: Array<{ command: string; arguments_: Record<string, unknown> }> = [];
    const invoke: WorkspaceAssetInvoker = async (command, arguments_) => {
      calls.push({ command, arguments_ });
      if (command === "list_workspace_assets") return [{
        projectId: "project-a",
        assetId: "asset-a",
        localPath: "D:\\app\\asset-a--hero.png",
        fileName: "hero.png",
        mimeType: "image/png",
        bytes: 3,
      }];
      if (command === "delete_workspace_asset") return { deleted: true };
      return undefined;
    };

    await expect(listWorkspaceAssets("project-a", { invoke })).resolves.toEqual([{
      projectId: "project-a",
      assetId: "asset-a",
      localPath: "D:\\app\\asset-a--hero.png",
      fileName: "hero.png",
      mimeType: "image/png",
      size: 3,
    }]);
    await expect(deleteWorkspaceAsset("project-a", "asset-a", { invoke })).resolves.toBe(true);
    expect(calls).toEqual([
      { command: "list_workspace_assets", arguments_: { projectId: "project-a" } },
      { command: "delete_workspace_asset", arguments_: { projectId: "project-a", assetId: "asset-a" } },
    ]);

    await expect(deleteWorkspaceAsset("project-a", "../escape", { invoke })).rejects.toThrow("素材编号");
    await expect(listWorkspaceAssets("../escape", { invoke })).rejects.toThrow("项目编号");
    expect(calls).toHaveLength(2);
  });
});
