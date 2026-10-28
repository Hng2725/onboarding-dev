import { Fragment, type ReactNode } from 'react';

function inlineNodes(text: string, keyPrefix: string): readonly ReactNode[] {
  const tokenPattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let tokenIndex = 0;
  for (const match of text.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(text.slice(cursor, index));
    const token = match[0];
    const key = keyPrefix + '-' + tokenIndex;
    if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else {
      const closing = token.indexOf('](');
      nodes.push(<span className="lesson-link-text" key={key}>{token.slice(1, closing)}</span>);
    }
    tokenIndex += 1;
    cursor = index + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

type MarkdownBlock =
  | { readonly kind: 'heading'; readonly text: string }
  | { readonly kind: 'list'; readonly items: readonly string[] }
  | { readonly kind: 'paragraph'; readonly lines: readonly string[] };

function parseBlocks(markdown: string): readonly MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (line.startsWith('### ')) {
      blocks.push({ kind: 'heading', text: line.slice(4).trim() });
      index += 1;
      continue;
    }
    if (/^[-*] /.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*] /.test(lines[index])) {
        items.push(lines[index].slice(2).trim());
        index += 1;
      }
      blocks.push({ kind: 'list', items });
      continue;
    }
    const paragraph: string[] = [];
    while (
      index < lines.length
      && lines[index].trim()
      && !lines[index].startsWith('### ')
      && !/^[-*] /.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ kind: 'paragraph', lines: paragraph });
  }
  return blocks;
}

export function LessonMarkdown({ markdown }: { markdown: string }) {
  return (
    <div className="lesson-markdown">
      {parseBlocks(markdown).map((block, blockIndex) => {
        const key = block.kind + '-' + blockIndex;
        if (block.kind === 'heading') {
          return <h3 key={key}>{inlineNodes(block.text, key)}</h3>;
        }
        if (block.kind === 'list') {
          return <ul key={key}>{block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{inlineNodes(item, key + '-' + itemIndex)}</li>
          ))}</ul>;
        }
        return (
          <p key={key}>{block.lines.map((line, lineIndex) => (
            <Fragment key={lineIndex}>
              {lineIndex > 0 && <br />}
              {inlineNodes(line, key + '-' + lineIndex)}
            </Fragment>
          ))}</p>
        );
      })}
    </div>
  );
}
