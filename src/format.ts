export function table(rows: string[][]): string {
  if (rows.length === 0) return '';
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((r) => (r[col] ?? '').length)));
  return rows
    .map((r) => r.map((cell, col) => (col === r.length - 1 ? cell : cell.padEnd(widths[col]!))).join('  '))
    .join('\n');
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function ms(value: number): string {
  return value >= 100 ? `${Math.round(value)}ms` : `${value.toFixed(1)}ms`;
}

export function mb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

/** Nearest-rank percentile of an unsorted list. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank]!;
}

export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}
