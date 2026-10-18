import { buildPlan } from "../ketupa-workspace/plans.mjs";
import { deliverOutputs } from "./attachments.mjs";

export const HELP = [
  "直接聊天；附件自动保存。/files 查看附件，/workflows 查看流程。",
  "/plan 自然语言需求 → 参数预览；/preview 预览ID；/submit 预览ID。",
  "/task workflow case JSON 直接建任务；/run 任务ID 后台执行。",
  "/tasks 列表；/status 任务ID；/cancel 任务ID；/result 任务ID 仅交付 output。",
  "/reset 清除模型上下文（本地审计保留）；/health 诊断。",
].join("\n");

export function formatPlan(record) {
  const { plan } = record;
  const base = `预览 ${record.id}：${plan.workflow} / ${plan.caseName}\n参数：${JSON.stringify(plan.request.params)}\n文件：${JSON.stringify(plan.request.files)}`;
  if (!plan.ready)
    return (
      base +
      "\n待补充：" +
      plan.missing
        .map(
          (item) =>
            `${item.name}（${item.reason === "ambiguous" ? "有多个附件，请明确编号" : item.kind === "input" ? "缺文件" : "缺参数"}）`,
        )
        .join("、") +
      "。补充后重新 /plan。"
    );
  return (
    base + `\n尚未提交；确认后发送 /submit ${record.id}。预览一小时内有效。`
  );
}

export async function handleCommand(gateway, { key, message, text, state }) {
  if (!text.startsWith("/")) return { handled: false };
  const { local, tasks, config } = gateway;
  const split = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  const command = split[1],
    argument = (split[2] || "").trim();
  let response;
  switch (command) {
    case "/help":
      response = HELP;
      break;
    case "/files":
      response =
        (await local.attachments(key))
          .map((file) => `${file.id}  ${file.name}`)
          .join("\n") || "当前对话暂无附件。";
      break;
    case "/workflows":
      response =
        Object.entries(config.tasks.workflows || {})
          .map(
            ([name, rule]) =>
              `${name}：输入 ${Object.keys(rule.inputs || {}).join(", ") || "无"}；参数 ${Object.keys(rule.parameters || {}).join(", ") || "无"}`,
          )
          .join("\n") || "尚未配置流程。";
      break;
    case "/reset":
      await local.resetContext(key);
      response = "已清除模型上下文；本地记录继续保留。";
      break;
    case "/health":
      response = JSON.stringify(await gateway.health(key), null, 2);
      break;
    case "/plan":
      if (!argument) throw new Error("format: /plan 需求描述");
      response = await gateway.propose(key, argument, state);
      break;
    case "/preview":
      response = formatPlan(await gateway.plans.get(key, argument));
      break;
    case "/submit": {
      const result = await gateway.plans.consume(
        key,
        argument,
        async (plan) => {
          const current = buildPlan(
            config.tasks.workflows,
            await local.attachments(key),
            {
              workflow: plan.workflow,
              caseName: plan.caseName,
              ...plan.request,
            },
          );
          if (!current.ready) throw new Error("plan is incomplete");
          return tasks.submit(
            key,
            current.workflow,
            current.caseName,
            current.request,
          );
        },
      );
      const job = await tasks.get(key, result.id);
      if (config.tasks.autoRun && job.status === "queued")
        await gateway.queue.enqueue(key, job.id);
      response = `任务 ${job.id}：${config.tasks.autoRun ? "已加入后台队列" : "已建档；发送 /run " + job.id + " 执行"}。`;
      break;
    }
    case "/task": {
      const match = /^(\S+)\s+(\S+)(?:\s+([\s\S]+))?$/.exec(argument);
      if (!match) throw new Error("format: /task workflow case JSON");
      let request;
      try {
        request = match[3] ? JSON.parse(match[3]) : {};
      } catch {
        throw new Error("invalid task JSON");
      }
      const job = await tasks.submit(key, match[1], match[2], request);
      if (config.tasks.autoRun) await gateway.queue.enqueue(key, job.id);
      response = `任务已归档：${job.id}\n${config.tasks.autoRun ? "已加入后台队列" : "尚未执行，发送 /run " + job.id}`;
      break;
    }
    case "/run": {
      await gateway.queue.enqueue(key, argument);
      response = `${argument}：已加入后台队列，可继续聊天。/status ${argument} 查看状态。`;
      break;
    }
    case "/cancel": {
      const job = await gateway.queue.cancel(key, argument);
      response = `${job.id}：${job.status}`;
      break;
    }
    case "/status": {
      const job = await tasks.get(key, argument);
      response = `${job.id}：${job.status}`;
      break;
    }
    case "/tasks":
      response =
        (await tasks.list(key, 20))
          .map((job) => `${job.id}  ${job.status}`)
          .join("\n") || "当前对话暂无任务。";
      break;
    case "/result":
      await deliverOutputs(
        gateway.client,
        tasks,
        key,
        argument,
        message.message_id,
      );
      response = null;
      break;
    default:
      response = "未识别该命令。发送 /help 查看用法。";
  }
  return { handled: true, response };
}
