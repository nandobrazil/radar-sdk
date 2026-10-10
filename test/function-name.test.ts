import { describe, expect, it } from 'vitest';
import { enclosingFunctionName } from '../src/function-name.js';

function nameAt(source: string, marker: string): string | undefined {
  const lines = source.split('\n');
  const index = lines.findIndex((line) => line.includes(marker));
  return enclosingFunctionName(lines, index + 1, (lines[index] ?? '').indexOf(marker) + 1);
}

describe('enclosingFunctionName', () => {
  it('finds function declarations, typed arrow functions and methods', () => {
    expect(nameAt(['export function checkout(cart: Cart): number {', '  const first = cart.items[0];', '  throw new Error(`empty ${first}`);', '}'].join('\n'), 'throw')).toBe('checkout');
    expect(nameAt(['const applyDiscount = (current: Cart, sku: string): number => {', '  const item = current.items[0];', '  return item!.price;', '};'].join('\n'), 'return')).toBe('applyDiscount');
    expect(nameAt(['export const load = async ({ params }) => {', '  throw error(404);', '};'].join('\n'), 'throw')).toBe('load');
    expect(nameAt(['class CartStore {', '  private total = 0;', '  async submit(order: Order): Promise<void> {', '    this.total += order.lines.length;', '  }', '}'].join('\n'), 'this.total +=')).toBe('submit');
    expect(nameAt(['const actions = {', '  save: async function () {', '    persist();', '  },', '  remove() {', '    drop();', '  },', '};'].join('\n'), 'drop()')).toBe('remove');
    expect(nameAt(['const actions = {', '  save: async function () {', '    persist();', '  },', '};'].join('\n'), 'persist()')).toBe('save');
  });

  it('looks past control blocks and anonymous callbacks to the named function', () => {
    const source = ['function applyCoupon(cart: Cart, code: string) {', '  if (code.length > 0) {', '    cart.items.forEach((item) => {', '      item.price = item.price * parse(code);', '    });', '  }', '}'].join('\n');
    expect(nameAt(source, 'item.price =')).toBe('applyCoupon');
  });

  it('does not name an anonymous callback after the call that receives it', () => {
    expect(nameAt(['setTimeout(function () {', '  explode();', '}, 10);'].join('\n'), 'explode()')).toBeUndefined();
    expect(nameAt(['function boot() {', '  setTimeout(function () {', '    explode();', '  }, 10);', '}'].join('\n'), 'explode()')).toBe('boot');
    expect(nameAt(['const pick = flag ? fallback : (value) => {', '  return value.id;', '};'].join('\n'), 'return')).toBeUndefined();
  });

  it('ignores braces inside strings and comments and handles one-line functions', () => {
    expect(nameAt(['function render(name: string) {', "  const open = '{';", '  // closing } here', '  return open + name.trim();', '}'].join('\n'), 'return')).toBe('render');
    expect(nameAt('function fail() { throw new Error("x") }', 'throw')).toBe('fail');
  });

  it('gives up at top-level code and at the markup of a Svelte component', () => {
    expect(nameAt(['const cart = loadCart();', 'cart.items[0].price;'].join('\n'), 'cart.items[0]')).toBeUndefined();
    expect(nameAt(['<script lang="ts">', '  function go() {', '    navigate();', '  }', '</script>', '', '<button onclick={() => crash()}>Ir</button>'].join('\n'), 'crash()')).toBeUndefined();
  });
});

describe('enclosingFunctionName on huge lines', () => {
  it('stays fast when the header of a block is a very long line', () => {
    const noise = `const data = (${'a, '.repeat(20_000)}) => {`;
    const lines = [noise, `function render(${'x: number, '.repeat(5_000)}) {`, '  return compute();', '}', '};'];
    const started = performance.now();
    expect(enclosingFunctionName(lines, 3, 3)).toBe('render');
    expect(enclosingFunctionName([noise, '  boom();', '};'], 2, 3)).toBe('data');
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('ignores braces and function words inside comments that span several lines', () => {
    const source = [
      '/**',
      ' * Charges the card {',
      ' *   function fakeName() {',
      ' */',
      'function chargeCard(order) {',
      '  /* a block',
      '     that spans lines } { */',
      '  const url = "http://pay.dev/*"; // not a comment opener /*',
      '  throw new Error("declined");',
      '}',
    ].join('\n');
    expect(nameAt(source, 'throw new Error')).toBe('chargeCard');
  });

  it('does not take a slash-star inside a regular expression or a string spanning lines for a comment', () => {
    const regex = ['const trim = (value) => value.replace(/\\/*$/, "");', 'function saveMeal(input) {', '  throw new Error("x");', '}'].join('\n');
    expect(nameAt(regex, 'throw new Error')).toBe('saveMeal');
    const template = ['const glob = `src/', '**/*.ts`;', 'function build() {', '  throw new Error("x");', '}'].join('\n');
    expect(nameAt(template, 'throw new Error')).toBe('build');
  });
});

