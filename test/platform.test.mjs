import { test } from "node:test";
import assert from "node:assert/strict";
const platform = await import("../bridge/platform.mjs").catch(() => ({}));

test("live probe checks authentication and bot identity, returning no account identifiers", async () => {
  assert.equal(typeof platform.probeFeishu, "function");
  let sent = 0;
  const credentials = { appId: "test-app", appSecret: "private-test-secret" };
  const client = {
    auth: {
      v3: {
        tenantAccessToken: {
          internal: async (req) => {
            assert.equal(req.data.app_secret, credentials.appSecret);
            return { code: 0, tenant_access_token: "private-test-token" };
          },
        },
      },
    },
  };
  const fetchImpl = async (url, opts) => {
    assert.equal(url, "https://open.feishu.cn/open-apis/bot/v3/info/");
    assert.equal(opts.headers.authorization, "Bearer private-test-token");
    sent++;
    return {
      ok: true,
      json: async () => ({
        code: 0,
        bot: { open_id: "private-test-id", activate_status: 2 },
      }),
    };
  };
  const result = await platform.probeFeishu({
    client,
    credentials,
    domain: "feishu",
    fetchImpl,
  });
  assert.deepEqual(result, { feishuAuth: true, feishuBot: true });
  assert.equal(sent, 1);
  assert.ok(!JSON.stringify(result).includes("private-test"));
});

test("probe fails closed on missing credentials, rejected authentication and invalid bot response", async () => {
  assert.equal(typeof platform.probeFeishu, "function");
  let called = 0;
  const client = {
    auth: {
      v3: {
        tenantAccessToken: {
          internal: async () => {
            called++;
            return { code: 1 };
          },
        },
      },
    },
  };
  assert.deepEqual(await platform.probeFeishu({ client, credentials: {} }), {
    feishuAuth: false,
    feishuBot: false,
  });
  assert.equal(called, 0);
  const credentials = { appId: "test", appSecret: "test" };
  assert.deepEqual(await platform.probeFeishu({ client, credentials }), {
    feishuAuth: false,
    feishuBot: false,
  });
  client.auth.v3.tenantAccessToken.internal = async () => ({
    code: 0,
    tenant_access_token: "token",
  });
  assert.deepEqual(
    await platform.probeFeishu({
      client,
      credentials,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ code: 0, bot: {} }),
      }),
    }),
    { feishuAuth: true, feishuBot: false },
  );
  assert.deepEqual(
    await platform.probeFeishu({
      client,
      credentials,
      fetchImpl: async () => {
        throw Error("private detail");
      },
    }),
    { feishuAuth: true, feishuBot: false },
  );
});
