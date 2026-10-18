import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { getEventListeners } from "node:events";
import { pathToFileURL } from "node:url";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { Workspace } from "../feishu-workspace/store.mjs";
import { TaskWorkspace } from "../ketupa-workspace/tasks.mjs";
import { run } from "../bridge/process.mjs";
const queueModule = await import("../ketupa-workspace/queue.mjs").catch(
  () => ({}),
);

async function fixture(
  t,
  { concurrency = 1, maxPending = 50, onFinished } = {},
) {
  assert.equal(typeof queueModule.TaskQueue, "function");
  const root = await mkdtemp(join(tmpdir(), "public-queue-"));
  const local = new Workspace(join(root, "local"));
  await local.init();
  const workflows = {
    slow: {
      inputs: {},
      parameters: {},
      command: {
        file: process.execPath,
        args: [
          "-e",
          "require('fs').writeFileSync(require('path').join(process.env.TASK_OUTPUT_DIR,'started'),'yes'); setTimeout(()=>{},700)",
        ],
      },
    },
    demo: { inputs: {}, parameters: {}, builtin: "demo" },
    missing: {
      inputs: {},
      parameters: {},
      command: { file: join(root, "no-such-executor"), args: [] },
    },
    attachment: {
      inputs: { source: [".txt"] },
      parameters: {},
      builtin: "demo",
    },
  };
  const tasks = new TaskWorkspace(join(root, "tasks"), local, workflows);
  const queue = new queueModule.TaskQueue(tasks, {
    concurrency,
    maxPending,
    onFinished,
  });
  t.after(async () => {
    await queue.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    local,
    tasks,
    queue,
    key: local.key("chat", "owner"),
    workflows,
  };
}

async function started(job) {
  for (let n = 0; n < 300; n++) {
    if (
      (await readFile(join(job.dir, "output/started"), "utf8").catch(
        () => "",
      )) === "yes"
    )
      return;
    await delay(10);
  }
  assert.fail("executor did not start");
}

test("enqueue acknowledges before execution, preserves FIFO, and ignores duplicates", async (t) => {
  const completed = [];
  const { tasks, queue, key } = await fixture(t, {
    onFinished: async (job) => {
      completed.push(job.id);
    },
  });
  const first = await tasks.submit(key, "slow", "first");
  const second = await tasks.submit(key, "demo", "second");
  await queue.enqueue(key, first.id);
  await queue.enqueue(key, second.id);
  await queue.enqueue(key, second.id);
  assert.equal((await tasks.get(key, first.id)).finishedAt, undefined);
  assert.equal((await tasks.get(key, second.id)).status, "queued");
  await queue.idle();
  assert.deepEqual(completed, [first.id, second.id]);
  assert.deepEqual(queue.snapshot(), {
    running: 0,
    pending: 0,
    concurrency: 1,
  });
});

test("queue bounds concurrency and pending capacity and validates limits", async (t) => {
  const { tasks, queue, key } = await fixture(t, {
    concurrency: 2,
    maxPending: 1,
  });
  for (const options of [
    { concurrency: 0 },
    { concurrency: 1.5 },
    { maxPending: -1 },
    { maxPending: Infinity },
  ]) {
    assert.throws(
      () => new queueModule.TaskQueue(tasks, options),
      /concurrency|maxPending/,
    );
  }
  const jobs = await Promise.all(
    ["one", "two", "three", "four"].map((name) =>
      tasks.submit(key, "slow", name),
    ),
  );
  await queue.enqueue(key, jobs[0].id);
  await queue.enqueue(key, jobs[1].id);
  await Promise.all(jobs.slice(0, 2).map(started));
  await queue.enqueue(key, jobs[2].id);
  assert.deepEqual(queue.snapshot(), {
    running: 2,
    pending: 1,
    concurrency: 2,
  });
  await assert.rejects(() => readFile(join(jobs[2].dir, "output/started")), {
    code: "ENOENT",
  });
  await assert.rejects(() => queue.enqueue(key, jobs[3].id), /full/);
  assert.equal((await tasks.get(key, jobs[3].id)).status, "queued");
  await queue.idle();
  assert.equal((await tasks.get(key, jobs[2].id)).status, "succeeded");
});

test("queued and running cancellation persist and prevent delivery", async (t) => {
  const { tasks, queue, key } = await fixture(t);
  const running = await tasks.submit(key, "slow", "running");
  const queued = await tasks.submit(key, "demo", "queued");
  await queue.enqueue(key, running.id);
  await queue.enqueue(key, queued.id);
  await started(running);
  assert.equal((await queue.cancel(key, queued.id)).status, "cancelled");
  assert.equal((await queue.cancel(key, running.id)).status, "cancelled");
  await queue.idle();
  for (const job of [running, queued]) {
    assert.equal((await tasks.get(key, job.id)).status, "cancelled");
    await assert.rejects(() => tasks.outputs(key, job.id), /not successful/);
    await assert.rejects(() => queue.enqueue(key, job.id), /already|queued/);
  }
});

test("cancellation wins when completion has prepared a stale success write", async (t) => {
  const { tasks, key } = await fixture(t);
  const job = await tasks.submit(key, "demo", "completion_race");
  const jobFile = join(job.dir, "state/job.json");
  const rename = fsPromises.rename;
  let releaseWrite, reportPrepared;
  const writeGate = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  const prepared = new Promise((resolve) => {
    reportPrepared = resolve;
  });
  let paused = false;
  // Pause only the actual atomic success rename, leaving cancellation writes real.
  fsPromises.rename = async (source, destination) => {
    if (
      !paused &&
      destination === jobFile &&
      JSON.parse(await readFile(source, "utf8")).status === "succeeded"
    ) {
      paused = true;
      reportPrepared();
      await writeGate;
    }
    return rename(source, destination);
  };
  syncBuiltinESMExports();
  const execution = tasks.run(key, job.id);
  try {
    await prepared;
    assert.equal((await tasks.cancel(key, job.id)).status, "cancelled");
    releaseWrite();
    assert.equal((await execution).status, "cancelled");
    assert.equal((await tasks.get(key, job.id)).status, "cancelled");
    assert.equal(
      JSON.parse(await readFile(jobFile, "utf8")).status,
      "cancelled",
    );
    await assert.rejects(() => tasks.outputs(key, job.id), /not successful/);
  } finally {
    releaseWrite();
    await execution.catch(() => {});
    fsPromises.rename = rename;
    syncBuiltinESMExports();
  }
});

test("a cancellation marker overrides stale terminal state before and after recovery", async (t) => {
  const { tasks, queue, key } = await fixture(t);
  const job = await tasks.submit(key, "demo", "crashed_completion");
  await tasks.run(key, job.id);
  await writeFile(
    join(job.dir, "state/cancel.request"),
    new Date().toISOString(),
  );
  assert.equal((await tasks.get(key, job.id)).status, "cancelled");
  assert.equal((await tasks.list(key))[0].status, "cancelled");
  await assert.rejects(() => tasks.outputs(key, job.id), /not successful/);
  await queue.recover();
  assert.equal(
    JSON.parse(await readFile(join(job.dir, "state/job.json"), "utf8")).status,
    "cancelled",
  );
  assert.match(
    await readFile(join(job.dir, "ARCHIVE.md"), "utf8"),
    /status: cancelled/,
  );
});

test("cancelling an already completed task preserves its successful result", async (t) => {
  const { tasks, key } = await fixture(t);
  const job = await tasks.submit(key, "demo", "already_finished");
  await tasks.run(key, job.id);
  assert.equal((await tasks.cancel(key, job.id)).status, "succeeded");
  assert.equal((await tasks.outputs(key, job.id)).length, 1);
  await assert.rejects(() => readFile(join(job.dir, "state/cancel.request")), {
    code: "ENOENT",
  });
});

test("conversation and queue ownership prevent access or concurrent service recovery", async (t) => {
  const { root, local, tasks, queue, key, workflows } = await fixture(t);
  const job = await tasks.submit(key, "slow", "owner");
  const other = local.key("chat", "other");
  await assert.rejects(() => queue.enqueue(other, job.id), /not found/);
  await assert.rejects(() => queue.cancel(other, job.id), /not found/);
  await queue.enqueue(key, job.id);
  await started(job);
  const rivalTasks = new TaskWorkspace(join(root, "tasks"), local, workflows);
  const rival = new queueModule.TaskQueue(rivalTasks);
  t.after(() => rival.shutdown());
  await assert.rejects(() => rival.recover(), /owner|active|another/);
  await assert.rejects(() => rivalTasks.recover(), /owner|active|another/);
  assert.equal((await tasks.get(key, job.id)).status, "running");
});

test("startup recovery marks claimed work interrupted, preserves cancellation and never schedules queued tasks", async (t) => {
  const { root, local, tasks, queue, key, workflows } = await fixture(t);
  const interrupted = await tasks.submit(key, "demo", "interrupted");
  const claimed = await tasks.submit(key, "demo", "claimed");
  const cancelled = await tasks.submit(key, "demo", "cancelled");
  const untouched = await tasks.submit(key, "demo", "untouched");
  await writeFile(
    join(interrupted.dir, "state/job.json"),
    JSON.stringify({ ...interrupted, dir: undefined, status: "running" }),
  );
  await writeFile(join(claimed.dir, "state/run.claim"), "old claim");
  await writeFile(join(cancelled.dir, "state/cancel.request"), "requested");
  await writeFile(
    join(root, "tasks/.queue-owner.json"),
    JSON.stringify({ pid: 2147483647, token: "dead-owner" }),
  );
  await queue.recover();
  assert.equal((await tasks.get(key, interrupted.id)).status, "interrupted");
  assert.equal((await tasks.get(key, claimed.id)).status, "interrupted");
  assert.equal((await tasks.get(key, cancelled.id)).status, "cancelled");
  assert.equal((await tasks.get(key, untouched.id)).status, "queued");
  assert.equal(queue.snapshot().running, 0);
  await assert.rejects(() => tasks.run(key, claimed.id), /already/);
  const listed = await tasks.list(key);
  assert.equal(listed.length, 4);
  assert.ok(listed.every((job) => !("dir" in job)));
  assert.deepEqual(await tasks.list(local.key("chat", "other")), []);
  await assert.rejects(() => tasks.list(key, -1), /limit/);
});

test("failed executor and throwing completion callbacks do not wedge the queue", async (t) => {
  const { tasks, queue, key } = await fixture(t, {
    onFinished: async () => {
      throw new Error("delivery unavailable");
    },
  });
  const failed = await tasks.submit(key, "missing", "failed");
  const next = await tasks.submit(key, "demo", "next");
  await queue.enqueue(key, failed.id);
  await queue.enqueue(key, next.id);
  await queue.idle();
  assert.equal((await tasks.get(key, failed.id)).status, "failed");
  assert.equal((await tasks.get(key, next.id)).status, "succeeded");
});

test("unconfigured workflow is rejected at admission instead of remaining silently queued", async (t) => {
  const { tasks, queue, key, workflows } = await fixture(t);
  workflows.unconfigured = { inputs: {}, parameters: {} };
  const job = await tasks.submit(key, "unconfigured", "case");
  await assert.rejects(
    () => queue.enqueue(key, job.id),
    /executor not configured/,
  );
  assert.deepEqual(queue.snapshot(), {
    running: 0,
    pending: 0,
    concurrency: 1,
  });
});

test("queued cancellation callbacks may enqueue follow-up work", async (t) => {
  let queue, tasks, key, followup, cancelledId;
  const context = await fixture(t, {
    onFinished: async (job) => {
      if (job.id === cancelledId) await queue.enqueue(key, followup.id);
    },
  });
  ({ queue, tasks, key } = context);
  const running = await tasks.submit(key, "slow", "running");
  const cancelled = await tasks.submit(key, "demo", "cancelled");
  followup = await tasks.submit(key, "demo", "followup");
  cancelledId = cancelled.id;
  await queue.enqueue(key, running.id);
  await queue.enqueue(key, cancelled.id);
  const cancellation = queue.cancel(key, cancelled.id);
  let timeout;
  try {
    await Promise.race([
      cancellation,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("cancellation callback deadlocked")),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  await queue.idle();
  assert.equal((await tasks.get(key, followup.id)).status, "succeeded");
});

test("shutdown cancels owned tasks, releases its owner and rejects new work", async (t) => {
  const { tasks, queue, key } = await fixture(t);
  const jobs = await Promise.all(
    ["one", "two"].map((name) => tasks.submit(key, "slow", name)),
  );
  await queue.enqueue(key, jobs[0].id);
  await queue.enqueue(key, jobs[1].id);
  await started(jobs[0]);
  await queue.shutdown();
  assert.deepEqual(
    (await Promise.all(jobs.map((job) => tasks.get(key, job.id)))).map(
      (job) => job.status,
    ),
    ["cancelled", "cancelled"],
  );
  await assert.rejects(() => queue.enqueue(key, jobs[0].id), /closed|shutdown/);
});

test("shutdown does not repeat an in-flight queued cancellation notification", async (t) => {
  let cancelledId, notifyStarted, releaseNotification;
  const startedNotification = new Promise((resolve) => {
    notifyStarted = resolve;
  });
  const notificationGate = new Promise((resolve) => {
    releaseNotification = resolve;
  });
  let notifications = 0;
  const { tasks, queue, key } = await fixture(t, {
    onFinished: async (job) => {
      if (job.id !== cancelledId) return;
      notifications++;
      notifyStarted();
      await notificationGate;
    },
  });
  const running = await tasks.submit(key, "slow", "running");
  const cancelled = await tasks.submit(key, "demo", "cancelled");
  cancelledId = cancelled.id;
  await queue.enqueue(key, running.id);
  await queue.enqueue(key, cancelled.id);
  await queue.cancel(key, cancelled.id);
  await startedNotification;
  const shutdown = queue.shutdown();
  await delay(100);
  releaseNotification();
  await shutdown;
  assert.equal(notifications, 1);
});

test("input copy verifies attachment content against its recorded hash", async (t) => {
  const { local, tasks, key } = await fixture(t);
  const attachment = await local.saveAttachment(
    key,
    "message",
    "input.txt",
    Buffer.from("original"),
  );
  await writeFile(attachment.path, "tampered");
  await assert.rejects(
    () => tasks.submit(key, "attachment", "case"),
    /integrity|hash/,
  );
});

test("executor accepts an already aborted signal without spawning", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await run(
    process.execPath,
    ["-e", 'process.stdout.write("spawned")'],
    { signal: controller.signal },
  );
  assert.equal(result.code, "CANCELLED");
  assert.equal(result.stdout, "");
});

test("direct task execution persists an already requested cancellation", async (t) => {
  const { tasks, key } = await fixture(t);
  const job = await tasks.submit(key, "demo", "cancel");
  const signal = AbortSignal.abort();
  assert.equal((await tasks.run(key, job.id, { signal })).status, "cancelled");
});

test("admission rejects a queued job claimed by an earlier process", async (t) => {
  const { tasks, queue, key } = await fixture(t);
  const job = await tasks.submit(key, "demo", "claimed");
  await writeFile(join(job.dir, "state/run.claim"), "old claim");
  await assert.rejects(
    () => queue.enqueue(key, job.id),
    /already|claim|recovery/,
  );
  assert.equal(queue.snapshot().pending, 0);
});

test("copied input integrity is checked again before executor launch", async (t) => {
  const { local, tasks, queue, key } = await fixture(t);
  await local.saveAttachment(
    key,
    "message",
    "input.txt",
    Buffer.from("original"),
  );
  const job = await tasks.submit(key, "attachment", "case");
  await writeFile(join(job.dir, job.inputs.source.path), "modified");
  await queue.enqueue(key, job.id);
  await queue.idle();
  assert.equal((await tasks.get(key, job.id)).status, "failed");
  await assert.rejects(() => readFile(join(job.dir, "output/result.json")), {
    code: "ENOENT",
  });
});

test("abort terminates the executor process tree and removes its listener", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "public-process-"));
  const pidFile = join(root, "child.pid");
  const controller = new AbortController();
  const leaf =
    "require('fs').writeFileSync(process.env.TREE_PID_FILE,String(process.pid));setInterval(()=>{},1000)";
  const script = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{windowsHide:true,stdio:'ignore'});setInterval(()=>{},1000)`;
  const result = run(process.execPath, ["-e", script], {
    env: { ...process.env, TREE_PID_FILE: pidFile },
    signal: controller.signal,
  });
  t.after(async () => {
    controller.abort();
    await result;
    await rm(root, { recursive: true, force: true });
  });
  let pid;
  for (let n = 0; n < 300 && !pid; n++) {
    pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
    if (!pid) await delay(10);
  }
  assert.ok(pid, "child process did not start");
  controller.abort();
  assert.equal((await result).code, "CANCELLED");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  let alive = true;
  for (let n = 0; n < 100 && alive; n++) {
    try {
      process.kill(pid, 0);
      await delay(10);
    } catch (error) {
      if (error.code === "ESRCH") alive = false;
      else throw error;
    }
  }
  assert.equal(alive, false, "executor descendant survived cancellation");
});

test("normal executor completion removes abort listeners", async () => {
  const controller = new AbortController();
  const result = await run(
    process.execPath,
    ["-e", 'process.stdout.write("done")'],
    { signal: controller.signal },
  );
  assert.equal(result.code, "0");
  assert.equal(result.stdout, "done");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  controller.abort();
});

test("independent processes cannot execute one task twice", async (t) => {
  const { root, local, tasks, key, workflows } = await fixture(t);
  const job = await tasks.submit(key, "slow", "exclusive");
  const moduleURL = pathToFileURL(
    join(import.meta.dirname, "../ketupa-workspace/tasks.mjs"),
  ).href;
  const storeURL = pathToFileURL(
    join(import.meta.dirname, "../feishu-workspace/store.mjs"),
  ).href;
  const script = `import {TaskWorkspace} from ${JSON.stringify(moduleURL)};import {Workspace} from ${JSON.stringify(storeURL)};const [root,local,key,id,workflows]=process.argv.slice(1);const tasks=new TaskWorkspace(root,new Workspace(local),JSON.parse(workflows));try{const result=await tasks.run(key,id);console.log(result.status);}catch{process.exitCode=2;}`;
  const args = [
    "--input-type=module",
    "-e",
    script,
    join(root, "tasks"),
    local.root,
    key,
    job.id,
    JSON.stringify(workflows),
  ];
  const results = await Promise.all([
    run(process.execPath, args, { env: process.env }),
    run(process.execPath, args, { env: process.env }),
  ]);
  assert.deepEqual(results.map((result) => result.code).sort(), ["0", "2"]);
  assert.equal((await tasks.get(key, job.id)).status, "succeeded");
});
