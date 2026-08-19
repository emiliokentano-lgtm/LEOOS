/**
 * Mail transport.
 *
 * No SMTP vendor is chosen yet, so the only implementation is a console
 * transport that DELIVERS NOTHING. Per engineering rules 34, 35 and 45 it is
 * named accordingly, refuses to register in production without an explicit
 * override, and is reported in the admin UI as "not delivering" rather than as
 * a working integration.
 */
export interface MailMessage {
  to: string;
  subject: string;
  /** Plain text only for now — no template engine until there is a second use. */
  body: string;
}

export interface MailTransport {
  readonly name: string;
  /** True only when messages actually reach a recipient. */
  readonly delivers: boolean;
  send(message: MailMessage): Promise<void>;
}

export class ConsoleMailTransport implements MailTransport {
  readonly name = 'console';
  readonly delivers = false;

  constructor(private readonly log: (msg: string) => void = console.log) {}

  async send(message: MailMessage): Promise<void> {
    // The body carries a single-use token. It is printed here because this is a
    // development transport and there is nowhere else for it to go; a real
    // transport must never log the body.
    this.log(
      `\n── MAIL (console transport — NOT DELIVERED) ──\n` +
        `to:      ${message.to}\n` +
        `subject: ${message.subject}\n` +
        `${message.body}\n` +
        `─────────────────────────────────────────────\n`,
    );
  }
}

/** Collects messages instead of sending. Used by tests. */
export class MockMailTransport implements MailTransport {
  readonly name = 'mock';
  readonly delivers = false;
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }

  lastTo(email: string): MailMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to.toLowerCase() === email.toLowerCase());
  }

  clear(): void {
    this.sent.length = 0;
  }
}

export function createMailTransport(nodeEnv: string): MailTransport {
  if (nodeEnv === 'production' && process.env.ALLOW_MOCK_ADAPTERS !== 'true') {
    throw new Error(
      'No real mail transport is configured. LEOOS refuses to start in production ' +
        'with a console transport, because password reset would silently never arrive. ' +
        'Configure SMTP, or set ALLOW_MOCK_ADAPTERS=true to accept that.',
    );
  }
  if (nodeEnv === 'production') {
    console.warn('⚠ Mail: console transport in PRODUCTION — messages are NOT delivered.');
  }
  return new ConsoleMailTransport();
}
