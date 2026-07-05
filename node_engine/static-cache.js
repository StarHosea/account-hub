// ============================================================================
// 静态资源 route 缓存（Playwright / CloakBrowser）
// ----------------------------------------------------------------------------
// 在浏览器内拦截 GET 静态资源：命中本地文件则 fulfill（不走代理）；未命中则
// route.fetch() 经 ipweb 拉取后写入磁盘。Cookie / localStorage 仍在各
// BrowserContext 内，与缓存目录无关。配置由注册设置经 job.staticCache 下发。
// ============================================================================

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.resolve(__dirname, '..', 'data', 'http-cache');
const STATIC_RE = /\.(js|mjs|css|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|webp|ico|avif)(\?|$)/i;
const STRIP_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding']);

const DEFAULT_CONFIG = {
  enabled: true,
  maxAgeDays: 7,
  dir: '',
};

function resolveConfig(input) {
  const cfg = { ...DEFAULT_CONFIG, ...(input && typeof input === 'object' ? input : {}) };
  const rawDir = String(cfg.dir || '').trim();
  const dir = rawDir
    ? (path.isAbsolute(rawDir) ? rawDir : path.resolve(process.cwd(), rawDir))
    : DEFAULT_DIR;
  const maxAgeDays = Number(cfg.maxAgeDays);
  return {
    enabled: cfg.enabled !== false,
    dir,
    maxAgeMs: (Number.isFinite(maxAgeDays) && maxAgeDays > 0 ? maxAgeDays : 7) * 86400_000,
  };
}

function bodyPath(dir, url) {
  const hash = crypto.createHash('sha256').update(url).digest('hex');
  return path.join(dir, hash.slice(0, 2), hash);
}

function metaPath(bodyFile) {
  return `${bodyFile}.meta.json`;
}

function isStaticUrl(url) {
  try {
    return STATIC_RE.test(new URL(url).pathname);
  } catch {
    return STATIC_RE.test(String(url).split('?')[0]);
  }
}

function sanitizeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (!STRIP_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  out['x-reg-cache'] = out['x-reg-cache'] || 'HIT';
  return out;
}

async function readCache(dir, maxAgeMs, url) {
  const bodyFile = bodyPath(dir, url);
  const metaFile = metaPath(bodyFile);
  try {
    const meta = JSON.parse(await fsp.readFile(metaFile, 'utf8'));
    if (Date.now() - meta.savedAt > maxAgeMs) return null;
    const body = await fsp.readFile(bodyFile);
    return { body, status: meta.status || 200, headers: sanitizeHeaders(meta.headers) };
  } catch {
    return null;
  }
}

async function writeCache(dir, url, response) {
  const cc = String(response.headers()['cache-control'] || '').toLowerCase();
  if (cc.includes('no-store') || cc.includes('private')) return;

  const body = await response.body();
  const bodyFile = bodyPath(dir, url);
  await fsp.mkdir(path.dirname(bodyFile), { recursive: true });

  const lock = `${bodyFile}.lock`;
  try {
    await fsp.writeFile(lock, String(process.pid), { flag: 'wx' });
  } catch {
    return;
  }

  try {
    const tmp = `${bodyFile}.tmp`;
    const tmpMeta = metaPath(tmp);
    await fsp.writeFile(tmp, body);
    await fsp.writeFile(tmpMeta, JSON.stringify({
      savedAt: Date.now(),
      status: response.status(),
      headers: response.headers(),
    }));
    await fsp.rename(tmpMeta, metaPath(bodyFile));
    await fsp.rename(tmp, bodyFile);
  } finally {
    await fsp.unlink(lock).catch(() => {});
  }
}

const NOOP = {
  stats: { hits: 0, misses: 0 },
  async logSummary() {},
};

/**
 * @param {import('playwright-core').Page | import('playwright-core').BrowserContext} target
 * @param {{ log?: (msg: string, level?: string) => void, config?: { enabled?: boolean, maxAgeDays?: number, dir?: string } }} [options]
 */
export async function attachStaticCache(target, { log = () => {}, config: inputConfig } = {}) {
  const cfg = resolveConfig(inputConfig);
  if (!cfg.enabled) return NOOP;

  const stats = { hits: 0, misses: 0, writeErrors: 0 };

  try {
    await fsp.mkdir(cfg.dir, { recursive: true });
  } catch (err) {
    log(`静态资源缓存目录不可用（${cfg.dir}）：${err?.message || err}，已关闭缓存`, 'error');
    return NOOP;
  }

  log(`已开启静态资源缓存（${cfg.dir}，有效期 ${Math.round(cfg.maxAgeMs / 86400_000)} 天）`);

  const reportWriteError = (err) => {
    stats.writeErrors += 1;
    if (stats.writeErrors === 1) {
      log(`静态资源缓存写入失败：${err?.message || err}（后续写入错误不再逐条提示）`, 'warn');
    }
  };

  await target.route('**/*', async (route, request) => {
    if (request.method() !== 'GET' || !isStaticUrl(request.url())) {
      return route.continue();
    }

    const url = request.url();
    const hit = await readCache(cfg.dir, cfg.maxAgeMs, url);
    if (hit) {
      stats.hits += 1;
      return route.fulfill({
        status: hit.status,
        body: hit.body,
        headers: hit.headers,
      });
    }

    stats.misses += 1;
    try {
      const response = await route.fetch();
      if (response.ok()) {
        try {
          await writeCache(cfg.dir, url, response);
        } catch (err) {
          reportWriteError(err);
        }
      }
      const headers = { ...response.headers(), 'x-reg-cache': 'MISS' };
      return route.fulfill({ response, headers });
    } catch {
      return route.continue();
    }
  });

  return {
    stats,
    async logSummary() {
      const total = stats.hits + stats.misses;
      if (total === 0 && stats.writeErrors === 0) return;
      if (total > 0) {
        const pct = ((stats.hits / total) * 100).toFixed(0);
        log(`静态资源缓存：${stats.hits} 命中 / ${stats.misses} 未命中（${pct}%）`);
      }
      if (stats.writeErrors > 0) {
        log(`静态资源缓存写入失败 ${stats.writeErrors} 次（请检查目录权限与磁盘空间）`, 'warn');
      }
    },
  };
}
