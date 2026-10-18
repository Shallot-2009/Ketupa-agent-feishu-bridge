import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  symlink,
  rm,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const config = await import("../bridge/config.mjs").catch(() => ({}));
const store = await import("../feishu-workspace/store.mjs").catch(() => ({}));
const tasks = await import("../ketupa-workspace/tasks.mjs").catch(() => ({}));

test("permission defaults deny; users and chats both must match", () => {
  assert.equal(typeof config.authorized, "function");
  assert.equal(
    config.authorized({ allowedUsers: [], allowedChats: [] }, "u", "c"),
    false,
  );
  assert.equal(
    config.authorized({ allowedUsers: ["u"], allowedChats: ["c"] }, "u", "c"),
    true,
  );
  assert.equal(
    config.authorized({ allowedUsers: ["u"], allowedChats: ["c"] }, "x", "c"),
    false,
  );
});
test("configuration rejects overlapping workspaces and shell-like task commands", () => {
  assert.equal(typeof config.validateConfig, "function");
  const base = {
    feishu: { allowedUsers: [], allowedChats: [] },
    model: { provider: "codex" },
    workspace: { local: "data", tasks: "data/jobs" },
    tasks: { workflows: {} },
  };
  assert.throws(() => config.validateConfig(base, process.cwd()), /overlap/);
  base.workspace.tasks = "jobs";
  base.tasks.workflows.bad = {
    command: { file: "cmd.exe", args: ["/c", "anything"] },
  };
  assert.throws(() => config.validateConfig(base, process.cwd()), /shell/i);
});
test("conversation store isolates senders, persists context and contains filenames", async () => {
  assert.equal(typeof store.Workspace, "function");
  const dir = await mkdtemp(join(tmpdir(), "gateway-test-"));
  try {
    const w = new store.Workspace(dir);
    await w.init();
    const a = w.key("chat", "alice"),
      b = w.key("chat", "bob");
    assert.notEqual(a, b);
    await w.append(a, { role: "user", content: "hello" });
    await w.saveState(a, { threadId: "test-thread", seen: ["m1"] });
    const reopened = new store.Workspace(dir);
    assert.equal((await reopened.state(a)).threadId, "test-thread");
    assert.equal((await reopened.history(b, 10)).length, 0);
    assert.equal((await reopened.history(a, 10))[0].content, "hello");
    const f = await w.saveAttachment(
      a,
      "m1",
      "../../escape.txt",
      Buffer.from("safe"),
    );
    assert.ok(f.path.startsWith(dir));
    assert.ok(!f.name.includes(".."));
    assert.equal(await readFile(f.path, "utf8"), "safe");
    assert.throws(() => w.path("../escape"), /identifier/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("task boundary validates files and parameters; each submission owns one directory", async () => {
  assert.equal(typeof tasks.TaskWorkspace, "function");
  const dir = await mkdtemp(join(tmpdir(), "gateway-task-"));
  try {
    const w = new store.Workspace(join(dir, "local"));
    await w.init();
    const key = w.key("chat", "owner");
    const t = new tasks.TaskWorkspace(
      join(dir, "tasks"),
      w,
      {
        demo: {
          inputs: { source: [".txt"] },
          parameters: { count: { type: "number", min: 1, max: 5 } },
          builtin: "demo",
        },
      },
      "Asia/Shanghai",
    );
    await assert.rejects(
      () => t.submit(key, "demo", "example", { params: { count: 2 } }),
      /missing.*source/,
    );
    const f = await w.saveAttachment(key, "m", "a.txt", Buffer.from("input"));
    await assert.rejects(
      () => t.submit(key, "demo", "example", { params: { count: 20 } }),
      /parameter/,
    );
    await assert.rejects(
      () => t.submit(key, "demo", "example", { params: { shell: "whoami" } }),
      /parameter/,
    );
    await assert.rejects(
      () =>
        t.submit(w.key("chat", "other"), "demo", "example", {
          files: { source: f.id },
        }),
      /missing/,
    );
    const one = await t.submit(key, "demo", "example", {
        params: { count: 2 },
      }),
      two = await t.submit(key, "demo", "example", { params: { count: 2 } });
    assert.notEqual(one.id, two.id);
    assert.match(one.id, /^\d{8}-\d{6}_example_/);
    assert.ok((await readdir(one.dir)).includes("output"));
    assert.ok((await readdir(one.dir)).includes("ARCHIVE.md"));
    await assert.rejects(
      () => t.get(w.key("chat", "other"), one.id),
      /not found/,
    );
    const result = await t.run(key, one.id);
    assert.equal(result.status, "succeeded");
    const files = await t.outputs(key, one.id);
    assert.deepEqual(
      files.map((x) => x.name),
      ["result.json"],
    );
    assert.equal(JSON.parse(await readFile(files[0].path, "utf8")).demo, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("unconfigured execution never claims a successful simulation", async () => {
  assert.equal(typeof tasks.TaskWorkspace, "function");
  const dir = await mkdtemp(join(tmpdir(), "gateway-no-engine-"));
  try {
    const w = new store.Workspace(join(dir, "local"));
    await w.init();
    const k = w.key("c", "u");
    const t = new tasks.TaskWorkspace(join(dir, "tasks"), w, {
      custom: { inputs: {}, parameters: {} },
    });
    const job = await t.submit(k, "custom", "case", {});
    await assert.rejects(() => t.run(k, job.id), /executor/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("symlink output is rejected rather than disclosing a private file", async () => {
  assert.equal(typeof tasks.TaskWorkspace, "function");
  const dir = await mkdtemp(join(tmpdir(), "gateway-links-"));
  try {
    const w = new store.Workspace(join(dir, "local"));
    await w.init();
    const k = w.key("c", "u");
    const t = new tasks.TaskWorkspace(join(dir, "tasks"), w, {
      demo: { inputs: {}, parameters: {}, builtin: "demo" },
    });
    const j = await t.submit(k, "demo", "case", {});
    await t.run(k, j.id);
    await mkdir(join(dir, "private"));
    await writeFile(join(dir, "private", "secret.txt"), "secret");
    await symlink(
      join(dir, "private"),
      join(j.dir, "output", "outside"),
      "junction",
    );
    await assert.rejects(() => t.outputs(k, j.id), /link/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("two workers cannot execute the same queued task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-claim-"));
  try {
    const local = new store.Workspace(join(dir, "local"));
    await local.init();
    const k = local.key("c", "u");
    const workflows = { demo: { inputs: {}, parameters: {}, builtin: "demo" } };
    const a = new tasks.TaskWorkspace(join(dir, "tasks"), local, workflows),
      b = new tasks.TaskWorkspace(join(dir, "tasks"), local, workflows);
    const job = await a.submit(k, "demo", "case", {});
    const results = await Promise.allSettled([
      a.run(k, job.id),
      b.run(k, job.id),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
