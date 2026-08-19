/**
 * 通知 (gmo-coinから移植)。コンソールには常に出力し、NOTIFY_WEBHOOK_URLが
 * 設定されていればWebhookにも送信する。ペイロードは text(Slack形式) と
 * content(Discord形式) を両方含めるため、どちらのWebhook URLでも動く。
 */
export type NotifyLevel = "info" | "warn" | "critical";

const LEVEL_PREFIX: Record<NotifyLevel, string> = {
  info: "ℹ️",
  warn: "⚠️",
  critical: "🚨",
};

export class Notifier {
  private readonly webhookUrl: string | undefined;

  constructor(webhookUrl: string | undefined = process.env["NOTIFY_WEBHOOK_URL"]) {
    this.webhookUrl = webhookUrl === "" ? undefined : webhookUrl;
  }

  async notify(level: NotifyLevel, message: string): Promise<void> {
    const text = `${LEVEL_PREFIX[level]} [fx-bot] ${message}`;
    const log = level === "info" ? console.log : console.error;
    log(`${new Date().toISOString()} ${text}`);

    if (!this.webhookUrl) return;
    try {
      await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, content: text }),
      });
    } catch (err) {
      // 通知失敗で本体を止めない
      console.error("[notifier] Webhook送信に失敗:", err instanceof Error ? err.message : err);
    }
  }

  info(message: string): Promise<void> {
    return this.notify("info", message);
  }

  warn(message: string): Promise<void> {
    return this.notify("warn", message);
  }

  critical(message: string): Promise<void> {
    return this.notify("critical", message);
  }
}
