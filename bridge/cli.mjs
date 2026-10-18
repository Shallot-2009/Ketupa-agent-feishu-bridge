import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { loadConfig } from "./config.mjs";
import { Workspace } from "../feishu-workspace/store.mjs";
import { TaskWorkspace } from "../ketupa-workspace/tasks.mjs";
import { TaskQueue } from "../ketupa-workspace/queue.mjs";
import { Gateway } from "./service.mjs";
import { codexCommand, modelEnvironment } from "./model.mjs";
import { run } from "./process.mjs";
import { readJson } from "../feishu-workspace/files.mjs";
import {
  makeClient,
  quietLogger,
  readFeishuIdentity,
  probeFeishu,
} from "./platform.mjs";
import { InstanceLease, noteRuntime, statusSnapshot } from "./operations.mjs";

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] || "doctor";
const credentials = () => ({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
});

async function acquireLeases(config) {
  const leases = [];
  try {
    for (const root of [config.workspace.local, config.workspace.tasks]) {
      const lease = new InstanceLease(root);
      await lease.acquire();
      leases.push(lease);
    }
    return async () => {
      for (const lease of leases.reverse()) await lease.release();
    };
  } catch (error) {
    for (const lease of leases.reverse()) await lease.release();
    throw error;
  }
}

async function doctor(config, local, tasks) {
  const checks = {
    config: true,
    feishuCredentials:
      !!process.env.FEISHU_APP_ID && !!process.env.FEISHU_APP_SECRET,
    permissionUsers: config.feishu.allowedUsers.length > 0,
    permissionChats: config.feishu.allowedChats.length > 0,
    chatConsent: config.model.sendChatToModel === true,
    provider: config.model.provider,
  };
  if (config.model.provider === "codex") {
    try {
      const command = codexCommand(config.model.command);
      const result = await run(command.file, [...command.args, "--version"], {
        env: modelEnvironment(),
        timeout: 5000,
      });
      checks.codexBinary = result.code === "0";
    } catch {
      checks.codexBinary = false;
    }
  } else {
    checks.modelName = !!config.model.name;
    checks.modelCredentials =
      !!process.env.MODEL_BASE_URL && !!process.env.MODEL_API_KEY;
  }
  if (process.argv.includes("--live"))
    Object.assign(
      checks,
      checks.feishuCredentials
        ? await probeFeishu({
            client: await makeClient(config),
            credentials: credentials(),
            domain: config.feishu.domain,
          })
        : { feishuAuth: false, feishuBot: false },
    );
  console.log(
    JSON.stringify(
      {
        checks,
        status: await statusSnapshot(config, local, tasks),
        note: "Binary/config/auth checks do not prove inference, message delivery or simulation.",
      },
      null,
      2,
    ),
  );
  if (Object.values(checks).some((value) => value === false))
    process.exitCode = 1;
}

