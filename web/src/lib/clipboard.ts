import { Toast } from "@douyinfe/semi-ui-19";

/**
 * 将文本写入剪贴板并给出成功/失败提示。
 *
 * 说明：`navigator.clipboard` 仅在安全上下文（HTTPS 或 localhost）下可用。
 * 本项目常通过 LAN IP 的 http:// 访问，此时该 API 为 undefined，
 * 因此在不可用时回退到 textarea + execCommand("copy") 方案，保证复制可用。
 */
export async function copyToClipboard(text: string, label: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else if (!legacyCopy(text)) {
      throw new Error("execCommand copy failed");
    }
    Toast.success(`${label}已复制`);
  } catch {
    Toast.error("复制失败，请检查浏览器剪贴板权限");
  }
}

/** 非安全上下文下的兜底复制方案。 */
function legacyCopy(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  // 置于视口外，避免滚动与闪烁。
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";
  textarea.setAttribute("readonly", "");
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}
