import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

import {
  DOWNLOAD_CHUNK_SIZE,
  MAX_DOWNLOAD_BYTES,
} from "./serteknik-bridge";

export const MAX_ACTIVE_DOWNLOADS = 3;
export const DOWNLOAD_EXPIRY_MS = 5 * 60 * 1000;

const MAX_DOWNLOAD_ID_LENGTH = 128;
const MAX_FILENAME_LENGTH = 160;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

type DownloadTransfer = {
  id: string;
  filename: string;
  mime: string;
  size: number;
  chunks: string[];
  nextIndex: number;
  receivedBytes: number;
  expiresAt: number;
  finalizing: boolean;
};

type MessageRecord = Record<string, unknown>;

const transfers = new Map<string, DownloadTransfer>();
export function abortFileTransfer(id: string): void { transfers.delete(id); }

function asRecord(value: unknown): MessageRecord | null {
  return value !== null && typeof value === "object" ? (value as MessageRecord) : null;
}

function parseMessage(value: unknown): MessageRecord | null {
  if (typeof value !== "string") return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function finiteNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function pruneExpired(now = Date.now()): void {
  for (const [id, transfer] of transfers) {
    if (transfer.expiresAt <= now) transfers.delete(id);
  }
}

function cleanFilename(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  const basename = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = basename
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .replace(/[<>:"|?*]/g, "_")
    .trim()
    .replace(/^\.+$/, "")
    .slice(0, MAX_FILENAME_LENGTH);
  return cleaned || "download";
}

function cleanMime(value: unknown): string {
  if (typeof value !== "string") return "application/octet-stream";
  const mime = value.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  if (/^image\/[a-z0-9.+-]+$/.test(mime)) return mime;
  if (
    [
      "application/pdf",
      "text/csv",
      "application/csv",
      "application/json",
      "application/sql",
      "text/sql",
      "application/x-sql",
      "application/x-sqlite3",
      "text/plain",
      "application/zip",
      "application/x-zip-compressed",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "application/octet-stream",
    ].includes(mime)
  ) {
    return mime;
  }
  return "application/octet-stream";
}

function safeCacheUri(id: string, filename: string): string {
  const cacheDirectory = FileSystem.cacheDirectory;
  if (!cacheDirectory) throw new Error("File cache is unavailable");
  const safeId = id.replace(/[^a-zA-Z0-9._-]/g, "_");
  const separator = cacheDirectory.endsWith("/") ? "" : "/";
  return `${cacheDirectory}${separator}serteknik-${safeId}-${filename}`;
}

function base64ByteLength(chunk: string): number {
  if (chunk.length === 0) return 0;
  if (chunk.length > DOWNLOAD_CHUNK_SIZE || chunk.length % 4 !== 0 || !BASE64_PATTERN.test(chunk)) {
    throw new Error("Invalid download chunk");
  }
  const padding = chunk.endsWith("==") ? 2 : chunk.endsWith("=") ? 1 : 0;
  return (chunk.length / 4) * 3 - padding;
}

function beginTransfer(message: MessageRecord): boolean {
  pruneExpired();
  const id = requiredString(message.id, "download id", MAX_DOWNLOAD_ID_LENGTH);
  if (transfers.has(id)) throw new Error("Duplicate download id");
  if (transfers.size >= MAX_ACTIVE_DOWNLOADS) throw new Error("Too many active downloads");

  const size = finiteNonNegativeInteger(message.size, "download size");
  if (size > MAX_DOWNLOAD_BYTES) throw new Error("The file is larger than 20 MB");

  transfers.set(id, {
    id,
    filename: cleanFilename(message.filename),
    mime: cleanMime(message.mime ?? message.mimeType),
    size,
    chunks: [],
    nextIndex: 0,
    receivedBytes: 0,
    expiresAt: Date.now() + DOWNLOAD_EXPIRY_MS,
    finalizing: false,
  });
  return true;
}

function appendChunk(message: MessageRecord): boolean {
  pruneExpired();
  const id = requiredString(message.id, "download id", MAX_DOWNLOAD_ID_LENGTH);
  const transfer = transfers.get(id);
  if (!transfer) throw new Error("Unknown or expired download");
  if (transfer.finalizing) throw new Error("Download is already finishing");

  const indexValue = message.index ?? message.chunkIndex;
  const index = finiteNonNegativeInteger(indexValue, "chunk index");
  if (index !== transfer.nextIndex) throw new Error("Invalid download chunk index");
  if (typeof message.chunk !== "string") throw new Error("Invalid download chunk");

  const chunk = message.chunk;
  const bytes = base64ByteLength(chunk);
  if (transfer.receivedBytes + bytes > transfer.size) throw new Error("Download exceeds declared size");

  transfer.chunks.push(chunk);
  transfer.nextIndex += 1;
  transfer.receivedBytes += bytes;
  transfer.expiresAt = Date.now() + DOWNLOAD_EXPIRY_MS;
  return true;
}

async function finishTransfer(message: MessageRecord): Promise<boolean> {
  pruneExpired();
  const id = requiredString(message.id, "download id", MAX_DOWNLOAD_ID_LENGTH);
  const transfer = transfers.get(id);
  if (!transfer) throw new Error("Unknown, expired, or already finished download");
  if (transfer.finalizing) throw new Error("Download is already finishing");
  transfer.finalizing = true;

  if (transfer.receivedBytes !== transfer.size) {
    transfers.delete(id);
    throw new Error("Download is incomplete");
  }

  let fileUri: string | null = null;
  try {
    fileUri = safeCacheUri(transfer.id, transfer.filename);
    await FileSystem.writeAsStringAsync(fileUri, transfer.chunks.join(""), {
      encoding: FileSystem.EncodingType.Base64,
    });
    await Sharing.shareAsync(fileUri, {
      mimeType: transfer.mime,
      dialogTitle: transfer.filename,
    });
    return true;
  } finally {
    try {
      if (fileUri) await FileSystem.deleteAsync(fileUri, { idempotent: true });
    } finally {
      transfers.delete(id);
    }
  }
}

/**
 * Handles only the download protocol messages emitted by the trusted WebView bridge.
 * Other website/native messages return false so the caller can route them elsewhere.
 */
export async function handleFileMessage(message: unknown): Promise<boolean> {
  const record = parseMessage(message);
  if (!record || typeof record.type !== "string") return false;

  switch (record.type) {
    case "DOWNLOAD_START":
      return beginTransfer(record);
    case "DOWNLOAD_CHUNK":
      return appendChunk(record);
    case "DOWNLOAD_END":
      return finishTransfer(record);
    case "DOWNLOAD_ERROR": {
      const id = requiredString(record.id, "download id", MAX_DOWNLOAD_ID_LENGTH);
      transfers.delete(id);
      throw new Error(
        typeof record.error === "string" && record.error.length > 0
          ? record.error.slice(0, 200)
          : "The WebView could not export the file",
      );
    }
    default:
      return false;
  }
}
