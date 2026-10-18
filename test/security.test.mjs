import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { validateConfig } from "../bridge/config.mjs";
import { auditFile } from "../scripts/release-policy.mjs";
const gitPolicy = await import("../scripts/git-audit.mjs").catch(() => ({}));

test("runtime cannot occupy configuration or application source directories", () => {
  const base = {
    feishu: { allowedUsers: [], allowedChats: [] },
    model: { provider: "codex" },
    workspace: {
      local: "feishu-workspace/runtime",
      tasks: "ketupa-workspace/runtime",
    },
    tasks: { workflows: {} },
  };
  assert.doesNotThrow(() => validateConfig(base, process.cwd()));
  for (const path of [
    "config/session",
    "bridge/runtime",
    "scripts/runtime",
    "docs/runtime",
    "release/runtime",
    "feishu-workspace",
    "ketupa-workspace",
  ]) {
    assert.throws(
      () =>
        validateConfig(
          { ...base, workspace: { ...base.workspace, local: path } },
          process.cwd(),
        ),
      /source|code|overlap/,
    );
  }
});

test("Git index audit rejects private files already tracked and symbolic-link blobs", async () => {
  assert.equal(typeof gitPolicy.auditGit, "function");
  const root = await mkdtemp(join(tmpdir(), "gateway-index-"));
  const git = (args, input) =>
    execFileSync("git", args, {
      cwd: root,
      input,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  try {
    git(["init", "--quiet"]);
    git(["config", "core.autocrlf", "false"]);
    await writeFile(join(root, "README.md"), "public");
    git(["add", "README.md"]);
    assert.deepEqual((await gitPolicy.auditGit(root)).findings, []);
    await writeFile(join(root, ".env"), "TEST_ONLY=not-a-real-credential");
    git(["add", "-f", ".env"]);
    git([
      "-c",
      "core.hooksPath=.git/no-hooks",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "test fixture",
    ]);
    assert.equal(git(["diff", "--cached", "--name-only"]).trim(), "");
    const result = await gitPolicy.auditGit(root);
    assert.ok(
      result.findings.some(
        (f) => f.file === ".env" && f.rule === "not-in-public-allowlist",
      ),
    );
    assert.ok(!JSON.stringify(result).includes("not-a-real-credential"));
    git(["rm", "--cached", "--quiet", ".env"]);
    const oid = git(["hash-object", "-w", "--stdin"], "../../private").trim();
    git([
      "update-index",
      "--add",
      "--cacheinfo",
      "120000," + oid + ",README.md",
    ]);
    assert.ok(
      (await gitPolicy.auditGit(root)).findings.some(
        (f) => f.file === "README.md" && f.rule === "unsafe-git-mode",
      ),
    );
    git([
      "update-index",
      "--add",
      "--cacheinfo",
      "160000," + git(["rev-parse", "HEAD"]).trim() + ",README.md",
    ]);
    assert.ok(
      (await gitPolicy.auditGit(root)).findings.some(
        (f) => f.file === "README.md" && f.rule === "unsafe-git-mode",
      ),
    );
    const large = git(
      ["hash-object", "-w", "--stdin"],
      "x".repeat(512 * 1024 + 1),
    ).trim();
    git([
      "update-index",
      "--add",
      "--cacheinfo",
      "100644," + large + ",README.md",
    ]);
    assert.ok(
      (await gitPolicy.auditGit(root)).findings.some(
        (f) => f.file === "README.md" && f.rule === "file-size-limit",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scanner detects literal app secrets and GitHub tokens without echoing values", () => {
  const secret = "0123456789abcdef".repeat(2),
    token = "ghp_" + "A".repeat(36);
  for (const text of [
    "FEISHU_APP_SECRET=" + secret,
    '"app_secret": "' + secret + '"',
    token,
  ]) {
    const findings = auditFile("README.md", text);
    assert.ok(findings.length > 0);
    assert.ok(!JSON.stringify(findings).includes(secret));
    assert.ok(!JSON.stringify(findings).includes(token));
  }
});
