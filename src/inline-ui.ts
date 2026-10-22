import fs from 'node:fs';
import path from 'node:path';

const MAX_INLINE_UI_BYTES = 8 * 1024 * 1024;
const ASSET_REFERENCE_RE = /\b(?:src|href)\s*=\s*(["'])(\.?\/?assets\/[^"']+)\1/i;
const MODULE_PRELOAD_RE = /<link\b[^>]*\brel\s*=\s*(["'])modulepreload\1[^>]*>/i;
const STYLESHEET_RE = /<link\b(?=[^>]*\brel\s*=\s*(["'])stylesheet\1)(?=[^>]*\bhref\s*=\s*(["'])([^"']+)\2)[^>]*>/gi;
const MODULE_SCRIPT_RE = /<script\b(?=[^>]*\bsrc\s*=\s*(["'])([^"']+)\1)[^>]*>\s*<\/script>/gi;

const BOOT_WATCHDOG = `<script>(function(){setTimeout(function(){if(window.__privosUiBooted)return;var root=document.getElementById('root')||document.body;if(root)root.innerHTML='<div style="font:14px system-ui;padding:24px;text-align:center">Không thể khởi động Onboarding — <button onclick="location.reload()">Thử lại</button></div>';try{parent.postMessage({method:'ui/app-boot-failed'},'*')}catch(e){}},10000)})();</script>`;

export interface InlineBuiltUi {
  renderHtml(): string;
}

function assetPath(distDir: string, reference: string, expectedExtension: string): string {
  const normalized = reference.replace(/^\.\//, '');
  if (!normalized.startsWith('assets/') || path.extname(normalized).toLowerCase() !== expectedExtension) {
    throw new Error(`inlineUi: unsupported build asset reference: ${reference}`);
  }

  const assetsDir = path.resolve(distDir, 'assets');
  const resolved = path.resolve(distDir, normalized);
  const relative = path.relative(assetsDir, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`inlineUi: asset reference escapes dist/ui/assets: ${reference}`);
  }
  return resolved;
}

function escapeClosingTag(source: string, tagName: 'script' | 'style'): string {
  return source.replace(new RegExp(`</${tagName}`, 'gi'), `<\\/${tagName}`);
}

function renderInlineHtml(distDir: string): string {
  const indexPath = path.resolve(distDir, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');

  if (MODULE_PRELOAD_RE.test(html)) {
    throw new Error('inlineUi: modulepreload chunks are not supported; build the UI with inlineDynamicImports.');
  }

  html = html.replace(STYLESHEET_RE, (_tag, _relQuote, _hrefQuote, reference: string) => {
    const css = fs.readFileSync(assetPath(distDir, reference, '.css'), 'utf8');
    return `<style>${escapeClosingTag(css, 'style')}</style>`;
  });

  html = html.replace(MODULE_SCRIPT_RE, (_tag, _quote, reference: string) => {
    const javascript = fs.readFileSync(assetPath(distDir, reference, '.js'), 'utf8');
    return `<script type="module">${escapeClosingTag(javascript, 'script')}</script>`;
  });

  const unresolved = ASSET_REFERENCE_RE.exec(html)?.[2];
  if (unresolved) {
    throw new Error(`inlineUi: build still contains an external asset reference: ${unresolved}`);
  }
  if (!/<style>[\s\S]+<\/style>/i.test(html) || !/<script\b[^>]*type=["']module["'][^>]*>[\s\S]+<\/script>/i.test(html)) {
    throw new Error('inlineUi: the Vite build must contain one stylesheet and one module entry.');
  }

  html = html.replace(/<head([^>]*)>/i, `<head$1>\n  <meta name="privos-ui-assets" content="inline">\n  ${BOOT_WATCHDOG}`);
  if (Buffer.byteLength(html, 'utf8') > MAX_INLINE_UI_BYTES) {
    throw new Error(`inlineUi: self-contained UI exceeds ${MAX_INLINE_UI_BYTES} bytes.`);
  }
  return html;
}

export function serveInlineBuiltUi(distDir: string): InlineBuiltUi {
  let cachedHtml: string | null = null;
  return {
    renderHtml() {
      cachedHtml ??= renderInlineHtml(distDir);
      return cachedHtml;
    },
  };
}
