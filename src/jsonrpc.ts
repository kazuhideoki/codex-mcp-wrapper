import { Readable, Writable } from 'node:stream';

export type JsonRpcMessage = any; // Request, Response, or Notification

export class JsonRpcStdio {
  private inBuf: Buffer = Buffer.alloc(0);
  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly onMessage: (msg: JsonRpcMessage) => void,
  ) {
    input.on('data', (chunk: Buffer) => this.onData(chunk));
  }

  private onData(chunk: Buffer) {
    this.inBuf = Buffer.concat([this.inBuf, chunk]);
    // Support both LSP-style Content-Length frames and NDJSON (newline-delimited JSON)
    while (true) {
      // Try to find a Content-Length header anywhere in the buffer (tolerate leading noise)
      const lower = this.inBuf.toString('utf8').toLowerCase();
      const clIdx = lower.indexOf('content-length:');
      if (clIdx !== -1) {
        const headerEnd = this.inBuf.indexOf('\r\n\r\n');
        if (headerEnd === -1 || headerEnd < clIdx) {
          // Wait for full header
          return;
        }
        // Drop any noise before the header start
        if (clIdx > 0) {
          this.inBuf = this.inBuf.slice(clIdx);
        }
        const headerRaw = this.inBuf.slice(0, headerEnd).toString('utf8');
        const m = /Content-Length:\s*(\d+)/i.exec(headerRaw);
        if (!m) {
          // Malformed header; drop header region and continue
          this.inBuf = this.inBuf.slice(headerEnd + 4);
          continue;
        }
        const len = parseInt(m[1], 10);
        const bodyStart = headerEnd + 4;
        const total = bodyStart + len;
        if (this.inBuf.length < total) return; // wait for full body
        const bodyBuf = this.inBuf.slice(bodyStart, total);
        this.inBuf = this.inBuf.slice(total);
        try {
          this.onMessage(JSON.parse(bodyBuf.toString('utf8')));
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(`[mcp-wrapper] JSON parse error: ${String(e)}`);
        }
        continue;
      }

      // NDJSON framing: one JSON per line
      const nl = this.inBuf.indexOf('\n');
      if (nl === -1) return; // wait for complete line
      const lineBuf = this.inBuf.slice(0, nl);
      this.inBuf = this.inBuf.slice(nl + 1);
      const line = lineBuf.toString('utf8').replace(/\r$/, '').trim();
      if (!line) continue; // skip empty lines and noise
      try {
        this.onMessage(JSON.parse(line));
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(
          `[mcp-wrapper] JSON parse error: ${String(e)} -- line="${line.slice(0, 200)}"`,
        );
      }
    }
  }

  public send(msg: JsonRpcMessage) {
    // NDJSON output (one line per message)
    const line = Buffer.from(JSON.stringify(msg) + '\n', 'utf8');
    this.output.write(line);
  }
}
