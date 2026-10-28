import { toast } from "../store/toast";

/**
 * 复制整份下载日志，成功与失败都给一句提示。
 *
 * `navigator.clipboard` 在部分 WebView2 配置下不可用；进度卡与队列菜单
 * 曾各自复制了一份同样的 try/catch，失败文案还悄悄分了叉。这里收成一条
 * 路径，`fallbackHint` 留给调用方说明「去哪手动选」。
 */
export async function copyLogWithToast(log: string[], fallbackHint: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(log.join("\n"));
    toast.success(`已复制 ${log.length} 行日志`);
  } catch {
    toast.error(`剪贴板不可用，${fallbackHint}`);
  }
}
