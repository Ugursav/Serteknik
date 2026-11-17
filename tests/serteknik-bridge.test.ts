import { afterEach, describe, expect, it, vi } from "vitest";
import vm from "node:vm";

const fsMocks = vi.hoisted(() => ({
  cacheDirectory: "file:///cache/",
  EncodingType: { Base64: "base64" },
  writeAsStringAsync: vi.fn(async () => undefined),
  deleteAsync: vi.fn(async () => undefined),
}));
const sharingMocks = vi.hoisted(() => ({
  shareAsync: vi.fn(async () => undefined),
}));

vi.mock("expo-file-system/legacy", () => fsMocks);
vi.mock("expo-sharing", () => sharingMocks);

import {
  buildInjectedBridge,
  DOWNLOAD_CHUNK_SIZE,
  isTrustedNativeUrl,
  MAX_DOWNLOAD_BYTES,
  SESSION_STORAGE_KEY,
  TRUSTED_SERTEKNIK_ORIGIN,
} from "../lib/serteknik-bridge";
import { handleFileMessage } from "../lib/serteknik-files";

function makeBridgeContext() {
  class FakeStorage {
    private readonly values = new Map<string, string>();

    getItem(key: string): string | null {
      return this.values.has(key) ? this.values.get(key)! : null;
    }

    setItem(key: string, value: string): void {
      this.values.set(key, String(value));
    }

    removeItem(key: string): void {
      this.values.delete(key);
    }

    clear(): void {
      this.values.clear();
    }
  }

  const sessionStorage = new FakeStorage();
  const messages: Array<Record<string, unknown>> = [];
  let clickHandler: ((event: unknown) => void) | undefined;
  const document = {
    readyState: "complete",
    addEventListener: (name: string, handler: (event: unknown) => void) => {
      if (name === "click") clickHandler = handler;
    },
  };
  const windowObject = {
    location: { origin: TRUSTED_SERTEKNIK_ORIGIN, href: `${TRUSTED_SERTEKNIK_ORIGIN}/` },
    sessionStorage,
    ReactNativeWebView: {
      postMessage: (value: string) => messages.push(JSON.parse(value) as Record<string, unknown>),
    },
    crypto: undefined,
  };
  const context = {
    window: windowObject,
    document,
    Storage: FakeStorage,
    URL,
    FileReader: class {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      readAsDataURL(blob: { type: string }): void {
        this.result = `data:${blob.type};base64,AAEC`;
        this.onload?.();
      }
    },
    fetch: async () => ({
      ok: true,
      blob: async () => ({ size: 3, type: "application/pdf" }),
    }),
    Date,
    Math,
    JSON,
    Error,
    decodeURIComponent,
    setTimeout,
    clearTimeout,
  };
  return { context, sessionStorage, messages, getClickHandler: () => clickHandler };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("SerTeknik injected bridge", () => {
  it("restores a nonempty token before initial sync and emits logout changes once", () => {
    const bridge = buildInjectedBridge("native-token");
    const { context, sessionStorage, messages } = makeBridgeContext();

    vm.runInNewContext(bridge, context);
    expect(sessionStorage.getItem(SESSION_STORAGE_KEY)).toBe("native-token");
    expect(messages).toEqual([{ type: "SESSION", token: "native-token" }]);

    sessionStorage.setItem(SESSION_STORAGE_KEY, "new-token");
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    expect(messages.at(-2)).toEqual({ type: "SESSION", token: "new-token" });
    expect(messages.at(-1)).toEqual({ type: "SESSION", token: null });

    vm.runInNewContext(bridge, context);
    expect(messages).toHaveLength(3);
  });

  it("does not install or post on an untrusted document origin", () => {
    const bridge = buildInjectedBridge("native-token");
    const { context, messages } = makeBridgeContext();
    context.window.location.origin = "https://evil.example";

    vm.runInNewContext(bridge, context);
    expect(messages).toHaveLength(0);
  });

  it("captures only same-origin download links and sends bounded chunks", async () => {
    const bridge = buildInjectedBridge(null);
    const { context, messages, getClickHandler } = makeBridgeContext();
    vm.runInNewContext(bridge, context);
    const handler = getClickHandler();
    expect(handler).toBeDefined();

    const preventDefault = vi.fn();
    const anchor = {
      tagName: "A",
      getAttribute: (name: string) => (name === "href" ? "/report.pdf" : name === "download" ? "report.pdf" : null),
      hasAttribute: (name: string) => name === "download",
    };
    handler?.({
      target: { closest: () => anchor },
      preventDefault,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(messages.map((message) => message.type)).toEqual([
      "SESSION",
      "DOWNLOAD_START",
      "DOWNLOAD_CHUNK",
      "DOWNLOAD_END",
    ]);
    const chunk = messages.find((message) => message.type === "DOWNLOAD_CHUNK")?.chunk;
    expect(typeof chunk).toBe("string");
    expect((chunk as string).length).toBeLessThanOrEqual(DOWNLOAD_CHUNK_SIZE);

    const externalAnchor = {
      ...anchor,
      getAttribute: (name: string) => (name === "href" ? "https://evil.example/a.pdf" : "a.pdf"),
    };
    handler?.({ target: { closest: () => externalAnchor }, preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});

describe("trusted native URL and file handler", () => {
  it("accepts only the exact trusted origin", () => {
    expect(isTrustedNativeUrl(`${TRUSTED_SERTEKNIK_ORIGIN}/dashboard`)).toBe(true);
    expect(isTrustedNativeUrl("https://serteknik.elektrik.workers.dev.evil.example/" )).toBe(false);
    expect(isTrustedNativeUrl("https://evil.example/" )).toBe(false);
    expect(isTrustedNativeUrl("not a url")).toBe(false);
  });

  it("returns false for unrelated messages and shares a validated base64 download", async () => {
    expect(await handleFileMessage({ type: "SESSION", token: "not handled here" })).toBe(false);

    await handleFileMessage({
      type: "DOWNLOAD_START",
      id: "unit-test-download",
      filename: "report.pdf",
      mime: "application/pdf",
      size: 3,
    });
    await handleFileMessage({
      type: "DOWNLOAD_CHUNK",
      id: "unit-test-download",
      index: 0,
      chunk: "AAEC",
    });
    await handleFileMessage({ type: "DOWNLOAD_END", id: "unit-test-download" });

    expect(fsMocks.writeAsStringAsync).toHaveBeenCalledWith(
      "file:///cache/serteknik-unit-test-download-report.pdf",
      "AAEC",
      { encoding: "base64" },
    );
    expect(sharingMocks.shareAsync).toHaveBeenCalledWith(
      "file:///cache/serteknik-unit-test-download-report.pdf",
      expect.objectContaining({ mimeType: "application/pdf" }),
    );
    expect(fsMocks.deleteAsync).toHaveBeenCalledWith(
      "file:///cache/serteknik-unit-test-download-report.pdf",
      { idempotent: true },
    );
  });

  it("rejects invalid or oversized chunks and duplicate completion", async () => {
    await handleFileMessage({ type: "DOWNLOAD_START", id: "chunk-test", filename: "a.bin", size: 1 });
    await expect(
      handleFileMessage({ type: "DOWNLOAD_CHUNK", id: "chunk-test", index: 1, chunk: "AA==" }),
    ).rejects.toThrow("chunk index");
    await expect(
      handleFileMessage({ type: "DOWNLOAD_CHUNK", id: "chunk-test", index: 0, chunk: "AAAA" }),
    ).rejects.toThrow("declared size");
    await handleFileMessage({ type: "DOWNLOAD_CHUNK", id: "chunk-test", index: 0, chunk: "AA==" });
    await handleFileMessage({ type: "DOWNLOAD_END", id: "chunk-test" });
    await expect(handleFileMessage({ type: "DOWNLOAD_END", id: "chunk-test" })).rejects.toThrow();

    await expect(
      handleFileMessage({ type: "DOWNLOAD_START", id: "too-large", filename: "big.zip", size: MAX_DOWNLOAD_BYTES + 1 }),
    ).rejects.toThrow("20 MB");
  });
});
