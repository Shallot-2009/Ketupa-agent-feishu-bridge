import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const m = await import("../bridge/model.mjs").catch(() => ({}));
test("API model sends only bounded text context and validates reply", async () => {
  assert.equal(typeof m.answer, "function");
  let body;
  const s = createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer TEST_ONLY");
    let raw = "";
    for await (const b of req) raw += b;
    body = JSON.parse(raw);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({ choices: [{ message: { content: "short reply" } }] }),
    );
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try {
    const result = await m.answer(
      {
        provider: "openai-compatible",
        sendChatToModel: true,
        name: "example-model",
        maxHistoryMessages: 2,
      },
      [
        { role: "user", content: "old" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "new" },
      ],
      {},
      tmpdir(),
      {
        MODEL_BASE_URL: `http://127.0.0.1:${s.address().port}/v1`,
        MODEL_API_KEY: "TEST_ONLY",
      },
    );
    assert.equal(result.text, "short reply");
    assert.equal(body.messages.length, 3);
    assert.ok(!JSON.stringify(body).includes("old"));
  } finally {
    s.close();
  }
});
test("no model request without explicit chat consent", async () => {
  assert.equal(typeof m.answer, "function");
  await assert.rejects(
    () =>
      m.answer(
        { provider: "codex", sendChatToModel: false },
        [],
        {},
        tmpdir(),
        {},
      ),
    /consent/,
  );
});
test("Codex reuses the exact thread; prompts use stdin and secrets are not inherited", async () => {
  assert.equal(typeof m.answer, "function");
  const dir = await mkdtemp(join(tmpdir(), "gateway-model-"));
  try {
    const script = join(dir, "fake.mjs");
    await writeFile(
      script,
      `let text='';for await(const b of process.stdin)text+=b;if(process.env.FEISHU_APP_SECRET)process.exit(2);const args=process.argv.slice(2);const i=args.indexOf('resume');if(i<0||args[i+1]!=='existing-thread')process.exit(3);console.log(JSON.stringify({type:'thread.started',thread_id:'existing-thread'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'continued'}}));console.log(JSON.stringify({type:'turn.completed'}));`,
    );
    const v = await m.answer(
      {
        provider: "codex",
        sendChatToModel: true,
        command: { file: process.execPath, args: [script] },
      },
      [{ role: "user", content: "text with $(syntax)" }],
      { threadId: "existing-thread" },
      dir,
      { ...process.env, FEISHU_APP_SECRET: "NEVER_INHERIT" },
    );
    assert.equal(v.threadId, "existing-thread");
    assert.equal(v.text, "continued");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("per-turn evidence is bounded untrusted context and response model is reported", async () => {
  let body;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const b of req) raw += b;
    body = JSON.parse(raw);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        model: "served-example",
        choices: [{ message: { content: "answer" } }],
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const result = await m.answer(
      {
        provider: "openai-compatible",
        sendChatToModel: true,
        name: "configured-example",
        maxHistoryChars: 50,
      },
      [{ role: "user", content: "x".repeat(200) }],
      {},
      tmpdir(),
      {
        MODEL_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
        MODEL_API_KEY: "TEST_ONLY",
      },
      {
        evidence: [
          { id: "note", sha256: "test-hash", text: "untrusted document text" },
        ],
      },
    );
    assert.equal(result.actualModel, "served-example");
    assert.match(body.messages[0].content, /untrusted/i);
    assert.match(JSON.stringify(body), /untrusted document text/);
    assert.ok(body.messages.at(-1).content.length <= 50);
  } finally {
    server.close();
  }
});
