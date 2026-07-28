export type Confusion = { tp: number; fp: number; tn: number; fn: number };

export function confusion(items: { predicted: boolean; actual: boolean }[]): Confusion {
  const c: Confusion = { tp: 0, fp: 0, tn: 0, fn: 0 };
  for (const { predicted, actual } of items) {
    if (predicted && actual) c.tp++;
    else if (predicted && !actual) c.fp++;
    else if (!predicted && !actual) c.tn++;
    else c.fn++;
  }
  return c;
}

export function recall(c: { tp: number; fn: number }): number {
  const denom = c.tp + c.fn;
  return denom === 0 ? 1 : c.tp / denom;
}

export function precision(c: { tp: number; fp: number }): number {
  const denom = c.tp + c.fp;
  return denom === 0 ? 1 : c.tp / denom;
}

export function accuracy(correct: number, total: number): number {
  return total === 0 ? 1 : correct / total;
}

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
