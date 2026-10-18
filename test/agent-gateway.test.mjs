import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Gateway } from "../bridge/service.mjs";
import { Workspace } from "../feishu-workspace/store.mjs";
import { TaskWorkspace } from "../ketupa-workspace/tasks.mjs";

test("message redelivery after reply failure never resubmits a persisted task", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-redelivery-"));
  let gateway;
  try {
    const local = new Workspace(join(root, "local"));
    await local.init();
    const workflows = { demo: { inputs: {}, parameters: {}, builtin: "demo" } };
    const tasks = new TaskWorkspace(join(root, "tasks"), local, workflows);
    let responses = 0;
    const client = {
      im: {
        message: {
          reply: async () => {
            if (++responses === 1) throw new Error("transient reply failure");
            return { code: 0 };
          },
        },
      },
    };
    gateway = new Gateway(
      {
        feishu: { allowedUsers: ["owner"], allowedChats: ["chat"] },
        tasks: { workflows, autoRun: false },
        model: { sendChatToModel: false },
      },
      client,
      local,
      tasks,
    );
    const event = {
      sender: { sender_type: "user", sender_id: { open_id: "owner" } },
      message: {
        message_id: "same-message",
        chat_id: "chat",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "/task demo example {}" }),
      },
    };
    await gateway.receive(event);
    assert.equal((await tasks.list(local.key("chat", "owner"))).length, 1);
    await gateway.receive(event);
    assert.equal((await tasks.list(local.key("chat", "owner"))).length, 1);
  } finally {
    await gateway?.queue?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("authorized knowledge grounds chat; revocation resets context; greeting still answers", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-gateway-"));
  let gateway;
  try {
    const local = new Workspace(join(root, "local"));
    await local.init();
    const knowledge = join(local.root, "knowledge");
    await mkdir(knowledge);
    const content = "SerDes channel uses equalization.";
    await writeFile(join(knowledge, "note.md"), content);
    const entry = {
      id: "note",
      path: "note.md",
      sha256: createHash("sha256").update(content).digest("hex"),
      allowModel: true,
      allowedUsers: ["owner"],
      allowedChats: ["chat"],
    };
    const policy = () =>
      writeFile(
        join(knowledge, "manifest.json"),
        JSON.stringify({ documents: [entry] }),
      );
    await policy();
    const calls = [],
      replies = [];
    const config = {
      feishu: { allowedUsers: ["owner"], allowedChats: ["chat"] },
      model: { sendChatToModel: true, provider: "codex" },
      tasks: { workflows: {} },
      knowledge: { enabled: true },
    };
    const client = {
      im: {
        message: {
          reply: async (request) => {
            replies.push(request.data);
            return { code: 0 };
          },
        },
      },
    };
    const model = async (c, history, state, cwd, env, context) => {
      calls.push({ history, state: { ...state }, context });
      return {
        text: "自然回答",
        threadId: "continued-thread",
        actualModel: null,
      };
    };
    gateway = new Gateway(
      config,
      client,
      local,
      new TaskWorkspace(join(root, "tasks"), local, {}),
      { answer: model },
    );
    const event = (id, text) => ({
      sender: { sender_type: "user", sender_id: { open_id: "owner" } },
      message: {
        message_id: id,
        chat_id: "chat",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text }),
      },
    });
    await gateway.receive(event("1", "SerDes channel"));
    assert.equal(calls[0].context.evidence.length, 1);
    await gateway.receive(event("2", "SerDes equalization"));
    assert.equal(calls[1].state.threadId, "continued-thread");
    entry.allowModel = false;
    await policy();
    await gateway.receive(event("3", "hi"));
    assert.equal(calls[2].state.threadId, null);
    assert.equal(calls[2].context.evidence.length, 0);
    assert.deepEqual(calls[2].history, [{ role: "user", content: "hi" }]);
    assert.equal(replies.length, 3);
  } finally {
    await gateway?.queue?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("natural-language preview does not execute; explicit submit binds own file and is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-plan-"));
  let gateway;
  try {
    const local = new Workspace(join(root, "local"));
    await local.init();
    const workflows = {
      demo: {
        inputs: { source: [".txt"] },
        parameters: { message: { type: "string", maxLength: 200 } },
        builtin: "demo",
      },
    };
    const tasks = new TaskWorkspace(join(root, "tasks"), local, workflows);
    const key = local.key("chat", "owner");
    await local.saveAttachment(
      key,
      "upload",
      "sample.txt",
      Buffer.from("test only"),
    );
    const replies = [];
    const config = {
      feishu: { allowedUsers: ["owner"], allowedChats: ["chat"] },
      model: { sendChatToModel: true, provider: "codex" },
      tasks: { workflows, autoRun: false },
    };
    const client = {
      im: {
        message: {
          reply: async (request) => {
            replies.push(JSON.parse(request.data.content).text);
            return { code: 0 };
          },
        },
      },
    };
    gateway = new Gateway(config, client, local, tasks, {
      answer: async (c, h, s, cwd, env, context) => {
        assert.equal(context.planning, true);
        assert.ok(!context.instructions.includes(local.root));
        return {
          text: JSON.stringify({
            workflow: "demo",
            caseName: "example",
            params: { message: "hello" },
          }),
          threadId: "same-thread",
        };
      },
    });
    const event = (id, text) => ({
      sender: { sender_type: "user", sender_id: { open_id: "owner" } },
      message: {
        message_id: id,
        chat_id: "chat",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text }),
      },
    });
    await gateway.receive(event("1", "/plan 用附件创建一个演示任务"));
    assert.equal((await tasks.list(key)).length, 0);
    const planId = /预览 ([a-f0-9]{16})/.exec(replies.at(-1))[1];
    await gateway.receive(event("2", "/submit " + planId));
    await gateway.receive(event("3", "/submit " + planId));
    assert.equal((await tasks.list(key)).length, 1);
    assert.equal((await tasks.list(key))[0].status, "queued");
    await gateway.receive(event("4", "/run " + (await tasks.list(key))[0].id));
    await gateway.queue.idle();
    assert.equal((await tasks.list(key))[0].status, "succeeded");
  } finally {
    await gateway?.queue?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
