/** 批量导入分隔符：至少 2 个连字符，兼容 -- / --- / ---- 等。 */
export const IMPORT_DASH_RE = /-{2,}/;

export type ImportLineIssue = { line: number; text: string; message: string };

export type ImportValidation = {
  validCount: number;
  issues: ImportLineIssue[];
};

function iterImportLines(text: string): { line: number; content: string }[] {
  return text
    .split("\n")
    .map((raw, i) => ({ line: i + 1, content: raw.trim() }))
    .filter(({ content }) => content && !content.startsWith("#"));
}

function truncate(text: string, max = 48): string {
  const s = text.replace(/\s+/g, " ");
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function splitByDash(line: string, limit?: number): string[] {
  return line.split(IMPORT_DASH_RE, limit).map((s) => s.trim());
}

function isAccountPoolLine(line: string): boolean {
  if (/[:：]/.test(line) || !IMPORT_DASH_RE.test(line)) return false;
  const fields = splitByDash(line);
  const second = fields[1] ?? "";
  return looksLikeEmail(fields[0] ?? "") && !second.toLowerCase().startsWith("http");
}

/** 邮箱池：`邮箱 + 分隔符 + 收件地址`，一行一条。 */
export function validateMailboxImport(text: string): ImportValidation {
  const issues: ImportLineIssue[] = [];
  let validCount = 0;

  for (const { line, content } of iterImportLines(text)) {
    if (!IMPORT_DASH_RE.test(content)) {
      issues.push({ line, text: truncate(content), message: "缺少分隔符（至少两个连字符 -）" });
      continue;
    }
    const parts = splitByDash(content, 2);
    const email = parts[0] ?? "";
    const fetchUrl = parts[1] ?? "";
    if (!email) {
      issues.push({ line, text: truncate(content), message: "分隔符前缺少邮箱" });
      continue;
    }
    if (!looksLikeEmail(email)) {
      issues.push({ line, text: truncate(content), message: "邮箱格式无效" });
      continue;
    }
    if (!fetchUrl) {
      issues.push({ line, text: truncate(content), message: "分隔符后缺少收件地址" });
      continue;
    }
    if (!isHttpUrl(fetchUrl)) {
      issues.push({ line, text: truncate(content), message: "收件地址须以 http:// 或 https:// 开头" });
      continue;
    }
    validCount += 1;
  }

  return { validCount, issues };
}

/** 手机号池：可只填手机号，或 `手机号 + 分隔符 + 接码地址`。 */
export function validatePhoneImport(text: string): ImportValidation {
  const issues: ImportLineIssue[] = [];
  let validCount = 0;

  for (const { line, content } of iterImportLines(text)) {
    if (IMPORT_DASH_RE.test(content)) {
      const parts = splitByDash(content, 2);
      const phone = (parts[0] ?? "").replace(/\s+/g, "");
      const fetchUrl = parts[1] ?? "";
      if (!phone) {
        issues.push({ line, text: truncate(content), message: "分隔符前缺少手机号" });
        continue;
      }
      if (!/^\+?[\d-]{6,}$/.test(phone)) {
        issues.push({ line, text: truncate(content), message: "手机号格式无效" });
        continue;
      }
      if (!fetchUrl) {
        issues.push({ line, text: truncate(content), message: "分隔符后缺少接码地址" });
        continue;
      }
      validCount += 1;
      continue;
    }

    const phone = content.replace(/\s+/g, "");
    if (!/^\+?[\d-]{6,}$/.test(phone)) {
      issues.push({ line, text: truncate(content), message: "手机号格式无效" });
      continue;
    }
    validCount += 1;
  }

  return { validCount, issues };
}

/** CDK：一行一个，允许行内 `CDK-类型` 后缀。 */
export function validateCdkImport(text: string): ImportValidation {
  return { validCount: iterImportLines(text).length, issues: [] };
}

/** 账号：JSON / 账号池文本 / 逐行 access_token。 */
export function validateAccountImport(text: string): ImportValidation {
  const raw = text.trim();
  if (!raw) return { validCount: 0, issues: [] };

  if (raw.startsWith("[") || raw.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const issues: ImportLineIssue[] = [];
      let validCount = 0;
      arr.forEach((item, index) => {
        const token =
          item && typeof item === "object" ? (item as { access_token?: unknown }).access_token : undefined;
        if (typeof token === "string" && token.trim()) {
          validCount += 1;
          return;
        }
        issues.push({ line: index + 1, text: `第 ${index + 1} 项`, message: "缺少有效的 access_token 字段" });
      });
      return { validCount, issues };
    } catch {
      return { validCount: 0, issues: [{ line: 1, text: truncate(raw), message: "JSON 格式错误，请检查括号与引号" }] };
    }
  }

  const issues: ImportLineIssue[] = [];
  let validCount = 0;
  const poolMode = iterImportLines(raw).some(({ content }) => isAccountPoolLine(content));

  if (poolMode) {
    for (const { line, content } of iterImportLines(raw)) {
      if (!isAccountPoolLine(content)) {
        issues.push({ line, text: truncate(content), message: "账号池格式应为：邮箱 + 分隔符 + 密码/2FA/token" });
        continue;
      }
      const email = splitByDash(content)[0] ?? "";
      if (!looksLikeEmail(email)) {
        issues.push({ line, text: truncate(content), message: "邮箱格式无效" });
        continue;
      }
      validCount += 1;
    }
    return { validCount, issues };
  }

  const tokens = raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
  return { validCount: tokens.length, issues };
}

export function isAccountPoolImportText(text: string): boolean {
  return iterImportLines(text).some(({ content }) => isAccountPoolLine(content));
}

export function importSubmitGuard(validation: ImportValidation, emptyMessage: string): string | null {
  if (!validation.validCount && !validation.issues.length) return emptyMessage;
  if (validation.issues.length) return `有 ${validation.issues.length} 行格式错误，请修正后再导入`;
  return null;
}
