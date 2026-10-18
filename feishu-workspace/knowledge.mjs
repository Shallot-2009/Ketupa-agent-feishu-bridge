import { open, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, join, parse, extname } from "node:path";
import { createHash } from "node:crypto";
import { guard } from "./files.mjs";

const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_DOCUMENTS = 64;
// A byte budget also conservatively bounds byte based tokenizer input.
const MAX_EVIDENCE_BYTES = 8000;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const wordSegmenter = new Intl.Segmenter("und", { granularity: "word" });

function boundedInteger(value, fallback, maximum) {
  return Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, maximum)
    : fallback;
}

function stamp(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

function failure(kind, state = kind) {
  const error = new Error(kind);
  error.kind = kind;
  error.state = state;
  return error;
}

async function readBounded(root, path, limit) {
  let handle;
  try {
    // Check ancestors of the configured root as well as the document path.
    await guard(parse(root).root, root);
    await guard(root, path);
    const before = await lstat(path);
    if (!before.isFile()) throw failure("unsafe");
    if (before.size > limit)
      throw failure("oversized", `oversized:${stamp(before)}`);
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    if (!opened.isFile() || stamp(opened) !== stamp(before))
      throw failure("changed");
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > limit) throw failure("oversized");
    const after = await handle.stat();
    await guard(root, path);
    const current = await lstat(path);
    if (stamp(after) !== stamp(opened) || stamp(current) !== stamp(opened))
      throw failure("changed");
    return buffer.subarray(0, offset);
  } catch (error) {
    if (error.kind) throw error;
    throw failure(error.code === "ENOENT" ? "missing" : "unsafe");
  } finally {
    await handle?.close();
  }
}

function allowlist(value) {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 1024 ||
    value.some((item) => typeof item !== "string" || !item || item.length > 256)
  )
    throw failure("policy");
  return value;
}

function documentsFrom(buffer) {
  const manifest = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(buffer),
  );
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    !Array.isArray(manifest.documents) ||
    manifest.documents.length > MAX_DOCUMENTS
  ) {
    throw failure("policy");
  }
  const ids = new Set();
  return manifest.documents.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof entry.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(entry.id) ||
      ids.has(entry.id) ||
      typeof entry.path !== "string" ||
      entry.path.length > 512 ||
      !/^[a-fA-F0-9]{64}$/.test(entry.sha256 || "") ||
      (entry.allowModel !== undefined && typeof entry.allowModel !== "boolean")
    ) {
      throw failure("policy");
    }
    // Portable relative paths only: no drive letters, ADS streams or backslashes.
    const parts = entry.path.split("/");
    if (
      /[\\:\u0000-\u001f]/.test(entry.path) ||
      parts.some(
        (part) => !part || part === "." || part === ".." || /[. ]$/.test(part),
      ) ||
      ![".md", ".txt"].includes(extname(entry.path).toLowerCase())
    )
      throw failure("policy");
    ids.add(entry.id);
    return {
      id: entry.id,
      path: entry.path,
      sha256: entry.sha256.toLowerCase(),
      allowModel: entry.allowModel === true,
      allowedUsers: allowlist(entry.allowedUsers),
      allowedChats: allowlist(entry.allowedChats),
    };
  });
}

function searchTerms(text) {
  const terms = new Set();
  for (const word of wordSegmenter.segment(text.toLowerCase())) {
    if (word.isWordLike && /^[\p{L}\p{N}]{2,64}$/u.test(word.segment))
      terms.add(word.segment);
    if (terms.size >= 32) break;
  }
  return [...terms];
}

function matchDocument(document, terms) {
  const lower = document.text.toLocaleLowerCase();
  let score = 0;
  let offset = -1;
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at !== -1) {
      score += 1;
      if (offset === -1 || at < offset) offset = at;
    }
  }
  return { ...document, score, offset };
}

function clipPassage(text, offset, chars, bytes) {
  let start = Math.max(0, offset - Math.min(100, Math.floor(chars / 4)));
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start -= 1;
  let result = "";
  let byteCount = 0;
  for (const character of text.slice(start, start + chars + 1)) {
    const cost = Buffer.byteLength(character, "utf8");
    if (result.length + character.length > chars || byteCount + cost > bytes)
      break;
    result += character;
    byteCount += cost;
  }
  return result.trim();
}

