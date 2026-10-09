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

  it('ignores braces inside strings and comments and handles one-line functions', () => {
    expect(nameAt(['function render(name: string) {', "  const open = '{';", '  // closing } here', '  return open + name.trim();', '}'].join('\n'), 'return')).toBe('render');
    expect(nameAt('function fail() { throw new Error("x") }', 'throw')).toBe('fail');
  });

  it('gives up at top-level code and at the markup of a Svelte component', () => {
    expect(nameAt(['const cart = loadCart();', 'cart.items[0].price;'].join('\n'), 'cart.items[0]')).toBeUndefined();
    expect(nameAt(['<script lang="ts">', '  function go() {', '    navigate();', '  }', '</script>', '', '<button onclick={() => crash()}>Ir</button>'].join('\n'), 'crash()')).toBeUndefined();
  });
});
