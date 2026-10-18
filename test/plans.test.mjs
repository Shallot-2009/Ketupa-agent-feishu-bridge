import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../feishu-workspace/store.mjs";
import { TaskWorkspace } from "../ketupa-workspace/tasks.mjs";
import {
  buildPlan,
  parseCandidate,
  planningInstructions,
  PlanStore,
} from "../ketupa-workspace/plans.mjs";

const syntheticPath = (...parts) =>
  "Z" + ":" + String.fromCharCode(92) + parts.join(String.fromCharCode(92));

const workflows = {
  measure: {
    command: {
      file: syntheticPath("private", "executor.exe"),
      args: ["secret-token"],
    },
    parameters: {
      frequency: { type: "number", required: true, min: 1, max: 50 },
      label: { type: "string", maxLength: 20 },
    },
    inputs: { source: [".csv"] },
  },
};
const file = {
  id: "0123456789abcdef",
  name: "sample.csv",
  path: syntheticPath("private", "sample.csv"),
  sha256: "a".repeat(64),
};
const candidate = () => ({
  workflow: "measure",
  caseName: "sample",
  params: { frequency: 5 },
  files: {},
});

test("builds an immutable ready preview using a unique matching attachment", () => {
  const input = candidate();
  const plan = buildPlan(workflows, [file], input);
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.request, {
    params: { frequency: 5 },
    files: { source: file.id },
  });
  input.params.frequency = 99;
  assert.equal(plan.request.params.frequency, 5);
  assert.throws(() => {
    plan.request.params.frequency = 99;
  }, TypeError);
  assert.equal(Object.getPrototypeOf(plan), Object.prototype);
  assert.equal(JSON.stringify(plan).includes("private"), false);
});

test("preserves missing required parameters and ambiguous attachments for the user", () => {
  const plan = buildPlan(
    workflows,
    [file, { ...file, id: "fedcba9876543210" }],
    { ...candidate(), params: {} },
  );
  assert.equal(plan.ready, false);
  assert.equal(Object.hasOwn(plan.request.params, "frequency"), false);
  assert.ok(
    plan.missing.some((x) => x.kind === "parameter" && x.name === "frequency"),
  );
  assert.ok(
    plan.missing.some((x) => x.kind === "input" && x.reason === "ambiguous"),
  );
  const ready = buildPlan(
    workflows,
    [file, { ...file, id: "fedcba9876543210" }],
    { ...candidate(), files: { source: file.id } },
  );
  assert.equal(ready.ready, true);
});

test("rejects hallucinated commands, paths, workflow names and unknown properties", () => {
  for (const addition of [
    { command: "powershell" },
    { executable: "cmd.exe" },
    { path: syntheticPath("secret") },
  ]) {
    assert.throws(
      () => buildPlan(workflows, [file], { ...candidate(), ...addition }),
      /unknown/,
    );
  }
  assert.throws(
    () => buildPlan(workflows, [file], { ...candidate(), workflow: "unknown" }),
    /workflow/,
  );
  assert.throws(
    () =>
      buildPlan(workflows, [file], { ...candidate(), caseName: "../escape" }),
    /case/,
  );
  assert.throws(
    () =>
      buildPlan(workflows, [file], {
        ...candidate(),
        params: { command: "cmd.exe" },
      }),
    /parameter/,
  );
  assert.throws(
    () =>
      buildPlan(workflows, [file], {
        ...candidate(),
        files: { other: file.id },
      }),
    /input/,
  );
  assert.throws(
    () =>
      buildPlan(workflows, [file], {
        ...candidate(),
        params: { frequency: 5, label: "../private" },
      }),
    /path|parameter/,
  );
  assert.throws(
    () =>
      buildPlan(
        workflows,
        [file],
        JSON.parse(
          '{"workflow":"measure","caseName":"ok","params":{"__proto__":{}}}',
        ),
      ),
    /parameter/,
  );
});