/** Local, explicitly authorized plain text evidence; no discovery or remote calls. */
export class Knowledge {
  constructor(root, options = {}) {
    this.root = resolve(root);
    this.enabled = options.enabled === true;
    this.maxEvidenceChars = boundedInteger(
      options.maxEvidenceChars,
      4000,
      16000,
    );
    this.maxSnippets = boundedInteger(options.maxSnippets, 3, 16);
  }

  async query({ user, chat, text } = {}) {
    const context = {
      version: 1,
      root: sha256(this.root),
      enabled: this.enabled,
      user: typeof user === "string" ? user : null,
      chat: typeof chat === "string" ? chat : null,
      maxEvidenceChars: this.maxEvidenceChars,
      maxSnippets: this.maxSnippets,
    };
    const result = (status, evidence = []) => ({
      fingerprint: sha256(JSON.stringify(context)),
      evidence,
      status,
    });
    if (!this.enabled) return result("disabled");

    const manifestPath = join(this.root, "manifest.json");
    let manifestBytes;
    try {
      manifestBytes = await readBounded(
        this.root,
        manifestPath,
        MAX_MANIFEST_BYTES,
      );
      context.manifest = sha256(manifestBytes);
    } catch (error) {
      context.manifest = error.state || "unreadable";
      return result(error.kind === "missing" ? "unavailable" : "policy-error");
    }

    let documents;
    try {
      documents = documentsFrom(manifestBytes);
    } catch {
      context.policy = "invalid";
      return result("policy-error");
    }
    const granted = documents.filter(
      (entry) =>
        entry.allowModel &&
        context.user &&
        context.chat &&
        entry.allowedUsers.includes(context.user) &&
        entry.allowedChats.includes(context.chat),
    );
    const valid = [];
    context.documents = [];
    let bytesRemaining = MAX_TOTAL_BYTES;
    for (const entry of granted) {
      try {
        const buffer = await readBounded(
          this.root,
          join(this.root, entry.path),
          Math.min(MAX_DOCUMENT_BYTES, bytesRemaining),
        );
        bytesRemaining -= buffer.length;
        const actual = sha256(buffer);
        const state = { id: entry.id, actual, valid: actual === entry.sha256 };
        context.documents.push(state);
        if (!state.valid) continue;
        try {
          const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
            buffer,
          );
          if (decoded.includes("\u0000")) throw failure("binary");
          valid.push({ id: entry.id, text: decoded, sha256: actual });
        } catch {
          state.valid = false;
          state.reason = "not-utf8-text";
        }
      } catch (error) {
        context.documents.push({
          id: entry.id,
          valid: false,
          state: error.state || "unreadable",
        });
      }
    }

    // Do not publish evidence if its governing policy changed during this query.
    try {
      const latest = await readBounded(
        this.root,
        manifestPath,
        MAX_MANIFEST_BYTES,
      );
      const latestHash = sha256(latest);
      if (latestHash !== context.manifest) {
        context.latestManifest = latestHash;
        return result("policy-error");
      }
    } catch (error) {
      context.latestManifest = error.state || "unreadable";
      return result("policy-error");
    }

    const query = typeof text === "string" ? text.trim().slice(0, 4096) : "";
    if (
      !query ||
      /^(?:hi|hello|hey|你好|您好|早上好|晚上好)[\s!.！。?？]*$/iu.test(query)
    ) {
      return result("skipped");
    }
    const terms = searchTerms(query);
    const ranked = valid
      .map((document) => matchDocument(document, terms))
      .filter((document) => document.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const evidence = [];
    let chars = this.maxEvidenceChars;
    let bytes = MAX_EVIDENCE_BYTES;
    for (const document of ranked) {
      if (evidence.length >= this.maxSnippets || chars <= 0 || bytes <= 0)
        break;
      const snippet = clipPassage(
        document.text,
        document.offset,
        Math.min(chars, 1600),
        bytes,
      );
      if (!snippet) continue;
      evidence.push({
        id: document.id,
        text: snippet,
        sha256: document.sha256,
      });
      chars -= snippet.length;
      bytes -= Buffer.byteLength(snippet, "utf8");
    }
    return result(evidence.length ? "ok" : "empty", evidence);
  }
}