async function main() {
  if (mode === "init") {
    for (const [source, target] of [
      ["config/settings.example.json", "config/settings.local.json"],
      ["config/.env.example", "config/.env"],
    ]) {
      try {
        await copyFile(
          join(base, source),
          join(base, target),
          constants.COPYFILE_EXCL,
        );
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    console.log(
      "Local configuration prepared. Follow docs/CONFIGURE.md. Existing files preserved.",
    );
    return;
  }
  const config = await loadConfig(base);
  const local = new Workspace(
    config.workspace.local,
    config.workspace.maxAttachmentBytes,
  );
  await local.init();
  const tasks = new TaskWorkspace(
    config.workspace.tasks,
    local,
    config.tasks.workflows,
    config.workspace.timezone,
  );
  if (mode === "status") {
    console.log(
      JSON.stringify(await statusSnapshot(config, local, tasks), null, 2),
    );
    return;
  }
  if (mode === "doctor") {
    await doctor(config, local, tasks);
    return;
  }
  if (mode === "run") {
    const id = process.argv[3];
    if (!id || !/^[\w-]+$/.test(id)) throw new Error("task id required");
    const release = await acquireLeases(config),
      queue = new TaskQueue(tasks);
    try {
      await queue.recover();
      const record = await readJson(
        tasks.root,
        join(tasks.root, id, "state/job.json"),
        null,
      );
      if (!record) throw new Error("task not found");
      await queue.enqueue(record.conversation, id);
      await queue.idle();
      const job = await tasks.get(record.conversation, id);
      console.log(JSON.stringify({ id: job.id, status: job.status }));
      if (job.status !== "succeeded") process.exitCode = 1;
    } finally {
      await queue.shutdown();
      await release();
    }
    return;
  }
  if (!["start", "pair"].includes(mode)) throw new Error("unknown command");
  if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET)
    throw new Error("set Feishu credentials locally");
  if (
    mode === "start" &&
    (!config.feishu.allowedUsers.length || !config.feishu.allowedChats.length)
  )
    throw new Error("permission lists empty; run pair first");
  const release = await acquireLeases(config);
  let gateway,
    ws,
    closing = false,
    pairTimer;
  const cleanup = async () => {
    if (closing) return;
    closing = true;
    clearTimeout(pairTimer);
    await ws?.close({ force: true });
    if (gateway) {
      await Promise.allSettled([...gateway.queues.values()]);
      await gateway.queue.shutdown();
    }
    await release();
  };
  try {
    const lark = await import("@larksuiteoapi/node-sdk"),
      client = await makeClient(config);
    gateway = new Gateway(config, client, local, tasks);
    if (mode === "start") {
      await gateway.queue.recover();
      const identity = await readFeishuIdentity({
        client,
        credentials: credentials(),
        domain: config.feishu.domain,
      });
      if (identity.openId) config.feishu.botOpenId = identity.openId;
      else
        console.error(
          "GROUP_BOT_IDENTITY_UNAVAILABLE; mention-required group text will be ignored.",
        );
    }
    const pairing = mode === "pair" ? randomBytes(8).toString("hex") : null;
    let paired = false;
    if (pairing) {
      console.log(
        "Send this exact message in the bot private chat within 3 minutes: pair " +
          pairing,
      );
      pairTimer = setTimeout(() => {
        cleanup()
          .then(() => process.exit(paired ? 0 : 1))
          .catch(() => process.exit(1));
      }, 180000);
    }
    const events = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (event) => {
        if (closing) return;
        if (pairing) {
          const message = event.message;
          let text;
          try {
            text = JSON.parse(message.content).text;
          } catch {
            return;
          }
          if (
            paired ||
            message.chat_type !== "p2p" ||
            text !== "pair " + pairing ||
            event.sender?.sender_type !== "user"
          )
            return;
          paired = true;
          const raw = JSON.parse(
            await readFile(join(base, "config/settings.local.json"), "utf8"),
          );
          raw.feishu.allowedUsers = [
            ...new Set([
              ...raw.feishu.allowedUsers,
              event.sender.sender_id.open_id,
            ]),
          ];
          raw.feishu.allowedChats = [
            ...new Set([...raw.feishu.allowedChats, message.chat_id]),
          ];
          await writeFile(
            join(base, "config/settings.local.json"),
            JSON.stringify(raw, null, 2),
            { mode: 0o600 },
          );
          await gateway.reply(
            message.message_id,
            "本机账号绑定完成。请在本机启动服务。",
          );
          console.log("Paired. Local permission lists saved; no IDs printed.");
          setTimeout(() => {
            cleanup()
              .then(() => process.exit(0))
              .catch(() => process.exit(1));
          }, 500);
          return;
        }
        try {
          await gateway.receive(event);
        } catch {
          console.error("REQUEST_FAILED (raw details withheld)");
        }
      },
    });
    ws = new lark.WSClient({
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
      domain:
        config.feishu.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
      logger: quietLogger(),
    });
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => {
        cleanup()
          .then(() => process.exit(0))
          .catch(() => process.exit(1));
      });
    await ws.start({ eventDispatcher: events });
    await noteRuntime(local, { startedAt: new Date().toISOString() });
    console.log(
      pairing
        ? "Pairing listener started."
        : "Gateway started. Validate real delivery using docs/CONFIGURE.md.",
    );
  } catch (error) {
    await cleanup();
    throw error;
  }
}

main().catch(() => {
  console.error(
    "Command failed. Check local configuration, instance locks and docs/CONFIGURE.md. Secrets and raw errors are withheld.",
  );
  process.exitCode = 1;
});
