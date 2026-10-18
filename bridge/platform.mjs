// Read-only platform diagnostics. Never log SDK responses or credentials.
export function quietLogger() {
  const error = () => console.error("FEISHU_SDK_ERROR (raw details withheld)");
  return {
    fatal: error,
    error,
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
  };
}

export async function makeClient(
  config,
  credentials = {
    appId: process.env.FEISHU_APP_ID,
    appSecret: process.env.FEISHU_APP_SECRET,
  },
) {
  const lark = await import("@larksuiteoapi/node-sdk");
  const http = new Proxy(lark.defaultHttpInstance, {
    get(target, key) {
      if (key === "request")
        return (opts) => target.request({ ...opts, timeout: 30000 });
      if (["get", "delete", "head", "options"].includes(key))
        return (url, opts) => target[key](url, { ...opts, timeout: 30000 });
      if (["post", "put", "patch"].includes(key))
        return (url, data, opts) =>
          target[key](url, data, { ...opts, timeout: 30000 });
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new lark.Client({
    ...credentials,
    domain:
      config.feishu.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
    logger: quietLogger(),
    httpInstance: http,
  });
}

export async function readFeishuIdentity({
  client,
  credentials,
  domain = "feishu",
  fetchImpl = fetch,
}) {
  if (!credentials?.appId || !credentials?.appSecret)
    return { authenticated: false, openId: null };
  let authenticated = false;
  try {
    const token = await client.auth.v3.tenantAccessToken.internal({
      data: { app_id: credentials.appId, app_secret: credentials.appSecret },
    });
    if (token.code !== 0 || !token.tenant_access_token)
      return { authenticated: false, openId: null };
    authenticated = true;
    const host =
      domain === "lark"
        ? "https://open.larksuite.com"
        : "https://open.feishu.cn";
    const r = await fetchImpl(host + "/open-apis/bot/v3/info/", {
      headers: { authorization: "Bearer " + token.tenant_access_token },
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (!r.ok) return { authenticated, openId: null };
    const body = await r.json();
    const id = body.code === 0 ? body.bot?.open_id : null;
    return {
      authenticated,
      openId: typeof id === "string" && id.length > 0 ? id : null,
    };
  } catch {
    return { authenticated, openId: null };
  }
}

export async function probeFeishu(options) {
  const r = await readFeishuIdentity(options);
  return { feishuAuth: r.authenticated, feishuBot: !!r.openId };
}
