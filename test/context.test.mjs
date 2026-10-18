import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workspace } from "../feishu-workspace/store.mjs";

test("context reset retains audit but removes earlier model history and thread", async () => {
  const root = await mkdtemp(join(tmpdir(), "context-reset-"));
  try {
    const local = new Workspace(root);
    const key = local.key("chat", "owner");
    await local.append(key, { role: "user", content: "old private context" });
    await local.saveState(key, { seen: ["message"], threadId: "old-thread" });
    await local.resetContext(key, "policy-change");
    assert.equal((await local.state(key)).threadId, null);
    assert.deepEqual((await local.state(key)).seen, ["message"]);
    await local.append(key, { role: "user", content: "new question" });
    assert.deepEqual(await local.history(key), [
      { role: "user", content: "new question" },
    ]);
    assert.match(
      await readFile(join(local.path(key), "messages.jsonl"), "utf8"),
      /old private context/,
    );
    assert.deepEqual(await local.history(local.key("chat", "other")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
