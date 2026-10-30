// Shared conformance bookkeeping: each check records (case, expected, measured, tolerance, pass)
// and the owning test file prints a table when it finishes.

export interface ConformanceRow {
  suite: string;
  testCase: string;
  expected: string;
  measured: string;
  tolerance: string;
  pass: boolean;
}

export const rows: ConformanceRow[] = [];

/** Check |measured - expected| within [-lower, +upper] and record the row. */
export function check(
  suite: string,
  testCase: string,
  expected: number,
  measured: number | null,
  lower: number,
  upper: number,
  unit: string,
): boolean {
  const pass = measured !== null && measured - expected >= -lower - 1e-9 && measured - expected <= upper + 1e-9;
  rows.push({
    suite,
    testCase,
    expected: `${expected.toFixed(1)} ${unit}`,
    measured: measured === null ? 'null' : `${measured.toFixed(2)} ${unit}`,
    tolerance: lower === upper ? `+-${lower}` : `+${upper}/-${lower}`,
    pass,
  });
  return pass;
}

export function printTable(): void {
  const header = ['suite', 'case', 'expected', 'measured', 'tolerance', 'pass'];
  const body = rows.map((r) => [r.suite, r.testCase, r.expected, r.measured, r.tolerance, r.pass ? 'PASS' : 'FAIL']);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log('\nConformance table');
  console.log(line(header));
  for (const b of body) console.log(line(b));
}
