import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Email provider adapter. Sending returns a classified outcome so the delivery engine can decide
 * between retrying, failing permanently and flagging an ambiguous send for review. A provider's
 * acceptance is recorded separately from delivery; delivery is learned from webhooks.
 */

export interface OutgoingEmail {
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  text: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
  /** Stable per logical message; sent to the provider as its idempotency key. */
  idempotencyKey: string;
}

export type SendOutcome =
  | { outcome: 'accepted'; providerMessageId: string }
  | { outcome: 'transient_error'; error: string }
  | { outcome: 'permanent_error'; error: string }
  /** The request may or may not have been accepted (e.g. timeout after sending). */
  | { outcome: 'unknown'; error: string };

export type DeliveryEventType = 'sent' | 'delivered' | 'delayed' | 'bounced' | 'complained' | 'failed' | 'other';

export interface ProviderWebhookEvent {
  providerEventId: string;
  type: DeliveryEventType;
  rawType: string;
  providerMessageId: string | null;
  occurredAt: string | null;
  recipient: string | null;
  permanentBounce: boolean;
}

export interface EmailProvider {
  readonly name: string;
  /** Hours the provider honours idempotency keys; retries after this window are not safe. */
  readonly idempotencyWindowHours: number;
  /** Whether messages actually leave the system (used to apply the non-production allowlist). */
  readonly deliversExternally: boolean;
  send(email: OutgoingEmail): Promise<SendOutcome>;
  /** Verifies a webhook against the raw body and returns normalized events, or null if invalid. */
  parseWebhook?(rawBody: string, headers: Record<string, string | string[] | undefined>, nowMs: number): ProviderWebhookEvent[] | null;
}

// ---------------------------------------------------------------------------------------------

export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';
  readonly idempotencyWindowHours = 24;
  readonly deliversExternally = true;

  constructor(
    private readonly apiKey: string,
    private readonly webhookSecret?: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async send(email: OutgoingEmail): Promise<SendOutcome> {
    let response: Response;
    try {
      response = await this.fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': email.idempotencyKey.slice(0, 256)
        },
        body: JSON.stringify({
          from: email.from,
          to: [email.to],
          subject: email.subject,
          text: email.text,
          ...(email.replyTo ? { reply_to: email.replyTo } : {}),
          ...(email.attachments?.length
            ? { attachments: email.attachments.map(a => ({ filename: a.filename, content: a.content.toString('base64') })) }
            : {})
        }),
        signal: AbortSignal.timeout(10_000)
      });
    } catch (error) {
      // The request may have reached Resend; a retry with the same idempotency key is safe
      // inside the provider window, so the engine treats this as unknown, not failed.
      return { outcome: 'unknown', error: `Network error: ${(error as Error).message}` };
    }
    const body = (await response.json().catch(() => ({}))) as { id?: string; name?: string; message?: string };
    if (response.ok && body.id) return { outcome: 'accepted', providerMessageId: body.id };
    const detail = `${response.status} ${body.name ?? ''} ${body.message ?? ''}`.trim();
    if (response.status === 429 || response.status >= 500) return { outcome: 'transient_error', error: detail };
    if (response.status === 409 && body.name === 'concurrent_idempotent_requests') return { outcome: 'transient_error', error: detail };
    return { outcome: 'permanent_error', error: detail };
  }

  /** Resend signs webhooks with Svix: HMAC-SHA256 over `${id}.${timestamp}.${rawBody}`. */
  parseWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>, nowMs: number): ProviderWebhookEvent[] | null {
    if (!this.webhookSecret) return null;
    const header = (name: string) => {
      const value = headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    const id = header('svix-id');
    const timestamp = header('svix-timestamp');
    const signatures = header('svix-signature');
    if (!id || !timestamp || !signatures) return null;
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > 5 * 60) return null;
    const secret = Buffer.from(this.webhookSecret.replace(/^whsec_/, ''), 'base64');
    const expected = createHmac('sha256', secret).update(`${id}.${timestamp}.${rawBody}`).digest();
    const valid = signatures.split(' ').some(part => {
      const [version, signature] = part.split(',');
      if (version !== 'v1' || !signature) return false;
      const supplied = Buffer.from(signature, 'base64');
      return supplied.length === expected.length && timingSafeEqual(supplied, expected);
    });
    if (!valid) return null;
    let payload: { type?: string; created_at?: string; data?: { email_id?: string; to?: string[]; bounce?: { type?: string } } };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return null;
    }
    const rawType = payload.type ?? 'unknown';
    const map: Record<string, DeliveryEventType> = {
      'email.sent': 'sent',
      'email.delivered': 'delivered',
      'email.delivery_delayed': 'delayed',
      'email.bounced': 'bounced',
      'email.complained': 'complained',
      'email.failed': 'failed'
    };
    return [
      {
        providerEventId: id,
        type: map[rawType] ?? 'other',
        rawType,
        providerMessageId: payload.data?.email_id ?? null,
        occurredAt: payload.created_at ?? null,
        recipient: payload.data?.to?.[0]?.toLowerCase() ?? null,
        permanentBounce: rawType === 'email.bounced' && (payload.data?.bounce?.type ?? 'Permanent').toLowerCase() !== 'transient'
      }
    ];
  }
}

