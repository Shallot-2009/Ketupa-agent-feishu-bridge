import { readFile } from "node:fs/promises";
import {
  resolve,
  relative,
  isAbsolute,
  basename,
  parse,
  extname,
} from "node:path";
export const shellNames = new Set([
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "sh",
  "bash",
  "zsh",
]);
export function authorized(c, user, chat) {
  return (
    c.allowedUsers?.includes(user) === true &&
    c.allowedChats?.includes(chat) === true
  );
}
export function validateConfig(c, base) {
  if (!c?.workspace || !c.model || !c.feishu || !c.tasks)
    throw new Error("configuration sections missing");
  for (const k of ["allowedUsers", "allowedChats"])
    if (
      !Array.isArray(c.feishu[k]) ||
      c.feishu[k].some((x) => typeof x !== "string")
    )
      throw new Error("permission arrays required");
  if (!["codex", "openai-compatible"].includes(c.model.provider))
    throw new Error("unknown model provider");
  const integer = (value, min, max, name) => {
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < min || value > max)
    )
      throw new Error("invalid limit: " + name);
  };
  integer(c.model.timeoutMs, 1000, 600000, "model.timeoutMs");
  integer(c.model.maxHistoryMessages, 1, 100, "model.maxHistoryMessages");
  integer(c.model.maxHistoryChars, 1, 64000, "model.maxHistoryChars");
  integer(c.model.maxOutputTokens, 16, 16000, "model.maxOutputTokens");
  integer(
    c.workspace.maxAttachmentBytes,
    1,
    128 * 1024 * 1024,
    "maxAttachmentBytes",
  );
  integer(c.tasks.concurrency, 1, 4, "tasks.concurrency");
  integer(c.tasks.maxPending, 1, 200, "tasks.maxPending");
  integer(
    c.knowledge?.maxEvidenceChars,
    100,
    8000,
    "knowledge.maxEvidenceChars",
  );
  integer(c.knowledge?.maxSnippets, 1, 5, "knowledge.maxSnippets");
  for (const [name, value] of [
    ["sendChatToModel", c.model.sendChatToModel],
    ["autoRun", c.tasks.autoRun],
    ["knowledge.enabled", c.knowledge?.enabled],
  ]) {
    if (value !== undefined && typeof value !== "boolean")
      throw new Error("invalid boolean: " + name);
  }
  const local = resolve(base, c.workspace.local),
    tasks = resolve(base, c.workspace.tasks);
  const contains = (a, b) => {
    const p = relative(a, b);
    return p === "" || (!p.startsWith("..") && !isAbsolute(p));
  };
  if (contains(local, tasks) || contains(tasks, local))
    throw new Error("workspaces overlap");
  for (const p of [local, tasks])
    if (p === parse(p).root || contains(p, resolve(base)))
      throw new Error("runtime must not contain application code");
  for (const p of [local, tasks]) {
    for (const name of [
      "bridge",
      "config",
      "scripts",
      "test",
      "docs",
      "licenses",
      ".github",
      ".githooks",
      "release",
      "node_modules",
    ]) {
      const code = resolve(base, name);
      if (contains(code, p) || contains(p, code))
        throw new Error("runtime overlaps application source or release");
    }
    for (const name of ["feishu-workspace", "ketupa-workspace"]) {
      if (
        contains(resolve(base, name), p) &&
        !contains(resolve(base, name, "runtime"), p)
      )
        throw new Error("runtime overlaps workspace source");
    }
  }
  const commandCheck = (command) => {
    if (
      command &&
      (typeof command.file !== "string" ||
        !command.file ||
        shellNames.has(basename(command.file).toLowerCase()) ||
        [".cmd", ".bat", ".ps1"].includes(
          extname(command.file).toLowerCase(),
        ) ||
        !Array.isArray(command.args) ||
        command.args.some((a) => typeof a !== "string" || a.includes("\0")))
    )
      throw new Error("shell or invalid command is prohibited");
  };
  commandCheck(c.model.command);
  for (const [id, w] of Object.entries(c.tasks.workflows || {})) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(id))
      throw new Error("invalid workflow");
    commandCheck(w.command);
    if (w.builtin && w.builtin !== "demo") throw new Error("unknown builtin");
    if (w.builtin && w.command)
      throw new Error("choose builtin or external executor");
    integer(w.timeoutMs, 1000, 86400000, "workflow timeoutMs");
    for (const [name, extensions] of Object.entries(w.inputs || {})) {
      if (
        !/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(name) ||
        !Array.isArray(extensions) ||
        !extensions.length ||
        extensions.some(
          (e) => typeof e !== "string" || !/^\.[a-z0-9]{1,12}$/.test(e),
        )
      )
        throw new Error("invalid input schema");
    }
    for (const [name, rule] of Object.entries(w.parameters || {})) {
      if (
        !/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(name) ||
        !rule ||
        !["string", "number", "boolean"].includes(rule.type)
      )
        throw new Error("invalid parameter schema");
      if (
        rule.enum &&
        (!Array.isArray(rule.enum) ||
          rule.enum.some((v) => typeof v !== rule.type))
      )
        throw new Error("invalid parameter enum");
      for (const bound of ["min", "max"])
        if (
          rule[bound] !== undefined &&
          (typeof rule[bound] !== "number" || !Number.isFinite(rule[bound]))
        )
          throw new Error("invalid parameter bound");
      if (
        rule.min !== undefined &&
        rule.max !== undefined &&
        rule.min > rule.max
      )
        throw new Error("invalid parameter range");
      integer(rule.maxLength, 1, 2000, "parameter maxLength");
    }
  }
  new Intl.DateTimeFormat("en", {
    timeZone: c.workspace.timezone || "UTC",
  }).format();
  return {
    ...c,
    tasks: { concurrency: 1, maxPending: 50, ...c.tasks },
    knowledge: {
      enabled: false,
      maxEvidenceChars: 4000,
      maxSnippets: 3,
      ...c.knowledge,
    },
    workspace: { ...c.workspace, local, tasks },
    base,
  };
}
export async function loadConfig(base = process.cwd()) {
  return validateConfig(
    JSON.parse(
      await readFile(resolve(base, "config/settings.local.json"), "utf8"),
    ),
    base,
  );
}
