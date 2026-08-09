/**
 * Post an operational alert to Telegram.
 *
 * WHY A SECOND CHANNEL AT ALL. Email is the primary alert path, and its failure
 * mode is silent: an expired credential, a mailbox rule, a provider outage. None
 * of those announce themselves, and the thing being alerted about is usually
 * already invisible. A second channel over completely different infrastructure
 * means one dead path does not mean one unheard alert.
 *
 * WHAT THIS DELIBERATELY IS NOT. It is not a notification framework. It formats
 * nothing, retries nothing, and knows no business rules — it takes a token, a
 * chat and some text, and reports whether Telegram accepted it. Callers own the
 * message, and the estate's alert-quality rules (notify once per occurrence,
 * remediation derived per failure) live above this, not inside it.
 *
 * NEVER THROWS, ALWAYS RETURNS A BOOLEAN. Alerting runs on a job's failure path;
 * an alerter that throws turns a degraded run into a lost one. And the caller
 * must be able to tell "sent" from "silently did nothing" — a notifier whose
 * failure is indistinguishable from its success is the bug this whole surface
 * keeps rediscovering.
 */

export interface TelegramResult {
  ok: boolean;
  /** Why it failed, for logging. Empty on success. */
  reason: string;
}

/**
 * @param token   Bot token. Missing/empty returns ok:false rather than throwing —
 *                an unconfigured channel is a real answer, not an exception.
 * @param chatId  Target chat.
 * @param text    Plain text. Sent WITHOUT a parse mode on purpose: alert bodies
 *                carry error messages, stack fragments and URLs, and Markdown or
 *                HTML parsing rejects the whole message on an unbalanced
 *                character. An alert that fails to send because the error it was
 *                reporting contained an underscore is precisely the wrong
 *                trade — legibility is worth less than delivery here.
 * @param timeoutMs Default 10s. A hung alert must not hold a cron open.
 */
export async function sendTelegramAlert(
  token: string | undefined,
  chatId: string | undefined,
  text: string,
  timeoutMs = 10_000,
): Promise<TelegramResult> {
  if (!token || !chatId) {
    return { ok: false, reason: "telegram not configured (missing token or chat id)" };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Telegram hard-caps a message at 4096 characters and rejects the whole
      // thing when it is longer — so a long alert would fail entirely rather
      // than arrive truncated. Truncate here, and say so, so the reader knows
      // there is more in the email.
      body: JSON.stringify({
        chat_id: chatId,
        text: text.length > 4000 ? `${text.slice(0, 3900)}\n\n[truncated — full detail in the email]` : text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      // Telegram answers 200 with {ok:false} for some errors and a 4xx for
      // others, so BOTH are checked. A revoked token returns 404 "Not Found",
      // which resolves the promise perfectly happily.
      const body = await res.text().catch(() => "");
      return { ok: false, reason: `telegram HTTP ${res.status}: ${body.slice(0, 200)}` };
    }

    const body = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
    if (!body?.ok) {
      return { ok: false, reason: `telegram rejected: ${body?.description ?? "unparseable response"}` };
    }

    return { ok: true, reason: "" };
  } catch (err) {
    return { ok: false, reason: `telegram send failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