// ---------------------------------------------------------------------------------------------

/** Test double: records messages and can be scripted to fail. */
export class MemoryEmailProvider implements EmailProvider {
  readonly name = 'memory';
  readonly idempotencyWindowHours = 24;
  readonly deliversExternally = false;
  readonly sent: Array<OutgoingEmail & { providerMessageId: string }> = [];
  private script: SendOutcome['outcome'][] = [];
  private counter = 0;
  /** Provider-side idempotency, like a real provider within its window. */
  private readonly seenKeys = new Map<string, string>();

  failNext(...outcomes: Array<'transient_error' | 'permanent_error' | 'unknown' | 'unknown_but_accepted'>) {
    this.script.push(...(outcomes as SendOutcome['outcome'][]));
  }

  async send(email: OutgoingEmail): Promise<SendOutcome> {
    const scripted = this.script.shift() as string | undefined;
    if (scripted === 'transient_error' || scripted === 'permanent_error' || scripted === 'unknown') {
      return { outcome: scripted, error: `scripted ${scripted}` } as SendOutcome;
    }
    const existing = this.seenKeys.get(email.idempotencyKey);
    if (existing) return { outcome: 'accepted', providerMessageId: existing };
    const providerMessageId = `mem_${++this.counter}`;
    this.seenKeys.set(email.idempotencyKey, providerMessageId);
    this.sent.push({ ...email, providerMessageId });
    if (scripted === 'unknown_but_accepted') return { outcome: 'unknown', error: 'scripted timeout after acceptance' };
    return { outcome: 'accepted', providerMessageId };
  }

  to(address: string) {
    return this.sent.filter(message => message.to === address.toLowerCase());
  }

  clear() {
    this.sent.length = 0;
    this.script = [];
  }
}

/** Local development: writes each message to .data/mailbox so links can be opened. */
export class LogEmailProvider implements EmailProvider {
  readonly name = 'log';
  readonly idempotencyWindowHours = 24;
  readonly deliversExternally = false;
  private readonly memory = new MemoryEmailProvider();

  constructor(private readonly dir = resolve('.data/mailbox'), private readonly log: (line: string) => void = console.log) {}

  async send(email: OutgoingEmail): Promise<SendOutcome> {
    const result = await this.memory.send(email);
    if (result.outcome === 'accepted') {
      mkdirSync(this.dir, { recursive: true });
      const file = join(this.dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${result.providerMessageId}.txt`);
      const attachments = (email.attachments ?? []).map(a => `Attachment: ${a.filename} (${a.content.length} bytes)`).join('\n');
      writeFileSync(file, `To: ${email.to}\nFrom: ${email.from}\nSubject: ${email.subject}\n${attachments}\n\n${email.text}\n`);
      this.log(`[email] "${email.subject}" -> ${email.to} (saved to ${file})`);
    }
    return result;
  }
}
