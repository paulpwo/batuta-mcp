/**
 * Splits a byte stream into newline-delimited messages with a hard cap on line length.
 *
 * A line longer than the cap is reported once through `onOversize`, then discarded up to its
 * newline without buffering it, so a hostile peer cannot make the process allocate unbounded memory.
 */
export class LineSplitter {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private discarding = false;

  constructor(
    private readonly maxLineBytes: number,
    private readonly onLine: (line: Buffer) => void,
    private readonly onOversize: () => void,
  ) {}

  push(chunk: Buffer): void {
    let position = 0;
    while (position < chunk.length) {
      const newline = chunk.indexOf(0x0a, position);
      if (this.discarding) {
        if (newline < 0) return;
        this.discarding = false;
        position = newline + 1;
        continue;
      }
      const end = newline < 0 ? chunk.length : newline;
      const segmentLength = end - position;
      if (this.pendingBytes + segmentLength > this.maxLineBytes) {
        this.pending = [];
        this.pendingBytes = 0;
        this.onOversize();
        if (newline < 0) {
          this.discarding = true;
          return;
        }
        position = newline + 1;
        continue;
      }
      if (newline < 0) {
        this.pending.push(chunk.subarray(position, end));
        this.pendingBytes += segmentLength;
        return;
      }
      const line = this.pending.length === 0
        ? chunk.subarray(position, end)
        : Buffer.concat([...this.pending, chunk.subarray(position, end)]);
      this.pending = [];
      this.pendingBytes = 0;
      position = newline + 1;
      const trimmed = line.length > 0 && line.at(-1) === 0x0d ? line.subarray(0, line.length - 1) : line;
      if (trimmed.length > 0) this.onLine(trimmed);
    }
  }
}
