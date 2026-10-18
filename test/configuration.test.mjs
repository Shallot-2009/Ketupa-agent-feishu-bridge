import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, readFile, writeFile, rm, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../bridge/config.mjs";

test("init and load use config directory; reinitialization preserves local values", async () => {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const dir = await mkdtemp(join(tmpdir(), "gateway-config-"));
  try {
    for (const name of [
      "bridge",
      "feishu-workspace",
      "ketupa-workspace",
      "config",
    ])
      await cp(join(root, name), join(dir, name), { recursive: true });
    const init = () =>
      spawnSync(process.execPath, ["bridge/cli.mjs", "init"], {
        cwd: dir,
        encoding: "utf8",
        windowsHide: true,
      });
    assert.equal(init().status, 0);
    const target = join(dir, "config/settings.local.json");
    const c = JSON.parse(await readFile(target, "utf8"));
    assert.equal(c.workspace.local, "./feishu-workspace/runtime");
    assert.equal(c.workspace.tasks, "./ketupa-workspace/runtime");
    c.model.name = "chosen-model";
    await writeFile(target, JSON.stringify(c));
    await writeFile(
      join(dir, "config/.env"),
      "FEISHU_APP_SECRET=local-test-value\n",
    );
    assert.equal(init().status, 0);
    assert.equal((await loadConfig(dir)).model.name, "chosen-model");
    assert.match(
      await readFile(join(dir, "config/.env"), "utf8"),
      /local-test-value/,
    );
    await assert.rejects(() => access(join(dir, "config.local.json")));
    c.model.provider = "openai-compatible";
    await writeFile(target, JSON.stringify(c));
    const env = { ...process.env };
    delete env.FEISHU_APP_ID;
    delete env.FEISHU_APP_SECRET;
    const doctor = spawnSync(
      process.execPath,
      ["bridge/cli.mjs", "doctor", "--live"],
      { cwd: dir, env, encoding: "utf8", windowsHide: true },
    );
    assert.equal(doctor.status, 1);
    const diagnosis = JSON.parse(doctor.stdout);
    assert.equal(diagnosis.checks.feishuAuth, false);
    assert.equal(diagnosis.checks.feishuBot, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
