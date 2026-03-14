import Markdown from 'react-markdown';

interface MessageContentProps {
  content: string;
}

const ALLOWED_ELEMENTS = new Set([
  'p', 'strong', 'em', 'del', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'code', 'pre', 'blockquote', 'hr', 'br', 'a',
]);

export function MessageContent({ content }: MessageContentProps) {
  return (
    <div className="text-sm text-text prose-msg">
      <Markdown
        allowedElements={[...ALLOWED_ELEMENTS]}
        unwrapDisallowed
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline hover:brightness-125">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
