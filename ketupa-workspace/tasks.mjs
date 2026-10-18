import { join, resolve, extname } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import {
  copyFile,
  writeFile,
  readFile,
  readdir,
  stat,
  rm,
} from "node:fs/promises";
import {
  directory,
  guard,
  atomic,
  readJson,
} from "../feishu-workspace/files.mjs";
import { run } from "../bridge/process.mjs";

export function validateParameters(schema = {}, values = {}) {
  const out = {};
  for (const key of Object.keys(values))
    if (!Object.hasOwn(schema, key))
      throw new Error("unknown parameter: " + key);
  for (const [key, r] of Object.entries(schema)) {
    const value = values[key];
    if (value === undefined) {
      if (r.required) throw new Error("missing parameter: " + key);
      continue;
    }
    if (
      !["string", "number", "boolean"].includes(r.type) ||
      typeof value !== r.type ||
      (r.type === "number" && !Number.isFinite(value))
    )
      throw new Error("invalid parameter: " + key);
    if (
      (r.enum && !r.enum.includes(value)) ||
      (r.min !== undefined && value < r.min) ||
      (r.max !== undefined && value > r.max) ||
      (r.maxLength && value.length > r.maxLength)
    )
      throw new Error("parameter out of range: " + key);
    if (key.startsWith("__")) throw new Error("invalid parameter");
    out[key] = value;
  }
  return out;
}
function timestamp(zone) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts();
  const get = (k) => p.find((x) => x.type === k).value;
  return (
    get("year") +
    get("month") +
    get("day") +
    "-" +
    get("hour") +
    get("minute") +
    get("second")
  );
}
const taskId = /^\d{8}-\d{6}_[a-zA-Z0-9_-]+_[a-f0-9]{8}$/;
const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
async function exists(root, path) {
  await guard(root, path);
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function cancellationState(root, dir, record) {
  // The request is durable before any job.json update and survives a stale writer.
  if (await exists(root, join(dir, "state/cancel.request")))
    return { ...record, status: "cancelled" };
  return record;
}
export function ownerAlive(owner) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
export class TaskWorkspace {
  constructor(root, local, workflows, zone = "UTC") {
    this.root = resolve(root);
    this.local = local;
    this.workflows = workflows;
    this.zone = zone;
    this.running = new Set();
  }
  async submit(conversation, workflow, caseName, request = {}) {
    this.local.path(conversation);
    if (!Object.hasOwn(this.workflows, workflow))
      throw new Error("unknown workflow");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(caseName))
      throw new Error("invalid case name");
    for (const k of Object.keys(request))
      if (!["params", "files"].includes(k))
        throw new Error("unknown request field");
    const rule = this.workflows[workflow],
      params = validateParameters(rule.parameters, request.params);
    const attachments = await this.local.attachments(conversation),
      inputs = {};
    for (const k of Object.keys(request.files || {}))
      if (!Object.hasOwn(rule.inputs || {}, k))
        throw new Error("unknown input");
    for (const [name, extensions] of Object.entries(rule.inputs || {})) {
      if (
        !/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(name) ||
        !Array.isArray(extensions)
      )
        throw new Error("invalid input configuration");
      const matching = attachments.filter(
        (f) =>
          extensions.includes(extname(f.name).toLowerCase()) &&
          (!request.files?.[name] || request.files[name] === f.id),
      );
      if (matching.length === 0) throw new Error("missing input: " + name);
      if (matching.length > 1)
        throw new Error("ambiguous input: " + name + "; specify attachment id");
      await guard(this.local.root, matching[0].path);
      inputs[name] = matching[0];
    }
    const id = `${timestamp(this.zone)}_${caseName}_${randomBytes(4).toString("hex")}`,
      dir = join(this.root, id);
    for (const sub of [
      "input",
      "cir",
      "include",
      "output",
      "logs",
      "temp",
      "state",
    ])
      await directory(this.root, join(dir, sub));
    const copied = {};
    try {
      for (const [name, f] of Object.entries(inputs)) {
        const destination = join(
          dir,
          "input",
          name + extname(f.name).toLowerCase(),
        );
        await guard(this.local.root, f.path);
        await copyFile(f.path, destination);
        const content = await readFile(destination),
          sha256 = createHash("sha256").update(content).digest("hex");
        if (sha256 !== f.sha256 || content.length !== f.bytes)
          throw new Error("input integrity check failed: " + name);
        copied[name] = {
          path: "input/" + name + extname(f.name).toLowerCase(),
          sha256,
          bytes: content.length,
        };
      }
    } catch (error) {
      await guard(this.root, dir);
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    const job = {
      id,
      conversation,
      workflow,
      caseName,
      params,
      inputs: copied,
      createdAt: new Date().toISOString(),
      status: "queued",
    };
    await atomic(this.root, join(dir, "state/job.json"), job);
    await this.archive(dir, job);
    return { ...job, dir };
  }
  async get(conversation, id) {
    if (!taskId.test(id)) throw new Error("task not found");
    const dir = join(this.root, id),
      job = await readJson(this.root, join(dir, "state/job.json"), null);
    if (!job || job.conversation !== conversation)
      throw new Error("task not found");
    return { ...(await cancellationState(this.root, dir, job)), dir };
  }
  async list(conversation, limit = 20) {
    this.local.path(conversation);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("invalid task list limit");
    await guard(this.root, this.root);
    const entries = await readdir(this.root, { withFileTypes: true }).catch(
      (error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    const jobs = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !taskId.test(entry.name)) continue;
      const job = await readJson(
        this.root,
        join(this.root, entry.name, "state/job.json"),
        null,
      );
      if (job?.conversation === conversation) {
        const { dir, ...record } = job;
        jobs.push(
          await cancellationState(
            this.root,
            join(this.root, entry.name),
            record,
          ),
        );
      }
    }
    return jobs
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
      )
      .slice(0, limit);
  }
  async cancel(conversation, id) {
    const job = await this.get(conversation, id);
    if (terminal.has(job.status)) return job;
    const marker = join(job.dir, "state/cancel.request");
    await guard(this.root, marker);
    try {
      await writeFile(marker, new Date().toISOString(), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const { dir, ...record } = await this.get(conversation, id);
    // Once the request exists, cancellation wins over a concurrent completion write.
    record.status = "cancelled";
    record.finishedAt = new Date().toISOString();
    await atomic(this.root, join(dir, "state/job.json"), record);
    await this.archive(dir, record);
    return { ...record, dir };
  }
  async recover({ ownerToken } = {}) {
    if (this.running.size) throw new Error("task execution is active");
    const owner = await readJson(
      this.root,
      join(this.root, ".queue-owner.json"),
      null,
    );
    if (owner && owner.token !== ownerToken && ownerAlive(owner))
      throw new Error("another queue owner is active");
    await guard(this.root, this.root);
    const entries = await readdir(this.root, { withFileTypes: true }).catch(
      (error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    const changed = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !taskId.test(entry.name)) continue;
      const dir = join(this.root, entry.name);
      const record = await readJson(
        this.root,
        join(dir, "state/job.json"),
        null,
      );
      if (!record) continue;
      if (await exists(this.root, join(dir, "state/cancel.request"))) {
        if (record.status === "cancelled") continue;
        record.status = "cancelled";
      } else if (terminal.has(record.status)) continue;
      else if (
        record.status === "running" ||
        (await exists(this.root, join(dir, "state/run.claim")))
      )
        record.status = "interrupted";
      else continue;
      record.finishedAt = new Date().toISOString();
      delete record.dir;
      await atomic(this.root, join(dir, "state/job.json"), record);
      await this.archive(dir, record);
      changed.push({ ...record, dir });
    }
    return changed;
  }
  async archive(dir, job) {
    const text =
      "# Task archive\n\n" +
      Object.entries({
        id: job.id,
        workflow: job.workflow,
        case: job.caseName,
        status: job.status,
        createdAt: job.createdAt,
        finishedAt: job.finishedAt || "pending",
      })
        .map(([k, v]) => `- ${k}: ${v}`)
        .join("\n") +
      "\n\n## Inputs\n\n```json\n" +
      JSON.stringify(job.inputs, null, 2) +
      "\n```\n\n## Parameters\n\n```json\n" +
      JSON.stringify(job.params, null, 2) +
      "\n```\n\nOnly output/ is eligible for delivery. Logs, input and netlists remain local.\n";
    const file = join(dir, "ARCHIVE.md");
    await guard(this.root, file);
    await writeFile(file, text, { mode: 0o600 });
  }
  async run(conversation, id, { signal } = {}) {
    const job = await this.get(conversation, id),
      rule = this.workflows[job.workflow];
    if (!rule || (!rule.command && !rule.builtin))
      throw new Error("executor not configured");
    if (this.running.has(id) || job.status !== "queued")
      throw new Error("task already started");
    const claim = join(job.dir, "state/run.claim");
    await guard(this.root, claim);
    try {
      await writeFile(claim, new Date().toISOString(), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (e) {
      if (e.code === "EEXIST") throw new Error("task already started");
      throw e;
    }
    this.running.add(id);
    const { dir, ...record } = job;
    const cancellationRequested = async () =>
      signal?.aborted ||
      (await exists(this.root, join(dir, "state/cancel.request")));
    try {
      if (await cancellationRequested())
        throw new Error("cancellation requested");
      record.status = "running";
      await atomic(this.root, join(dir, "state/job.json"), record);
      for (const input of Object.values(record.inputs || {})) {
        const path = join(dir, input.path);
        await guard(this.root, path);
        await guard(join(dir, "input"), path);
        const content = await readFile(path);
        if (
          content.length !== input.bytes ||
          createHash("sha256").update(content).digest("hex") !== input.sha256
        )
          throw new Error("input integrity check failed");
      }
      await guard(this.root, join(dir, "output"));
      await guard(this.root, join(dir, "logs"));
      if (rule.builtin === "demo")
        await writeFile(
          join(dir, "output/result.json"),
          JSON.stringify(
            {
              demo: true,
              note: "Interface test, not a simulation result",
              params: job.params,
              inputs: job.inputs,
            },
            null,
            2,
          ),
          { flag: "wx", mode: 0o600 },
        );
      else {
        const command = rule.command,
          args = command.args.map((x) =>
            x
              .replaceAll("{request}", join(dir, "state/job.json"))
              .replaceAll("{output}", join(dir, "output")),
          );
        const env = Object.fromEntries(
          ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"]
            .filter((k) => process.env[k])
            .map((k) => [k, process.env[k]]),
        );
        const result = await run(command.file, args, {
          cwd: dir,
          env: {
            ...env,
            TASK_REQUEST_FILE: join(dir, "state/job.json"),
            TASK_OUTPUT_DIR: join(dir, "output"),
          },
          timeout: rule.timeoutMs || 300000,
          signal,
        });
        await writeFile(
          join(dir, "logs/executor.log"),
          result.stdout + "\n" + result.stderr,
          { mode: 0o600 },
        );
        if (result.code !== "0")
          throw new Error("executor failed: " + result.code);
      }
      record.status = "succeeded";
    } catch {
      record.status = "failed";
    } finally {
      try {
        if (await cancellationRequested()) record.status = "cancelled";
        record.finishedAt = new Date().toISOString();
        await atomic(this.root, join(dir, "state/job.json"), record);
        await this.archive(dir, record);
        // Cancellation may have arrived after the first check but before the
        // terminal rename. Never write success after this final marker check.
        if (record.status !== "cancelled" && (await cancellationRequested())) {
          record.status = "cancelled";
          await atomic(this.root, join(dir, "state/job.json"), record);
          await this.archive(dir, record);
        }
      } finally {
        this.running.delete(id);
      }
    }
    return { ...(await cancellationState(this.root, dir, record)), dir };
  }
  async outputs(conversation, id) {
    const j = await this.get(conversation, id);
    if (j.status !== "succeeded") throw new Error("task is not successful");
    const out = join(j.dir, "output"),
      files = [];
    const visit = async (dir, prefix = "") => {
      await guard(this.root, dir);
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        await guard(this.root, p);
        if (e.isDirectory()) await visit(p, prefix + e.name + "/");
        else if (e.isFile()) {
          const s = await stat(p);
          if (s.size > 32 * 1024 * 1024) throw new Error("output too large");
          files.push({ name: prefix + e.name, path: p });
        }
        if (files.length > 20) throw new Error("too many outputs");
      }
    };
    await visit(out);
    return files;
  }
}
