const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGITS = new Map([...ALPHABET].map((char, index) => [char, index]));
const FIELDS = 5;

export type Segment = number[];

function decodeGroup(group: string): number[] {
  const values: number[] = [];
  let value = 0;
  let factor = 1;
  for (const char of group) {
    const digit = DIGITS.get(char);
    if (digit === undefined) throw new Error(`invalid source map mapping: ${group}`);
    value += (digit % 32) * factor;
    if (digit >= 32) {
      factor *= 32;
      continue;
    }
    const magnitude = Math.floor(value / 2);
    values.push(value % 2 === 1 ? -magnitude : magnitude);
    value = 0;
    factor = 1;
  }
  return values;
}

function encodeValue(delta: number): string {
  let value = delta < 0 ? -delta * 2 + 1 : delta * 2;
  let encoded = '';
  do {
    const digit = value % 32;
    value = Math.floor(value / 32);
    encoded += ALPHABET[value > 0 ? digit + 32 : digit];
  } while (value > 0);
  return encoded;
}

export function decodeMappings(mappings: string): Segment[][] {
  const state = new Array<number>(FIELDS).fill(0);
  return mappings.split(';').map((line) => {
    state[0] = 0;
    const segments: Segment[] = [];
    for (const group of line.split(',')) {
      if (!group) continue;
      const values = decodeGroup(group).slice(0, FIELDS);
      segments.push(values.map((delta, field) => (state[field] = (state[field] ?? 0) + delta)));
    }
    return segments;
  });
}

export function encodeMappings(lines: Segment[][]): string {
  const state = new Array<number>(FIELDS).fill(0);
  return lines
    .map((segments) => {
      state[0] = 0;
      return segments
        .map((segment) =>
          segment
            .map((value, field) => {
              const delta = value - (state[field] ?? 0);
              state[field] = value;
              return encodeValue(delta);
            })
            .join(''),
        )
        .join(',');
    })
    .join(';');
}
