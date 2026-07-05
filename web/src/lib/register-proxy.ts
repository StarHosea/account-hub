/** 注册代理：无代理 / IPWeb 动态 / 固定 HTTP */

export type RegisterProxyMode = "none" | "ipweb" | "http";

export type IpwebProxyFields = {
  gateway: string;
  accountId: string;
  password: string;
};

export const DEFAULT_IPWEB_GATEWAY = "gate2.ipweb.cc:7778";
export const DEFAULT_IPWEB_ACCOUNT_ID = "88059";
export const DEFAULT_IPWEB_PASSWORD = "220807";
export const DEFAULT_HTTP_PROXY = "http://127.0.0.1:7890";

const IPWEB_TEMPLATE_SUFFIX = "_US_x_y_10_00000000";
const IPWEB_PORT = "7778";

type ParsedColon = {
  host: string;
  port: string;
  user: string;
  password: string;
};

export function defaultIpwebFields(): IpwebProxyFields {
  return {
    gateway: DEFAULT_IPWEB_GATEWAY,
    accountId: DEFAULT_IPWEB_ACCOUNT_ID,
    password: DEFAULT_IPWEB_PASSWORD,
  };
}

function parseColonProxy(raw: string): ParsedColon | null {
  const segs = raw.split(":");
  if (segs.length !== 4) return null;
  let host: string;
  let port: string;
  let user: string;
  let password: string;
  if (segs[0].includes(".")) {
    [host, port, user, password] = segs;
  } else if (segs[2].includes(".")) {
    [user, password, host, port] = segs;
  } else {
    [host, port, user, password] = segs;
  }
  if (!host || !/^\d+$/.test(port)) return null;
  return { host, port, user, password };
}

function parseUrlProxy(raw: string, defaultScheme = "http"): ParsedColon | null {
  try {
    const url = new URL(raw.includes("://") ? raw : `${defaultScheme}://${raw}`);
    const host = url.hostname;
    const port = url.port || (url.protocol === "https:" ? "443" : defaultScheme === "http" ? "80" : IPWEB_PORT);
    if (!host) return null;
    return {
      host,
      port,
      user: decodeURIComponent(url.username || ""),
      password: decodeURIComponent(url.password || ""),
    };
  } catch {
    return null;
  }
}

function parseProxyRaw(raw: string): ParsedColon | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.includes("://")) return parseUrlProxy(trimmed);
  return parseColonProxy(trimmed);
}

export function parseIpwebProxy(raw: string): IpwebProxyFields | null {
  const parsed = parseProxyRaw(raw);
  if (!parsed || !parsed.host.endsWith("ipweb.cc")) return null;
  const userSegs = parsed.user.split("_");
  if (userSegs.length < 7 || userSegs[0] !== "B" || !userSegs[1]) return null;
  return {
    gateway: `${parsed.host}:${parsed.port}`,
    accountId: userSegs[1],
    password: parsed.password,
  };
}

export function parseIpwebGateway(gateway: string): { host: string; port: string } | null {
  const g = gateway.trim();
  if (!g) return null;
  if (g.includes(":")) {
    const idx = g.lastIndexOf(":");
    const host = g.slice(0, idx).trim();
    const port = g.slice(idx + 1).trim();
    if (!host || !/^\d+$/.test(port)) return null;
    return { host, port };
  }
  return { host: g, port: IPWEB_PORT };
}

export function buildIpwebProxyTemplate(fields: IpwebProxyFields): string {
  const accountId = fields.accountId.trim();
  const password = fields.password.trim();
  const gw = parseIpwebGateway(fields.gateway);
  if (!gw || !accountId || !password) return "";
  if (!gw.host.endsWith("ipweb.cc")) return "";
  return `${gw.host}:${gw.port}:B_${accountId}${IPWEB_TEMPLATE_SUFFIX}:${password}`;
}

export function normalizeHttpProxy(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  if (t.includes("://")) {
    try {
      const url = new URL(t);
      const scheme = url.protocol === "https:" ? "https" : "http";
      const port = url.port || (scheme === "https" ? "443" : "80");
      const auth =
        url.username || url.password
          ? `${encodeURIComponent(decodeURIComponent(url.username))}${url.password ? `:${encodeURIComponent(decodeURIComponent(url.password))}` : ""}@`
          : "";
      return `${scheme}://${auth}${url.hostname}:${port}`;
    } catch {
      return "";
    }
  }
  if (/^\d+$/.test(t)) return `http://127.0.0.1:${t}`;
  const idx = t.lastIndexOf(":");
  if (idx > 0) {
    const host = t.slice(0, idx).trim();
    const port = t.slice(idx + 1).trim();
    if (host && /^\d+$/.test(port)) return `http://${host}:${port}`;
  }
  return `http://${t}`;
}

export function detectProxyMode(proxy: string, savedMode?: RegisterProxyMode | string): RegisterProxyMode {
  if (savedMode === "none" || savedMode === "ipweb" || savedMode === "http") {
    return savedMode;
  }
  const p = proxy.trim();
  if (!p) return "ipweb";
  if (parseIpwebProxy(p)) return "ipweb";
  return "http";
}

