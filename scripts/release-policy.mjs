import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
export const PUBLIC_FILES = [
  "config/.env.example",
  ".gitignore",
  ".gitattributes",
  ".githooks/pre-commit",
  ".github/workflows/ci.yml",
  "package.json",
  "package-lock.json",
  "config/README.md",
  "config/settings.example.json",
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "licenses/sdk-MIT.txt",
  "README.md",
  "SECURITY.md",
  "docs/CONFIGURE.md",
  "docs/AI_SETUP.md",
  "docs/PUBLISH.md",
  "docs/AUTHOR.md",
  "docs/SECURITY_REVIEW.md",
  "docs/KNOWLEDGE.md",
  "docs/TASK_QUEUE.md",
  "docs/PLANNING.md",
  "docs/OPERATIONS.md",
  "docs/ARCHITECTURE.md",
  "docs/COMPARISON.md",
  "bridge/config.mjs",
  "bridge/process.mjs",
  "bridge/model.mjs",
  "bridge/service.mjs",
  "bridge/cli.mjs",
  "bridge/platform.mjs",
  "bridge/attachments.mjs",
  "bridge/commands.mjs",
  "bridge/operations.mjs",
  "feishu-workspace/README.md",
  "feishu-workspace/files.mjs",
  "feishu-workspace/store.mjs",
  "feishu-workspace/knowledge.mjs",
  "ketupa-workspace/README.md",
  "ketupa-workspace/tasks.mjs",
  "ketupa-workspace/queue.mjs",
  "ketupa-workspace/plans.mjs",
  "scripts/release-policy.mjs",
  "scripts/release-check.mjs",
  "scripts/git-audit.mjs",
  "scripts/pack.mjs",
  "test/interfaces.test.mjs",
  "test/model.test.mjs",
  "test/gateway.test.mjs",
  "test/release.test.mjs",
  "test/configuration.test.mjs",
  "test/platform.test.mjs",
  "test/security.test.mjs",
  "test/knowledge.test.mjs",
  "test/queue.test.mjs",
  "test/plans.test.mjs",
  "test/context.test.mjs",
  "test/operations.test.mjs",
  "test/agent-gateway.test.mjs",
];
export function auditFile(file, content, privateTerms = []) {
  const out = [],
    report = (rule) => out.push({ file, rule });
  const patterns = {
    "api-key": /\bsk-[A-Za-z0-9_-]{20,}/,
    "github-token":
      /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/,
    "credential-assignment":
      /\b(?:FEISHU_APP_SECRET|MODEL_API_KEY|CODEX_API_KEY|app_secret|appSecret)["']?\s*[:=]\s*["']?[A-Za-z0-9+\/_=-]{24,}/,
    "private-key": /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    "platform-identifier": /\b(?:cli|ou|oc)_[a-zA-Z0-9]{12,}\b/,
    "personal-home":
      /[A-Za-z]:\\{1,2}Users\\{1,2}[a-zA-Z0-9_-]+|\/(?:home|Users)\/[a-zA-Z0-9_-]+\//,
    "machine-path": /\b[A-Za-z]:[\\/]|file:\/\/\//i,
    "credential-url": /https?:\/\/[^\s/@]+:[^\s/@]+@/,
    "signed-url":
      /[?&](?:access_token|tenant_access_token|app_secret|api_key|X-Amz-Signature)=[a-zA-Z0-9%_-]{12,}/i,
  };
  for (const [rule, re] of Object.entries(patterns))
    if (re.test(content)) report(rule);
  if (
    privateTerms.some(
      (t) => t && content.toLowerCase().includes(t.toLowerCase()),
    )
  )
    report("private-term");
  return out;
}
export async function auditSources(root, privateTerms = []) {
  const files = [],
    findings = [];
  for (const file of [...PUBLIC_FILES].sort()) {
    let current = root;
    for (const part of file.split("/")) {
      current = join(current, part);
      const s = await lstat(current);
      if (s.isSymbolicLink()) throw new Error("link prohibited: " + file);
    }
    const buffer = await readFile(current);
    if (buffer.length > 512 * 1024)
      throw new Error("release file too large: " + file);
    findings.push(...auditFile(file, buffer.toString("utf8"), privateTerms));
    files.push({
      path: file,
      bytes: buffer.length,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      buffer,
    });
  }
  if (files.reduce((sum, f) => sum + f.bytes, 0) > 2 * 1024 * 1024)
    throw new Error("release exceeds 2 MiB source budget");
  return { files, findings };
}
export async function privateTerms() {
  return process.env.RELEASE_PRIVATE_TERMS_FILE
    ? JSON.parse(await readFile(process.env.RELEASE_PRIVATE_TERMS_FILE, "utf8"))
        .terms || []
    : [];
}
