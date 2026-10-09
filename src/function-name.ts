const IDENTIFIER = '[A-Za-z_$][\\w$]*';
const MAX_LINES_UP = 400;
const MAX_HEADER_LINES = 6;
const MAX_NAME_LENGTH = 100;
const CONTROL_BLOCK = /^\s*(?:\}\s*)?(?:if|else|for|while|do|switch|try|catch|finally|with)\b/;
const CLASS_BODY = new RegExp(`\\bclass\\s+${IDENTIFIER}`);
const MARKUP_BOUNDARY = /<\/?(?:script|style|template)\b/i;
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'new', 'typeof', 'await', 'else', 'do', 'try']);
const NAME_PATTERNS = [
  new RegExp(`\\bfunction\\s*\\*?\\s*(${IDENTIFIER})\\s*\\(`),
  new RegExp(`(${IDENTIFIER})\\s*[:=]\\s*(?:async\\s+)?function\\b`),
  new RegExp(`(${IDENTIFIER})\\s*(?::\\s*[^=]+)?=\\s*(?:async\\s+)?(?:\\([^]*\\)|${IDENTIFIER})\\s*(?::\\s*[^=]+)?=>\\s*$`),
  new RegExp(`(?:^|[{,(]\\s*)(${IDENTIFIER})\\s*:\\s*(?:async\\s+)?(?:\\([^]*\\)|${IDENTIFIER})\\s*(?::\\s*[^=]+)?=>\\s*$`),
];
const METHOD_PATTERN = new RegExp(`^\\s*(?:(?:export|default|public|private|protected|static|async|override|readonly|get|set)\\s+)*\\*?\\s*(${IDENTIFIER})\\s*(?:<[^>]*>)?\\s*\\([^]*\\)\\s*(?::\\s*[^{]+)?$`);
const ANONYMOUS_FUNCTION = /\bfunction\b|=>/;

function codeOnly(text: string): string {
  return text
    .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '""')
    .replace(/\/\*.*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/, '$1');
}

function parenBalance(text: string): number {
  let balance = 0;
  for (const char of text) {
    if (char === '(') balance += 1;
    else if (char === ')') balance -= 1;
  }
  return balance;
}

function headerOf(lines: string[], index: number, prefix: string): string {
  let header = prefix;
  for (let previous = index - 1; previous >= 0 && previous >= index - MAX_HEADER_LINES; previous--) {
    if (header.trim() !== '' && parenBalance(header) >= 0) break;
    header = `${codeOnly(lines[previous] ?? '')} ${header}`;
  }
  return header;
}

function nameIn(header: string): string | undefined {
  const patterns = ANONYMOUS_FUNCTION.test(header) ? NAME_PATTERNS : [...NAME_PATTERNS, METHOD_PATTERN];
  for (const pattern of patterns) {
    const name = pattern.exec(header)?.[1];
    if (name && !KEYWORDS.has(name)) return name.slice(0, MAX_NAME_LENGTH);
  }
  return undefined;
}

export function enclosingFunctionName(lines: string[], line: number, column?: number): string | undefined {
  const start = line - 1;
  if (start < 0 || start >= lines.length) return undefined;
  let depth = 0;
  for (let index = start; index >= 0 && index >= start - MAX_LINES_UP; index--) {
    const raw = lines[index] ?? '';
    if (index < start && MARKUP_BOUNDARY.test(raw)) return undefined;
    const code = codeOnly(index === start && column ? raw.slice(0, Math.max(0, column - 1)) : raw);
    for (let position = code.length - 1; position >= 0; position--) {
      const char = code[position];
      if (char === '}') {
        depth += 1;
      } else if (char === '{') {
        if (depth > 0) {
          depth -= 1;
          continue;
        }
        const header = headerOf(lines, index, code.slice(0, position));
        if (CLASS_BODY.test(header)) return undefined;
        if (CONTROL_BLOCK.test(header)) continue;
        const name = nameIn(header);
        if (name) return name;
      }
    }
  }
  return undefined;
}