function hydrateIpwebFields(
  config: {
    proxy?: string;
    ipweb_gateway?: string;
    ipweb_account_id?: string;
    ipweb_password?: string;
  },
  mode: RegisterProxyMode,
): Required<Pick<typeof config, "ipweb_gateway" | "ipweb_account_id" | "ipweb_password">> {
  const parsed = parseIpwebProxy(String(config.proxy || ""));
  const defaults = defaultIpwebFields();
  const useDefaults = mode === "ipweb" && !parsed;
  return {
    ipweb_gateway: config.ipweb_gateway ?? parsed?.gateway ?? (useDefaults ? defaults.gateway : ""),
    ipweb_account_id: config.ipweb_account_id ?? parsed?.accountId ?? (useDefaults ? defaults.accountId : ""),
    ipweb_password: config.ipweb_password ?? parsed?.password ?? (useDefaults ? defaults.password : ""),
  };
}

export function hydrateRegisterProxyFields<T extends {
  proxy?: string;
  proxy_mode?: RegisterProxyMode | string;
  http_proxy?: string;
  ipweb_gateway?: string;
  ipweb_account_id?: string;
  ipweb_password?: string;
}>(config: T): T & {
  proxy_mode: RegisterProxyMode;
  http_proxy: string;
  ipweb_gateway: string;
  ipweb_account_id: string;
  ipweb_password: string;
} {
  const mode = detectProxyMode(String(config.proxy || ""), config.proxy_mode as RegisterProxyMode | undefined);
  const ipweb = hydrateIpwebFields(config, mode);
  const savedHttp = String(config.http_proxy || "").trim();
  const proxyHttp = mode === "http" && config.proxy?.trim() ? normalizeHttpProxy(config.proxy) : "";
  return {
    ...config,
    proxy_mode: mode,
    http_proxy: savedHttp || proxyHttp || (mode === "http" ? DEFAULT_HTTP_PROXY : savedHttp),
    ...ipweb,
  };
}

export function validateIpwebFields(fields: IpwebProxyFields): string | null {
  const gateway = fields.gateway.trim();
  const accountId = fields.accountId.trim();
  const password = fields.password.trim();
  if (!gateway || !accountId || !password) {
    return "请完整填写 IPWeb 网关、账号 ID 和密码";
  }
  const gw = parseIpwebGateway(gateway);
  if (!gw) return "网关格式应为 host:port，例如 gate2.ipweb.cc:7778";
  if (!gw.host.endsWith("ipweb.cc")) return "网关须为 IPWeb 域名（*.ipweb.cc）";
  if (!/^\d+$/.test(accountId)) return "账号 ID 应为 IPWeb 控制台中的数字 ID";
  return null;
}

export function validateHttpProxy(raw: string): string | null {
  const normalized = normalizeHttpProxy(raw);
  if (!normalized) return "请填写固定 HTTP 代理地址，例如 http://127.0.0.1:7890";
  try {
    const url = new URL(normalized);
    if (!url.hostname) return "HTTP 代理地址无效";
    if (url.hostname.endsWith("ipweb.cc")) return "固定 HTTP 代理请填写本地或自建代理，勿填 IPWeb 网关";
  } catch {
    return "HTTP 代理地址无效";
  }
  return null;
}

export function buildRegisterProxyPayload(config: {
  proxy?: string;
  proxy_mode?: RegisterProxyMode | string;
  ipweb_gateway?: string;
  ipweb_account_id?: string;
  ipweb_password?: string;
  http_proxy?: string;
}): { proxy: string; ipweb_rotate: boolean; proxy_mode: RegisterProxyMode; http_proxy: string } {
  const saved = config.proxy_mode;
  const mode: RegisterProxyMode =
    saved === "none" || saved === "ipweb" || saved === "http"
      ? saved
      : detectProxyMode(String(config.proxy || ""));
  if (mode === "none") {
    return { proxy: "", ipweb_rotate: false, proxy_mode: "none", http_proxy: String(config.http_proxy || DEFAULT_HTTP_PROXY) };
  }
  if (mode === "http") {
    const httpRaw = String(config.http_proxy || DEFAULT_HTTP_PROXY);
    const err = validateHttpProxy(httpRaw);
    if (err) throw new Error(err);
    const proxy = normalizeHttpProxy(httpRaw);
    return { proxy, ipweb_rotate: false, proxy_mode: "http", http_proxy: proxy };
  }
  const ipwebFields = {
    gateway: String(config.ipweb_gateway || ""),
    accountId: String(config.ipweb_account_id || ""),
    password: String(config.ipweb_password || ""),
  };
  const err = validateIpwebFields(ipwebFields);
  if (err) throw new Error(err);
  const proxy = buildIpwebProxyTemplate(ipwebFields);
  return {
    proxy,
    ipweb_rotate: true,
    proxy_mode: "ipweb",
    http_proxy: String(config.http_proxy || DEFAULT_HTTP_PROXY),
  };
}
