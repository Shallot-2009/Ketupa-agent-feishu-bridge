import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { auditSources, privateTerms } from "./release-policy.mjs";
import { auditGit } from "./git-audit.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
try {
  const terms = await privateTerms();
  let findings = [],
    count = 0;
  const stagedOnly = process.argv.includes("--staged");
  if (stagedOnly || process.argv.includes("--tracked")) {
    const result = await auditGit(root, { stagedOnly, terms });
    findings = result.findings;
    count = result.checkedFiles;
  } else {
    const result = await auditSources(root, terms);
    findings = result.findings;
    count = result.files.length;
    if (existsSync(join(root, ".git"))) {
      const index = await auditGit(root, { terms });
      findings.push(...index.findings);
    }
  }
  console.log(JSON.stringify({ checkedFiles: count, findings }, null, 2));
  if (findings.length) process.exitCode = 1;
} catch {
  console.error(
    "Release check failed: missing files, invalid index, link or size limit.",
  );
  process.exitCode = 1;
}