test("rejects incorrect parameter types, limits and nonmatching explicit attachments", () => {
  for (const frequency of ["5", 0, 51, NaN])
    assert.throws(
      () =>
        buildPlan(workflows, [file], { ...candidate(), params: { frequency } }),
      /parameter/,
    );
  assert.throws(
    () =>
      buildPlan(workflows, [file], {
        ...candidate(),
        files: { source: "fedcba9876543210" },
      }),
    /attachment/,
  );
  assert.throws(
    () =>
      buildPlan(workflows, [{ ...file, name: "wrong.exe" }], {
        ...candidate(),
        files: { source: file.id },
      }),
    /attachment/,
  );
  assert.equal(buildPlan(workflows, [], candidate()).ready, false);
});

test("parses only bounded strict JSON candidates with optional JSON fence", () => {
  const source = JSON.stringify(candidate());
  assert.deepEqual(parseCandidate(source), candidate());
  assert.deepEqual(parseCandidate("```json\n" + source + "\n```"), candidate());
  for (const bad of [
    "return " + source,
    source + "\nmore",
    "[]",
    "null",
    "x".repeat(32769),
  ])
    assert.throws(() => parseCandidate(bad));
});

test("planning instructions expose schemas and attachment ids without command or filesystem paths", () => {
  const text = planningInstructions(workflows, [file]);
  assert.match(text, /frequency/);
  assert.match(text, new RegExp(file.id));
  assert.doesNotMatch(text, /private|executor|secret-token|command/);
});

