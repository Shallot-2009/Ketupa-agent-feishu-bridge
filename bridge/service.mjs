import { createHash } from "node:crypto";
import { join } from "node:path";
import { authorized } from "./config.mjs";
import { answer } from "./model.mjs";
import { directory } from "../feishu-workspace/files.mjs";
import { Knowledge } from "../feishu-workspace/knowledge.mjs";
import { TaskQueue } from "../ketupa-workspace/queue.mjs";
import {
  PlanStore,
  buildPlan,
  parseCandidate,
  planningInstructions,
} from "../ketupa-workspace/plans.mjs";
import { saveIncomingFile } from "./attachments.mjs";
import { handleCommand, formatPlan } from "./commands.mjs";
import { noteRuntime } from "./operations.mjs";

const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const SAFE_ERROR =
  /^(missing input: |ambiguous input: |missing parameter: |unknown parameter: |invalid parameter: |parameter out of range: |unknown workflow$|invalid case name$|executor not configured$|task not found$|task already started$|task is not successful$|output is empty$|chat consent not enabled$|format: |invalid task JSON$|attachment too large$|task queue is full$|task is not queued|plan not found$|plan expired$|plan is incomplete$|plan attachment |plan fingerprint changed$|submission in progress or interrupted; manual recovery required$)/;

export class Gateway {
  constructor(config, client, local, tasks, options = {}) {
    this.config = config;
    this.client = client;
    this.local = local;
    this.tasks = tasks;
    this.queues = new Map();
    this.answer = options.answer || answer;
    this.knowledge = new Knowledge(
      join(local.root, "knowledge"),
      config.knowledge,
    );
    this.plans = new PlanStore(local);
    this.queue = tasks.root
      ? new TaskQueue(tasks, {
          concurrency: config.tasks.concurrency ?? 1,
          maxPending: config.tasks.maxPending ?? 50,
          onFinished: async (job) =>
            local.append(job.conversation, {
              type: "task-finished",
              id: job.id,
              status: job.status,
            }),
        })
      : null;
  }

  receive(event) {
    const user = event.sender?.sender_id?.open_id,
      chat = event.message?.chat_id;
    if (
      event.sender?.sender_type !== "user" ||
      !authorized(this.config.feishu, user, chat)
    )
      return Promise.resolve();
    const key = this.local.key(chat, user),
      prior = this.queues.get(key) || Promise.resolve();
    const next = prior.catch(() => {}).then(() => this.handle(key, event));
    this.queues.set(key, next);
    return next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
  }

  async reply(id, text) {
    const result = await this.client.im.message.reply({
      path: { message_id: id },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text: text.slice(0, 12000) }),
      },
    });
    if (result.code !== 0) throw new Error("reply failed");
  }

  async refreshContext(key, user, chat, text) {
    const knowledge = await this.knowledge.query({
      user,
      chat,
      text: text.startsWith("/") ? "" : text,
    });
    let state = await this.local.state(key);
    const modelFingerprint = hash(this.config.model);
    if (
      state.knowledgeFingerprint !== knowledge.fingerprint ||
      state.modelFingerprint !== modelFingerprint
    ) {
      state = await this.local.resetContext(key, "policy-or-model-change");
      state.knowledgeFingerprint = knowledge.fingerprint;
      state.modelFingerprint = modelFingerprint;
      await this.local.saveState(key, state);
    }
    return { state, knowledge };
  }

  async infer(key, state, context) {
    const cwd = join(this.local.path(key), "model");
    await directory(this.local.root, cwd);
    const result = await this.answer(
      this.config.model,
      await this.local.history(key, this.config.model.maxHistoryMessages),
      state,
      cwd,
      process.env,
      context,
    );
    state.threadId = result.threadId;
    state.lastModel = {
      provider: this.config.model.provider,
      configured: this.config.model.name || null,
      reported: result.actualModel || null,
      at: new Date().toISOString(),
    };
    await this.local.saveState(key, state);
    await noteRuntime(this.local, {
      provider: state.lastModel.provider,
      configuredModel: state.lastModel.configured,
      lastActualModel: state.lastModel.reported,
      lastModelAt: state.lastModel.at,
    });
    return result;
  }

  async propose(key, description, state) {
    const attachments = await this.local.attachments(key);
    const result = await this.infer(key, state, {
      planning: true,
      instructions: planningInstructions(
        this.config.tasks.workflows || {},
        attachments,
      ),
    });
    const candidate = parseCandidate(result.text);
    const plan = buildPlan(
      this.config.tasks.workflows || {},
      attachments,
      candidate,
    );
    return formatPlan(await this.plans.save(key, plan));
  }

  async health(key) {
    const state = await this.local.state(key);
    // Chat diagnostics remain within this sender's scope; no other users' activity.
    return {
      model: {
        provider: this.config.model.provider,
        configured: this.config.model.name || null,
        lastReported: state.lastModel?.reported || null,
        lastResponseAt: state.lastModel?.at || null,
      },
      knowledgeEnabled: this.config.knowledge?.enabled === true,
      tasks: (await this.tasks.list(key, 20)).map(({ id, status }) => ({
        id,
        status,
      })),
    };
  }

  async handle(key, event) {
    const message = event.message;
    if ((await this.local.state(key)).seen?.includes(message.message_id))
      return;
    let content;
    try {
      content = JSON.parse(message.content);
    } catch {
      return;
    }
    const group = message.chat_type !== "p2p";
    try {
      if (["file", "image"].includes(message.message_type)) {
        if (!(await this.local.claimMessage(key, message.message_id))) return;
        const file = await saveIncomingFile(
          this.client,
          this.local,
          key,
          message,
          content,
        );
        if (!group)
          await this.reply(
            message.message_id,
            `已保存附件：${file.name}\n编号：${file.id}`,
          );
      } else if (message.message_type === "text") {
        const botOpenId = this.config.feishu.botOpenId;
        if (
          group &&
          this.config.feishu.requireMentionInGroups !== false &&
          (typeof botOpenId !== "string" ||
            !botOpenId.trim() ||
            !Array.isArray(message.mentions) ||
            !message.mentions.some((item) => item?.id?.open_id === botOpenId))
        )
          return;
        const text = String(content.text || "")
          .replace(/@_user_\d+/g, "")
          .trim();
        if (!text) return;
        if (text.length > 32000) throw new Error("message too large");
        if (!(await this.local.claimMessage(key, message.message_id))) return;
        const { state, knowledge } = await this.refreshContext(
          key,
          event.sender.sender_id.open_id,
          message.chat_id,
          text,
        );
        await this.local.append(key, { role: "user", content: text });
        const command = await handleCommand(this, {
          key,
          message,
          text,
          state,
        });
        const response = command.handled
          ? command.response
          : (await this.infer(key, state, { evidence: knowledge.evidence }))
              .text;
        if (response) {
          await this.local.append(key, {
            role: "assistant",
            content: response,
          });
          await this.reply(message.message_id, response);
        }
      } else {
        return;
      }
      const latest = await this.local.state(key);
      latest.seen = [...(latest.seen || []), message.message_id].slice(-300);
      await this.local.saveState(key, latest);
      await noteRuntime(this.local, {
        lastInboundAt: new Date().toISOString(),
      });
    } catch (error) {
      await this.local.append(key, { type: "error", code: "REQUEST_FAILED" });
      // Whitelist known validation errors; never echo SDK errors or model stdout.
      const reason = SAFE_ERROR.test(error.message)
        ? error.message
        : "请求未完成，请在本机运行 doctor 检查权限、模型和任务状态。";
      await this.reply(message.message_id, reason);
    }
  }
}
