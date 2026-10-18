import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { PUBLIC_FILES, auditFile } from "./release-policy.mjs";

export async function auditGit(root, { stagedOnly = false, terms = [] } = {}) {
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const normalize = (p) => {
    const value = realpathSync(resolve(p));
    return process.platform === "win32" ? value.toLowerCase() : value;
  };
  if (
    normalize(git(["rev-parse", "--show-toplevel"]).trim()) !== normalize(root)
  )
    throw new Error("use the public repository root");
  const selected = stagedOnly
    ? new Set(
        git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])
          .split("\0")
          .filter(Boolean),
      )
    : null;
  const entries = git(["ls-files", "--stage", "-z"])
    .split("\0")
    .filter(Boolean);
  const findings = [];
  let checkedFiles = 0;
  for (const entry of entries) {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error("invalid Git index");
    const [, mode, oid, stage, file] = match;
    if (selected && !selected.has(file)) continue;
    if (!PUBLIC_FILES.includes(file) && file !== "docs/PUBLIC_MANIFEST.json") {
      findings.push({ file, rule: "not-in-public-allowlist" });
      continue;
    }
    if (stage !== "0" || !["100644", "100755"].includes(mode)) {
      findings.push({ file, rule: "unsafe-git-mode" });
      continue;
    }
    const bytes = Number(git(["cat-file", "-s", oid]).trim());
    if (!Number.isSafeInteger(bytes) || bytes > 512 * 1024) {
      findings.push({ file, rule: "file-size-limit" });
      continue;
    }
    const data = git(["cat-file", "blob", oid]);
    findings.push(...auditFile(file, data, terms));
    checkedFiles++;
  }
  return { checkedFiles, findings };
}