test("catalog never forwards nonprimitive schema metadata or path-like enum values", () => {
  const configured = {
    measure: {
      parameters: {
        label: {
          type: "string",
          enum: ["safe", syntheticPath("private"), { path: "secret-token" }],
          maxLength: { private: true },
        },
      },
    },
  };
  const text = planningInstructions(configured, []);
  assert.match(text, /safe/);
  assert.doesNotMatch(text, /private|secret-token/);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "plan-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = new Workspace(root);
  await local.init();
  const conversation = local.key("chat", "owner");
  const attachment = await local.saveAttachment(
    conversation,
    "message",
    "sample.csv",
    Buffer.from("test"),
  );
  const store = new PlanStore(local);
  const plan = buildPlan(workflows, [attachment], candidate());
  return { root, local, conversation, attachment, store, plan };
}

test("persists conversation owned plans for one hour and validates their fingerprints", async (t) => {
  const { local, conversation, store, plan } = await fixture(t);
  const record = await store.save(conversation, plan);
  assert.match(record.id, /^[a-f0-9]{16}$/);
  assert.equal(
    Date.parse(record.expiresAt) - Date.parse(record.createdAt),
    3600000,
  );
  assert.deepEqual((await store.get(conversation, record.id)).plan, plan);
  await assert.rejects(
    store.get(local.key("other", "owner"), record.id),
    /not found/,
  );
  await assert.rejects(store.get(conversation, "../escape"), /not found/);
  const path = join(local.path(conversation), "plans", record.id + ".json");
  const changed = JSON.parse(await readFile(path, "utf8"));
  changed.plan.request.params.frequency = 6;
  await writeFile(path, JSON.stringify(changed));
  await assert.rejects(
    store.get(conversation, record.id),
    /fingerprint|changed/,
  );
});

test("rejects another conversation attachment and changed attachment fingerprints", async (t) => {
  const { local, conversation, store, plan } = await fixture(t);
  await assert.rejects(
    store.save(local.key("other", "owner"), plan),
    /attachment/,
  );
  const record = await store.save(conversation, plan);
  const attachments = await local.attachments(conversation);
  attachments[0].sha256 = "b".repeat(64);
  await writeFile(
    join(local.path(conversation), "attachments.json"),
    JSON.stringify(attachments),
  );
  await assert.rejects(store.get(conversation, record.id), /attachment/);
});

test("refuses expired and incomplete plans", async (t) => {
  const { local, conversation, store, plan } = await fixture(t);
  const record = await store.save(conversation, plan);
  const path = join(local.path(conversation), "plans", record.id + ".json");
  const expired = JSON.parse(await readFile(path, "utf8"));
  expired.expiresAt = new Date(0).toISOString();
  await writeFile(path, JSON.stringify(expired));
  await assert.rejects(store.get(conversation, record.id), /expired/);
  const incomplete = await store.save(
    conversation,
    buildPlan(workflows, [], { ...candidate(), params: {} }),
  );
  await assert.rejects(
    store.consume(conversation, incomplete.id, () =>
      assert.fail("must not submit"),
    ),
    /incomplete|ready/,
  );
});

test("consumes a plan once and returns the existing job after restart", async (t) => {
  const { local, conversation, store, plan } = await fixture(t);
  const record = await store.save(conversation, plan);
  const result = await store.consume(
    conversation,
    record.id,
    async (actual) => {
      assert.deepEqual(actual, plan);
      return { id: "job-one", dir: syntheticPath("private", "run") };
    },
  );
  assert.deepEqual(result, { id: "job-one" });
  assert.deepEqual(
    await new PlanStore(local).consume(conversation, record.id, () =>
      assert.fail("duplicate submission"),
    ),
    result,
  );
});

test("callback errors preserve the claim because their side effects are uncertain", async (t) => {
  const { conversation, store, plan } = await fixture(t);
  const record = await store.save(conversation, plan);
  await assert.rejects(
    store.consume(conversation, record.id, async () => {
      throw new Error("unavailable");
    }),
    /unavailable/,
  );
  await assert.rejects(
    store.consume(conversation, record.id, () =>
      assert.fail("uncertain duplicate"),
    ),
    /manual recovery/,
  );
});

test("archive failure after TaskWorkspace persists its job never permits a duplicate submission", async (t) => {
  const { root, local, conversation, store, plan } = await fixture(t);
  const tasks = new TaskWorkspace(join(root, "runs"), local, workflows);
  tasks.archive = async () => {
    throw new Error("archive disk failure");
  };
  const record = await store.save(conversation, plan);
  const submit = (preview) =>
    tasks.submit(
      conversation,
      preview.workflow,
      preview.caseName,
      preview.request,
    );
  await assert.rejects(
    store.consume(conversation, record.id, submit),
    /archive disk failure/,
  );
  const firstJobs = await readdir(tasks.root);
  assert.equal(firstJobs.length, 1);
  const persisted = JSON.parse(
    await readFile(join(tasks.root, firstJobs[0], "state", "job.json"), "utf8"),
  );
  assert.equal(persisted.conversation, conversation);
  assert.equal(persisted.status, "queued");
  await assert.rejects(
    new PlanStore(local).consume(conversation, record.id, submit),
    /manual recovery/,
  );
  assert.deepEqual(await readdir(tasks.root), firstJobs);
});

test("exclusive claims prevent duplicate concurrent consumption across store instances", async (t) => {
  const { local, conversation, store, plan } = await fixture(t);
  const record = await store.save(conversation, plan);
  let release, started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const first = store.consume(conversation, record.id, async () => {
    started();
    await gate;
    return { id: "only-job" };
  });
  await entered;
  await assert.rejects(
    new PlanStore(local).consume(conversation, record.id, () =>
      assert.fail("duplicate"),
    ),
    /in progress|recovery/,
  );
  release();
  assert.deepEqual(await first, { id: "only-job" });
});

test("an interrupted submission claim requires manual recovery and never resubmits", async (t) => {
  const { local, conversation, store, plan } = await fixture(t);
  const record = await store.save(conversation, plan);
  await writeFile(
    join(local.path(conversation), "plans", record.id + ".json.claim"),
    '{"pid":0}',
  );
  await assert.rejects(
    new PlanStore(local).consume(conversation, record.id, () =>
      assert.fail("uncertain duplicate"),
    ),
    /manual recovery/,
  );
});

test("detects changed attachment bytes even when registry metadata is unchanged", async (t) => {
  const { conversation, attachment, store, plan } = await fixture(t);
  const record = await store.save(conversation, plan);
  await writeFile(attachment.path, "modified");
  await assert.rejects(
    store.get(conversation, record.id),
    /attachment content changed/,
  );
});
