import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { HtmlDeliverable } from './HtmlDeliverable';

/**
 * Renders assistant answers as GitHub-flavoured Markdown (tables, lists, code).
 * The surrounding `.markdown` class supplies the typography (see index.css); we
 * wrap in a plain div because react-markdown v10 no longer accepts className.
 *
 * Fenced ```html blocks are treated as deliverables: instead of dumping raw
 * markup, we hand them to <HtmlDeliverable>, which offers a sandboxed preview
 * plus Copy/Download. Everything else renders as Markdown exactly as before.
 */

/** Concatenate the text of a hast node (used to recover the raw code text). */
function hastText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.value || '';
  if (Array.isArray(node.children)) return node.children.map(hastText).join('');
  return '';
}

/** Fallback: concatenate the text of a rendered React element. */
function elementText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(elementText).join('');
  if (node.props && node.props.children !== undefined) return elementText(node.props.children);
  return '';
}

const HTML_LANGS = new Set(['html', 'htm']);

export function Markdown({ children, className = '' }) {
  if (children === undefined || children === null || children === '') return null;
  return (
    <div className={`markdown ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Answers cite documents; open any links safely in a new tab.
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
          // Intercept fenced code blocks so ```html deliverables get the
          // preview/copy/download treatment. All other <pre> blocks are
          // rendered untouched.
          pre: ({ node, children, ...props }) => {
            let classStr = '';
            let code = '';
            const codeNode = node?.children?.find((c) => c && c.tagName === 'code');
            if (codeNode) {
              const rawClass = codeNode.properties?.className;
              classStr = Array.isArray(rawClass) ? rawClass.join(' ') : String(rawClass || '');
              code = hastText(codeNode);
            } else {
              const child = Array.isArray(children) ? children.find(Boolean) : children;
              classStr = String(child?.props?.className || '');
              code = elementText(child);
            }
            const lang = /language-([\w-]+)/.exec(classStr)?.[1]?.toLowerCase();
            if (HTML_LANGS.has(lang)) {
              return <HtmlDeliverable code={code.replace(/\n$/, '')} />;
            }
            return <pre {...props}>{children}</pre>;
          },
        }}
      >
        {String(children)}
      </ReactMarkdown>
    </div>
  );
}
