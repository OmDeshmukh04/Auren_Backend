import { Socket } from 'node:net';

/**
 * Malware scanning for private uploads. A file is released only on a "clean" verdict; any
 * scanner error leaves it quarantined. There is no silent release.
 */
export type ScanVerdict = { verdict: 'clean' } | { verdict: 'infected'; detail: string } | { verdict: 'error'; detail: string };

export interface MalwareScanner {
  readonly name: string;
  scan(bytes: Buffer): Promise<ScanVerdict>;
}

/** No scanner configured: uploads remain quarantined until one is configured and rescans run. */
export class NoScanner implements MalwareScanner {
  readonly name = 'none';
  async scan(): Promise<ScanVerdict> {
    return { verdict: 'error', detail: 'No malware scanner is configured; the file stays quarantined.' };
  }
}

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/**
 * Local development only (refused in staging/production by config validation). Treats files as
 * clean unless they contain the EICAR test string, so the rejection path can be exercised.
 */
export class DevAllowScanner implements MalwareScanner {
  readonly name = 'dev-allow';
  async scan(bytes: Buffer): Promise<ScanVerdict> {
    if (bytes.includes(Buffer.from(EICAR))) return { verdict: 'infected', detail: 'Eicar-Test-Signature' };
    return { verdict: 'clean' };
  }
}

/** ClamAV daemon over TCP using the INSTREAM command. */
export class ClamdScanner implements MalwareScanner {
  readonly name = 'clamd';
  constructor(private readonly host: string, private readonly port: number, private readonly timeoutMs = 30_000) {}

  scan(bytes: Buffer): Promise<ScanVerdict> {
    return new Promise(resolvePromise => {
      const socket = new Socket();
      let reply = '';
      let settled = false;
      const finish = (result: ScanVerdict) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolvePromise(result);
      };
      socket.setTimeout(this.timeoutMs, () => finish({ verdict: 'error', detail: 'Scanner timed out' }));
      socket.on('error', error => finish({ verdict: 'error', detail: `Scanner unavailable: ${error.message}` }));
      socket.on('data', chunk => {
        reply += chunk.toString('utf8');
      });
      socket.on('end', () => {
        const text = reply.replace(/\0/g, '').trim();
        if (/: OK$/.test(text)) finish({ verdict: 'clean' });
        else if (/FOUND$/.test(text)) finish({ verdict: 'infected', detail: text.replace(/^stream: /, '').replace(/ FOUND$/, '') });
        else finish({ verdict: 'error', detail: `Unexpected scanner reply: ${text.slice(0, 200)}` });
      });
      socket.connect(this.port, this.host, () => {
        socket.write('zINSTREAM\0');
        const chunkSize = 64 * 1024;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          const chunk = bytes.subarray(offset, offset + chunkSize);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length);
          socket.write(size);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4));
      });
    });
  }
}
