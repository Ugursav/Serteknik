export const TRUSTED_SERTEKNIK_ORIGIN = "https://serteknik.elektrik.workers.dev";
export const SESSION_STORAGE_KEY = "sershell_session_token";
export const MAX_SESSION_TOKEN_LENGTH = 4096;
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
export const DOWNLOAD_CHUNK_SIZE = 48_000;

/** Returns true only for an absolute URL whose origin is the live SerTeknik site. */
export function isTrustedNativeUrl(url: string): boolean {
  if (typeof url !== "string" || url.length === 0) return false;
  try {
    return new URL(url).origin === TRUSTED_SERTEKNIK_ORIGIN;
  } catch {
    return false;
  }
}

function acceptableNativeToken(token: string | null): string | null {
  return typeof token === "string" && token.length > 0 && token.length <= MAX_SESSION_TOKEN_LENGTH
    ? token
    : null;
}

function safeJsonLiteral(value: string | null): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

/**
 * JavaScript injected before content and again after load. The global marker makes the
 * two injections idempotent while still allowing the before-load injection to install
 * the storage restoration before the website starts using sessionStorage.
 */
export function buildInjectedBridge(savedToken: string | null): string {
  const nativeToken = safeJsonLiteral(acceptableNativeToken(savedToken));

  return `(function () {
  "use strict";
  var TRUSTED_ORIGIN = ${safeJsonLiteral(TRUSTED_SERTEKNIK_ORIGIN)};
  var SESSION_KEY = ${safeJsonLiteral(SESSION_STORAGE_KEY)};
  var TOKEN_MAX = ${MAX_SESSION_TOKEN_LENGTH};
  var MAX_BYTES = ${MAX_DOWNLOAD_BYTES};
  var CHUNK_SIZE = ${DOWNLOAD_CHUNK_SIZE};
  var NATIVE_TOKEN = ${nativeToken};
  var MARKER = "__serteknikBridgeState__";

  if (window.location.origin !== TRUSTED_ORIGIN) return;

  function validToken(value) {
    return typeof value === "string" && value.length > 0 && value.length <= TOKEN_MAX
      ? value
      : null;
  }

  function post(message) {
    if (window.location.origin !== TRUSTED_ORIGIN) return false;
    try {
      var bridge = window.ReactNativeWebView;
      if (!bridge || typeof bridge.postMessage !== "function") return false;
      bridge.postMessage(JSON.stringify(message));
      return true;
    } catch (_) {
      return false;
    }
  }

  var state = window[MARKER];
  if (state && state.installed) return;
  state = state || {};
  window[MARKER] = state;

  var storage;
  try {
    storage = window.sessionStorage;
    var existing = storage.getItem(SESSION_KEY);
    if (!existing && NATIVE_TOKEN) {
      storage.setItem(SESSION_KEY, NATIVE_TOKEN);
    }
  } catch (_) {
    return;
  }

  function sendCurrentToken() {
    var current = null;
    try {
      current = validToken(storage.getItem(SESSION_KEY));
    } catch (_) {
      current = null;
    }
    post({ type: "SESSION", token: current });
  }

  if (!state.storageWrapped && typeof Storage !== "undefined" && Storage.prototype) {
    var storagePrototype = Storage.prototype;
    var originalSetItem = storagePrototype.setItem;
    var originalRemoveItem = storagePrototype.removeItem;
    var originalClear = storagePrototype.clear;

    if (typeof originalSetItem === "function") {
      storagePrototype.setItem = function (key, value) {
        var before = null;
        var isTarget = this === storage && key === SESSION_KEY;
        if (isTarget) {
          try { before = validToken(storage.getItem(SESSION_KEY)); } catch (_) { before = null; }
        }
        var result = originalSetItem.apply(this, arguments);
        if (isTarget) {
          var after = null;
          try { after = validToken(storage.getItem(SESSION_KEY)); } catch (_) { after = null; }
          if (before !== after) post({ type: "SESSION", token: after });
        }
        return result;
      };
    }

    if (typeof originalRemoveItem === "function") {
      storagePrototype.removeItem = function (key) {
        var isTarget = this === storage && key === SESSION_KEY;
        var result = originalRemoveItem.apply(this, arguments);
        if (isTarget) post({ type: "SESSION", token: null });
        return result;
      };
    }

    if (typeof originalClear === "function") {
      storagePrototype.clear = function () {
        var hadTarget = false;
        if (this === storage) {
          try { hadTarget = storage.getItem(SESSION_KEY) !== null; } catch (_) { hadTarget = false; }
        }
        var result = originalClear.apply(this, arguments);
        if (this === storage && hadTarget) post({ type: "SESSION", token: null });
        return result;
      };
    }
    state.storageWrapped = true;
  }

  function postDownloadError(id, message) {
    post({ type: "DOWNLOAD_ERROR", id: id, error: message || "File export failed" });
  }

  function safeFilename(value) {
    var result = typeof value === "string" ? value : "";
    result = result.replace(/[\\\\/\\u0000-\\u001f\\u007f]/g, "_").trim();
    result = result.replace(/^\\.+$/, "").slice(0, 120);
    return result || "download";
  }

  function extension(value) {
    var match = /\\.([a-z0-9]{1,12})$/i.exec(value || "");
    return match ? match[1].toLowerCase() : "";
  }

  function mimeForExtension(ext) {
    var types = {
      pdf: "application/pdf",
      csv: "text/csv",
      json: "application/json",
      sql: "text/sql",
      bak: "application/octet-stream",
      txt: "text/plain",
      zip: "application/zip",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      bmp: "image/bmp",
      svg: "image/svg+xml"
    };
    return types[ext] || "";
  }

  function allowedMime(value) {
    var mime = typeof value === "string" ? value.toLowerCase().split(";")[0].trim() : "";
    if (/^image\\/[a-z0-9.+-]+$/.test(mime)) return mime;
    if ([
      "application/pdf",
      "text/csv",
      "application/csv",
      "application/json",
      "application/sql",
      "text/sql",
      "application/x-sql",
      "application/x-sqlite3",
      "application/octet-stream",
      "text/plain",
      "application/zip",
      "application/x-zip-compressed",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel"
    ].indexOf(mime) !== -1) return mime;
    return "";
  }

  function fileDetails(blob, requestedName) {
    var name = safeFilename(requestedName);
    var ext = extension(name);
    var fromName = mimeForExtension(ext);
    var fromBlob = allowedMime(blob && blob.type);
    var mime = fromBlob && fromBlob !== "application/octet-stream" ? fromBlob : (fromName || fromBlob || "application/octet-stream");
    var targetExtension = extension(name);
    var knownMimeExtension = {
      "application/pdf": "pdf",
      "text/csv": "csv",
      "application/csv": "csv",
      "application/json": "json",
      "application/sql": "sql",
      "text/sql": "sql",
      "application/x-sql": "sql",
      "application/x-sqlite3": "bak",
      "text/plain": "txt",
      "application/zip": "zip",
      "application/x-zip-compressed": "zip",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx"
    };
    if (!targetExtension && knownMimeExtension[mime]) name += "." + knownMimeExtension[mime];
    return { filename: name, mime: mime };
  }

  function randomId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    } catch (_) {}
    return "download-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  }

  function anchorCandidate(anchor) {
    if (!anchor || anchor.tagName !== "A") return null;
    var raw = anchor.getAttribute("href");
    if (!raw) return null;
    var parsed;
    try { parsed = new URL(raw, window.location.href); } catch (_) { return null; }
    var blobAnchor = parsed.protocol === "blob:" && parsed.origin === TRUSTED_ORIGIN;
    var sameOriginDownload = anchor.hasAttribute("download") && parsed.origin === TRUSTED_ORIGIN && parsed.protocol === "https:";
    if (!blobAnchor && !sameOriginDownload) return null;
    var requestedName = anchor.getAttribute("download") || "";
    if (!requestedName) {
      try { requestedName = decodeURIComponent(parsed.pathname.split("/").pop() || "download"); } catch (_) { requestedName = "download"; }
    }
    return { url: parsed.href, filename: requestedName };
  }

  function readAndPostFile(id, blob, requestedName) {
    if (window.location.origin !== TRUSTED_ORIGIN) return;
    if (!blob || typeof blob.size !== "number" || blob.size > MAX_BYTES) {
      postDownloadError(id, "The file is larger than 20 MB");
      return;
    }
    var details = fileDetails(blob, requestedName);
    post({ type: "DOWNLOAD_START", id: id, filename: details.filename, mime: details.mime, size: blob.size });
    var reader = new FileReader();
    reader.onerror = function () { postDownloadError(id, "The file could not be read"); };
    reader.onload = function () {
      if (window.location.origin !== TRUSTED_ORIGIN) return;
      try {
        var result = typeof reader.result === "string" ? reader.result : "";
        var marker = result.indexOf(",");
        if (marker < 0) throw new Error("The file could not be encoded");
        var base64 = result.slice(marker + 1);
        var index = 0;
        for (var offset = 0; offset < base64.length; offset += CHUNK_SIZE) {
          if (window.location.origin !== TRUSTED_ORIGIN) return;
          post({ type: "DOWNLOAD_CHUNK", id: id, index: index++, chunk: base64.slice(offset, offset + CHUNK_SIZE) });
        }
        post({ type: "DOWNLOAD_END", id: id });
      } catch (_) {
        postDownloadError(id, "The file could not be encoded");
      }
    };
    try { reader.readAsDataURL(blob); } catch (_) { postDownloadError(id, "The file could not be read"); }
  }

  function exportAnchor(candidate) {
    if (window.location.origin !== TRUSTED_ORIGIN) return;
    var id = randomId();
    fetch(candidate.url, { credentials: "include" })
      .then(function (response) {
        if (!response.ok && candidate.url.indexOf("blob:") !== 0) throw new Error("The file request failed");
        return response.blob();
      })
      .then(function (blob) { readAndPostFile(id, blob, candidate.filename); })
      .catch(function () { postDownloadError(id, "The file request failed"); });
  }

  function bindDownloadCapture() {
    if (state.clickBound) return;
    state.clickBound = true;
    document.addEventListener("click", function (event) {
      if (window.location.origin !== TRUSTED_ORIGIN) return;
      var target = event && event.target;
      var anchor = target && typeof target.closest === "function" ? target.closest("a") : null;
      var candidate = anchorCandidate(anchor);
      if (!candidate) return;
      event.preventDefault();
      exportAnchor(candidate);
    }, true);
  }

  if (!state.readyBound) {
    state.readyBound = true;
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", bindDownloadCapture, { once: true });
    } else {
      bindDownloadCapture();
    }
  }

  state.installed = true;
  sendCurrentToken();
})();`;
}
