import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  mkdir,
  copyFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const p = await import("../scripts/release-policy.mjs").catch(() => ({}));

test("default package output uses release directory and fixed project filename", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-release-output-"));
  try {
    const source = fileURLToPath(new URL("..", import.meta.url));
    for (const file of p.PUBLIC_FILES) {
      const target = join(root, file);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(source, file), target);
    }
    execFileSync(process.execPath, [join(root, "scripts/pack.mjs")], {
      cwd: root,
      windowsHide: true,
    });
    const zip = await readFile(
      join(root, "release", "ketupa-agent-feishu-bridge.zip"),
    );
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    assert.match(
      await readFile(
        join(root, "release", "ketupa-agent-feishu-bridge.zip.sha256"),
        "utf8",
      ),
      /  ketupa-agent-feishu-bridge\.zip/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("release allowlist excludes credentials, actual chats, cores and binaries", () => {
  assert.ok(Array.isArray(p.PUBLIC_FILES));
  for (const name of [
    ".env",
    "config/settings.local.json",
    "feishu-workspace/runtime/messages.jsonl",
    "ketupa-workspace/runtime/input.brd",
    "model.exe",
    ".git/config",
  ])
    assert.equal(p.PUBLIC_FILES.includes(name), false);
});
test("scanner rejects secrets and private terms without returning matched values", () => {
  assert.equal(typeof p.auditFile, "function");
  const secret = "sk-" + "A".repeat(25),
    privateName = "PRIVATE_CUSTOMER_NAME";
  const findings = p.auditFile("README.md", secret + " " + privateName, [
    privateName,
  ]);
  assert.ok(findings.length >= 2);
  assert.ok(!JSON.stringify(findings).includes(secret));
  assert.ok(!JSON.stringify(findings).includes(privateName));
  assert.equal(
    p.auditFile("README.md", "General configuration guide; no personal data.")
      .length,
    0,
  );
});

test("scanner rejects absolute machine paths in both separator styles", () => {
  for (const path of [
    "Z" + ":" + String.fromCharCode(92) + "private",
    "Z" + ":/private",
    "file:" + "///private",
  ]) {
    assert.ok(
      p.auditFile("README.md", path).some((f) => f.rule === "machine-path"),
    );
  }
});

test("packed repository keeps root JSON limited to npm metadata", async () => {
  const out = await mkdtemp(join(tmpdir(), "gateway-pack-"));
  try {
    await writeFile(
      join(out, "VALIDATION.json"),
      JSON.stringify({ sha256: "old-archive", testsPassed: 999 }),
    );
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL("../scripts/pack.mjs", import.meta.url)), out],
      { windowsHide: true },
    );
    const zip = await readFile(join(out, "ketupa-agent-feishu-bridge.zip"));
    const names = [];
    const report = JSON.parse(
      await readFile(join(out, "VALIDATION.json"), "utf8"),
    );
    assert.equal(report.sha256, createHash("sha256").update(zip).digest("hex"));
    assert.equal(report.testsPassed, null);
    for (let pos = 0; zip.readUInt32LE(pos) === 0x04034b50; ) {
      const size = zip.readUInt32LE(pos + 18),
        n = zip.readUInt16LE(pos + 26),
        extra = zip.readUInt16LE(pos + 28);
      names.push(
        zip
          .subarray(pos + 30, pos + 30 + n)
          .toString("utf8")
          .split("/")
          .slice(1)
          .join("/"),
      );
      pos += 30 + n + extra + size;
    }
    assert.deepEqual(names.filter((n) => /^[^/]+\.json$/.test(n)).sort(), [
      "package-lock.json",
      "package.json",
    ]);
    assert.ok(names.includes("docs/PUBLIC_MANIFEST.json"));
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
