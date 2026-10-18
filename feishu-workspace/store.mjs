import { appendFile, writeFile, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { directory, guard, atomic, readJson } from "./files.mjs";
export class Workspace {
  constructor(root, maxBytes = 32 * 1024 * 1024) {
    this.root = resolve(root);
    this.maxBytes = maxBytes;
  }
  async init() {
    await directory(this.root);
  }
  key(chat, user) {
    return createHash("sha256")
      .update(JSON.stringify([chat, user]))
      .digest("hex");
  }
  path(key) {
    if (!/^[a-f0-9]{64}$/.test(key))
      throw new Error("invalid conversation identifier");
    return join(this.root, "conversations", key);
  }
  async prepare(key) {
    const p = this.path(key);
    await directory(this.root, p);
    return p;
  }
  async claimMessage(key, messageId) {
    if (typeof messageId !== "string" || !messageId || messageId.length > 512)
      throw new Error("invalid message identifier");
    const folder = join(await this.prepare(key), "receipts");
    await directory(this.root, folder);
    const id = createHash("sha256").update(messageId).digest("hex");
    const file = join(folder, id + ".json");
    await guard(this.root, file);
    try {
      await writeFile(
        file,
        JSON.stringify({ at: new Date().toISOString(), state: "claimed" }),
        { flag: "wx", mode: 0o600 },
      );
      return true;
    } catch (error) {
      if (error.code === "EEXIST") return false;
      throw error;
    }
  }
  async append(key, event) {
    const dir = await this.prepare(key),
      p = join(dir, "messages.jsonl");
    await guard(this.root, p);
    const state = await this.state(key);
    await appendFile(
      p,
      JSON.stringify({
        ...event,
        generation: state.contextGeneration || "initial",
        at: new Date().toISOString(),
      }) + "\n",
      { mode: 0o600 },
    );
  }
  async state(key) {
    return readJson(this.root, join(this.path(key), "state.json"), {
      seen: [],
      threadId: null,
    });
  }
  async saveState(key, value) {
    const dir = await this.prepare(key);
    await atomic(this.root, join(dir, "state.json"), value);
  }
  async resetContext(key, reason = "requested") {
    const state = await this.state(key);
    const next = {
      ...state,
      threadId: null,
      contextGeneration: randomUUID(),
      lastModel: null,
    };
    await this.saveState(key, next);
    await this.append(key, { type: "context-reset", reason });
    return next;
  }
  async history(key, limit = 16) {
    const file = join(this.path(key), "messages.jsonl");
    await guard(this.root, file);
    const state = await this.state(key),
      generation = state.contextGeneration || "initial";
    let f, raw;
    try {
      f = await open(file, "r");
      const size = (await f.stat()).size,
        start = Math.max(0, size - 256 * 1024),
        buffer = Buffer.alloc(size - start);
      await f.read(buffer, 0, buffer.length, start);
      raw = buffer.toString("utf8");
      if (start) raw = raw.slice(raw.indexOf("\n") + 1);
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    } finally {
      await f?.close();
    }
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter(
        (e) =>
          ["user", "assistant"].includes(e.role) &&
          (e.generation || "initial") === generation,
      )
      .slice(-Math.max(1, Math.min(limit, 100)))
      .map(({ role, content }) => ({ role, content }));
  }
  async attachments(key) {
    return readJson(this.root, join(this.path(key), "attachments.json"), []);
  }
  async saveAttachment(key, messageId, filename, buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length > this.maxBytes)
      throw new Error("attachment size limit");
    const id = createHash("sha256")
      .update(messageId + "\0" + filename)
      .digest("hex")
      .slice(0, 16);
    const name =
      filename
        .replace(/.*[\\/]/, "")
        .replace(/[^\p{L}\p{N}_.-]/gu, "_")
        .replace(/\.{2,}/g, "_")
        .slice(-100) || "attachment";
    const all = await this.attachments(key),
      old = all.find((f) => f.id === id);
    if (old) {
      await guard(this.root, old.path);
      return old;
    }
    const dir = await this.prepare(key);
    await directory(this.root, join(dir, "files"));
    const path = join(dir, "files", `file-${id}-${name}`);
    await guard(this.root, path);
    await writeFile(path, buffer, { flag: "wx", mode: 0o600 });
    const item = {
      id,
      name,
      path,
      bytes: buffer.length,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      at: new Date().toISOString(),
    };
    await atomic(
      this.root,
      join(dir, "attachments.json"),
      [...all, item].slice(-100),
    );
    return item;
  }
}
