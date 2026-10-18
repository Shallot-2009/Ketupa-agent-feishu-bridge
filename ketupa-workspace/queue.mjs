import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFile, rename, unlink, stat } from "node:fs/promises";
import { directory, guard, readJson } from "../feishu-workspace/files.mjs";
import { ownerAlive } from "./tasks.mjs";

/** A bounded FIFO executor. Acknowledgements never wait for the executor. */
export class TaskQueue {
  constructor(
    tasks,
    { concurrency = 1, maxPending = 50, onFinished = async () => {} } = {},
  ) {
    if (
      !Number.isSafeInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 64
    )
      throw new Error("invalid queue concurrency");
    if (
      !Number.isSafeInteger(maxPending) ||
      maxPending < 0 ||
      maxPending > 10000
    )
      throw new Error("invalid queue maxPending");
    if (typeof onFinished !== "function")
      throw new Error("invalid completion callback");
    this.tasks = tasks;
    this.concurrency = concurrency;
    this.maxPending = maxPending;
    this.onFinished = onFinished;
    this.token = randomUUID();
    this.ownerFile = join(tasks.root, ".queue-owner.json");
    this.entries = new Map();
    this.pending = [];
    this.running = new Map();
    this.closed = false;
    this.owned = false;
    this.controls = Promise.resolve();
    this.lastError = null;
  }

  // Serialize admission and cancellation without putting executor work on this chain.
  control(operation) {
    const result = this.controls.then(operation);
    this.controls = result.catch(() => {});
    return result;
  }

  async owner({ recover = false } = {}) {
    await directory(this.tasks.root);
    const previous = await readJson(this.tasks.root, this.ownerFile, null);
    if (previous?.token === this.token) {
      this.owned = true;
      return;
    }
    if (previous) {
      if (ownerAlive(previous))
        throw new Error("another queue owner is active");
      if (!recover)
        throw new Error("queue owner stopped; startup recovery required");
      // The service must hold its exclusive startup lease before reclaiming a stale owner.
      const retired = this.ownerFile + "." + randomUUID() + ".stale";
      await guard(this.tasks.root, retired);
      await rename(this.ownerFile, retired);
      await unlink(retired);
    }
    try {
      await writeFile(
        this.ownerFile,
        JSON.stringify({
          pid: process.pid,
          token: this.token,
          startedAt: new Date().toISOString(),
        }),
        { flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      if (error.code === "EEXIST")
        throw new Error("another queue owner is active");
      throw error;
    }
    this.owned = true;
  }

  enqueue(conversation, id) {
    return this.control(async () => {
      if (this.closed) throw new Error("task queue is closed");
      const job = await this.tasks.get(conversation, id);
      const existing = this.entries.get(id);
      if (existing) return job;
      if (job.status !== "queued")
        throw new Error("task is not queued or already started");
      const rule = this.tasks.workflows[job.workflow];
      if (!rule || (!rule.command && !rule.builtin))
        throw new Error("executor not configured");
      await this.owner();
      const claim = join(job.dir, "state/run.claim");
      await guard(this.tasks.root, claim);
      const claimed = await stat(claim).then(
        () => true,
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
      if (claimed)
        throw new Error("task already claimed; startup recovery required");
      if (
        this.running.size >= this.concurrency &&
        this.pending.length >= this.maxPending
      )
        throw new Error("task queue is full");
      let resolve;
      const done = new Promise((finish) => {
        resolve = finish;
      });
      const entry = {
        conversation,
        id,
        controller: new AbortController(),
        done,
        resolve,
      };
      this.entries.set(id, entry);
      this.pending.push(entry);
      this.pump();
      return job;
    });
  }

  pump() {
    while (
      !this.closed &&
      this.pending.length &&
      this.running.size < this.concurrency
    ) {
      const entry = this.pending.shift();
      this.running.set(entry.id, entry);
      // Execution is detached from the admission promise; every rejection is consumed.
      setImmediate(() => {
        this.execute(entry).catch((error) => {
          this.lastError = error;
        });
      });
    }
  }

  complete(entry, job) {
    if (!entry.completion)
      entry.completion = (async () => {
        try {
          if (job) await this.onFinished(job);
        } catch (error) {
          this.lastError = error;
        } finally {
          this.entries.delete(entry.id);
          this.running.delete(entry.id);
          entry.resolve();
        }
      })();
    return entry.completion;
  }

  async execute(entry) {
    let job;
    try {
      const owner = await readJson(this.tasks.root, this.ownerFile, null);
      if (owner?.token !== this.token)
        throw new Error("task queue ownership lost");
      job = await this.tasks.run(entry.conversation, entry.id, {
        signal: entry.controller.signal,
      });
    } catch (error) {
      this.lastError = error;
      job = await this.tasks
        .get(entry.conversation, entry.id)
        .catch(() => null);
    } finally {
      await this.complete(entry, job);
      this.pump();
    }
  }

  cancel(conversation, id) {
    return this.control(async () => {
      // Validate the conversation before touching another conversation's controller.
      await this.tasks.get(conversation, id);
      if (this.closed) throw new Error("task queue is closed");
      await this.owner();
      const entry = this.entries.get(id);
      const job = await this.tasks.cancel(conversation, id);
      entry?.controller.abort();
      if (entry && !this.running.has(id)) {
        this.pending = this.pending.filter((item) => item !== entry);
        // Callbacks may admit follow-up jobs, so never await them inside control().
        this.complete(entry, job).catch((error) => {
          this.lastError = error;
        });
      }
      return job;
    });
  }

  snapshot() {
    return {
      running: this.running.size,
      pending: this.pending.length,
      concurrency: this.concurrency,
    };
  }

  async idle() {
    await this.controls;
    // Jobs admitted after this snapshot are outside this wait's contract.
    await Promise.all([...this.entries.values()].map((entry) => entry.done));
  }

  recover() {
    return this.control(async () => {
      if (this.closed) throw new Error("task queue is closed");
      if (this.entries.size) throw new Error("task queue is active");
      await this.owner({ recover: true });
      return this.tasks.recover({ ownerToken: this.token });
    });
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    this.shutdownPromise = (async () => {
      await this.controls;
      const entries = [...this.entries.values()];
      this.pending = [];
      await Promise.all(
        entries.map(async (entry) => {
          let job;
          try {
            job = await this.tasks.cancel(entry.conversation, entry.id);
          } catch (error) {
            this.lastError = error;
          } finally {
            entry.controller.abort();
          }
          if (!this.running.has(entry.id)) await this.complete(entry, job);
        }),
      );
      await Promise.all(entries.map((entry) => entry.done));
      if (this.owned) {
        const owner = await readJson(this.tasks.root, this.ownerFile, null);
        if (owner?.token === this.token) await unlink(this.ownerFile);
        this.owned = false;
      }
    })();
    return this.shutdownPromise;
  }
}
