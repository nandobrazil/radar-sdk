const IDENTIFIER = '[A-Za-z_$][\\w$]*';
const MAX_LINES_UP = 400;
const MAX_HEADER_LINES = 6;
const MAX_NAME_LENGTH = 100;
const MAX_COMMENT_LINES = 40;
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

const STRING_LITERAL = /(["'`])(?:\\.|(?!\1)[^\\])*\1/g;

function lineCommentAt(text: string, from: number): number {
  for (let index = text.indexOf('//', from); index >= 0; index = text.indexOf('//', index + 1)) {
    if (index === 0 || text[index - 1] !== ':') return index;
  }
  return -1;
}

function blockCommentAt(text: string, from: number): number {
  for (let index = text.indexOf('/*', from); index >= 0; index = text.indexOf('/*', index + 1)) {
    if (index === 0 || text[index - 1] !== '\\') return index;
  }
  return -1;
}

function stripComments(text: string, insideComment: boolean, closesLater: () => boolean): { code: string; insideComment: boolean } {
  let code = '';
  let position = 0;
  let inside = insideComment;
  while (position < text.length) {
    if (inside) {
      const end = text.indexOf('*/', position);
      if (end < 0) return { code, insideComment: true };
      inside = false;
      position = end + 2;
      continue;
    }
    const block = blockCommentAt(text, position);
    const line = lineCommentAt(text, position);
    if (line >= 0 && (block < 0 || line < block)) return { code: code + text.slice(position, line), insideComment: false };
    if (block < 0) return { code: code + text.slice(position), insideComment: false };
    if (text.indexOf('*/', block + 2) < 0 && !closesLater()) {
      code += text.slice(position, block + 2);
      position = block + 2;
      continue;
    }
    code += text.slice(position, block);
    inside = true;
    position = block + 2;
  }
  return { code, insideComment: inside };
}

function codeLines(lines: string[], from: number, start: number, column: number | undefined): string[] {
  const plain = lines.slice(from, start + 1).map((line) => line.replace(STRING_LITERAL, '""'));
  const closesWithin = (index: number) => plain.slice(index + 1, index + 1 + MAX_COMMENT_LINES).some((line) => line.includes('*/'));
  const result: string[] = [];
  let insideComment = false;
  for (let index = 0; index < plain.length; index++) {
    const text = index === plain.length - 1 && column ? (lines[start] ?? '').slice(0, Math.max(0, column - 1)).replace(STRING_LITERAL, '""') : (plain[index] ?? '');
    const stripped = stripComments(text, insideComment, () => closesWithin(index));
    insideComment = stripped.insideComment;
    result.push(stripped.code);
  }
  return result;
}

function parenBalance(text: string): number {
  let balance = 0;
  for (const char of text) {
    if (char === '(') balance += 1;
    else if (char === ')') balance -= 1;
  }
  return balance;
}

function headerOf(code: string[], index: number, prefix: string): string {
  let header = prefix;
  for (let previous = index - 1; previous >= 0 && previous >= index - MAX_HEADER_LINES; previous--) {
    if (header.trim() !== '' && parenBalance(header) >= 0) break;
    header = `${code[previous] ?? ''} ${header}`;
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
  const from = Math.max(0, start - MAX_LINES_UP - MAX_HEADER_LINES);
  const cleaned = codeLines(lines, from, start, column);
  let depth = 0;
  for (let index = start; index >= 0 && index >= start - MAX_LINES_UP; index--) {
    if (index < start && MARKUP_BOUNDARY.test(lines[index] ?? '')) return undefined;
    const code = cleaned[index - from] ?? '';
    for (let position = code.length - 1; position >= 0; position--) {
      const char = code[position];
      if (char === '}') {
        depth += 1;
      } else if (char === '{') {
        if (depth > 0) {
          depth -= 1;
          continue;
        }
        const header = headerOf(cleaned, index - from, code.slice(0, position));
        if (CLASS_BODY.test(header)) return undefined;
        if (CONTROL_BLOCK.test(header)) continue;
        const name = nameIn(header);
        if (name) return name;
      }
    }
  }
  return undefined;
}
