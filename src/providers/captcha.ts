/**
 * Optional bot check for public forms (Cloudflare Turnstile). When no secret is configured the
 * forms rely on the honeypot field and Postgres-backed rate limits.
 */
export interface CaptchaVerifier {
  readonly enabled: boolean;
  verify(token: string | undefined, ip: string | undefined): Promise<boolean>;
}

export const noCaptcha: CaptchaVerifier = {
  enabled: false,
  async verify() {
    return true;
  }
};

export class TurnstileVerifier implements CaptchaVerifier {
  readonly enabled = true;
  constructor(private readonly secret: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async verify(token: string | undefined, ip: string | undefined) {
    if (!token) return false;
    try {
      const response = await this.fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: this.secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
        signal: AbortSignal.timeout(5_000)
      });
      const body = (await response.json()) as { success?: boolean };
      return body.success === true;
    } catch {
      return false;
    }
  }
}
