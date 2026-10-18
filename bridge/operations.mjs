import { randomUUID } from "node:crypto";
import {
  writeFile,
  unlink,
  mkdir,
  rmdir,
  readdir,
  lstat,
} from "node:fs/promises";
import { join } from "node:path";
import {
  directory,
  guard,
  readJson,
  atomic,
} from "../feishu-workspace/files.mjs";

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

/** Serializes startup; a stale PID is never killed, and ambiguous locks fail closed. */
export class InstanceLease {
  constructor(root) {
    this.root = root;
    this.file = join(root, "service.lock.json");
    this.recovery = join(root, "service-recovery.lock");
    this.token = randomUUID();
  }

  async acquire() {
    await directory(this.root);
    const create = async () => {
      await guard(this.root, this.file);
      await writeFile(
        this.file,
        JSON.stringify({
          pid: process.pid,
          token: this.token,
          at: new Date().toISOString(),
        }),
        { flag: "wx", mode: 0o600 },
      );
    };
    try {
      await create();
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    await guard(this.root, this.recovery);
    try {
      await mkdir(this.recovery, { mode: 0o700 });
    } catch {
      throw new Error(
        "another service startup is active; inspect startup lock",
      );
    }
    try {
      const previous = await readJson(this.root, this.file, null);
      if (previous && alive(previous.pid))
        throw new Error("another service instance is active");
      if (previous) {
        await guard(this.root, this.file);
        await unlink(this.file);
      }
      await create();
    } finally {
      await rmdir(this.recovery);
    }
  }

  async release() {
    const current = await readJson(this.root, this.file, null);
    if (current?.token === this.token) {
      await guard(this.root, this.file);
      await unlink(this.file);
    }
  }
}

async function usage(root) {
  const result = { files: 0, bytes: 0, truncated: false };
  const visit = async (path, depth) => {
    await guard(root, path);
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (result.files >= 10000 || depth > 8) {
        result.truncated = true;
        return;
      }
      const file = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        result.truncated = true;
        continue;
      }
      if (entry.isDirectory()) await visit(file, depth + 1);
      else if (entry.isFile()) {
        await guard(root, file);
        result.files++;
        result.bytes += (await lstat(file)).size;
      }
    }
  };
  await visit(root, 0);
  return result;
}

export async function noteRuntime(local, fields) {
  const file = join(local.root, "runtime.json");
  const prior = await readJson(local.root, file, {});
  // Fixed fields only: never store event payloads or credential-bearing SDK errors.
  const next = { ...prior };
  for (const name of [
    "startedAt",
    "lastInboundAt",
    "lastModelAt",
    "lastActualModel",
    "provider",
    "configuredModel",
  ]) {
    if (Object.hasOwn(fields, name)) next[name] = fields[name];
  }
  await atomic(local.root, file, next);
}

export async function statusSnapshot(config, local, tasks, queue = null) {
  const runtime = await readJson(
    local.root,
    join(local.root, "runtime.json"),
    {},
  );
  const lock = await readJson(
    local.root,
    join(local.root, "service.lock.json"),
    null,
  );
  return {
    service: {
      processAlive: !!lock && alive(lock.pid),
      lastInboundAt: runtime.lastInboundAt || null,
      startedAt: runtime.startedAt || null,
    },
    model: {
      provider: config.model.provider,
      configured: config.model.name || null,
      lastReported: runtime.lastActualModel || null,
      lastResponseAt: runtime.lastModelAt || null,
      inferenceVerifiedNow: false,
    },
    knowledge: { enabled: config.knowledge?.enabled === true },
    queue: queue?.snapshot() || null,
    workspaces: {
      feishu: await usage(local.root),
      ketupa: await usage(tasks.root),
    },
    note: "Process liveness and previous activity are observations, not proof of current platform, inference or solver connectivity.",
  };
}
