import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InstanceLease, statusSnapshot } from "../bridge/operations.mjs";
import { Workspace } from "../feishu-workspace/store.mjs";

test("exclusive service lease refuses a second live instance and releases safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "service-lease-"));
  try {
    const first = new InstanceLease(root),
      second = new InstanceLease(root);
    await first.acquire();
    await assert.rejects(() => second.acquire(), /active/);
    await second.release();
    await assert.rejects(() => second.acquire(), /active/);
    await first.release();
    await second.acquire();
    await second.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("service startup reclaims a proven-dead PID and refuses ambiguous ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "stale-service-"));
  try {
    const path = join(root, "service.lock.json");
    await writeFile(
      path,
      JSON.stringify({ pid: 2147483647, token: "stopped-instance" }),
    );
    const lease = new InstanceLease(root);
    await lease.acquire();
    await lease.release();
    await writeFile(
      path,
      JSON.stringify({ pid: null, token: "unknown-instance" }),
    );
    await assert.rejects(() => new InstanceLease(root).acquire(), /active/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status distinguishes configuration from observed model without leaking paths or credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "redacted-status-"));
  try {
    const local = new Workspace(join(root, "local"));
    await local.init();
    await writeFile(
      join(local.root, "runtime.json"),
      JSON.stringify({
        lastActualModel: "served-model",
        lastModelAt: "test-time",
        secret: "NEVER_REPORT",
      }),
    );
    const result = await statusSnapshot(
      {
        model: { provider: "openai-compatible", name: "target-model" },
        knowledge: { enabled: true },
      },
      local,
      { root: join(root, "tasks") },
    );
    assert.equal(result.model.configured, "target-model");
    assert.equal(result.model.lastReported, "served-model");
    assert.ok(!JSON.stringify(result).includes(root));
    assert.ok(!JSON.stringify(result).includes("NEVER_REPORT"));
    assert.equal(result.model.inferenceVerifiedNow, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
