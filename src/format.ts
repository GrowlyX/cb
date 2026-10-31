/** Aligns rows into columns, padding every column but the last. */
export function table(rows: string[][]): string {
  if (rows.length === 0) {
    return '';
  }

  const columns = rows[0]!.length;
  const widths: number[] = [];

  for (let col = 0; col < columns; col++) {
    widths.push(Math.max(...rows.map((row) => (row[col] ?? '').length)));
  }

  const lines = rows.map((row) => {
    const cells = row.map((cell, col) => {
      const isLast = col === row.length - 1;

      return isLast ? cell : cell.padEnd(widths[col]!);
    });

    return cells.join('  ');
  });

  return lines.join('\n');
}

/** Lays out cells at fixed widths, for output printed one row at a time. */
export function fixedRow(cells: string[], widths: number[]): string {
  const padded = cells.map((cell, i) => cell.padEnd(widths[i] ?? 0));

  return padded.join(' ').trimEnd();
}

/** Shortens text to `max` characters with an ellipsis. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }

  return `${text.slice(0, max - 1)}…`;
}

/** Milliseconds, with one decimal below 100ms. */
export function ms(value: number): string {
  if (value >= 100) {
    return `${Math.round(value)}ms`;
  }

  return `${value.toFixed(1)}ms`;
}

/** Bytes as whole megabytes. */
export function mb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

/** A 0-1 share as a whole percentage. */
export function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** Renders a value, or `-` when it is missing. */
export function orDash(value: number | undefined, render: (value: number) => string): string {
  if (value === undefined) {
    return '-';
  }

  return render(value);
}

/** Nearest-rank percentile of an unsorted list; 0 for an empty list. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const clamped = Math.min(sorted.length - 1, Math.max(0, rank));

  return sorted[clamped]!;
}

/** Mean of a list; 0 for an empty list. */
export function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** A filesystem-safe local timestamp for default output names. */
export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

/** The current time as HH:MM:SS. */
export function clock(): string {
  return new Date().toTimeString().slice(0, 8);
}
