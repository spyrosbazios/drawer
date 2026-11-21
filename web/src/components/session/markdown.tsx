import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockLine, CodeBlockTitle } from "@/components/ui/code-block";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";

function textOf(node: unknown): string {
  if (typeof node !== "object" || node === null) return "";
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node && Array.isArray(node.children)) return node.children.map(textOf).join("");
  return "";
}

function FencedCode({ code, language }: { code: string; language: string }) {
  const lines = useHighlightedCode(code, language);
  return (
    <CodeBlock size="sm">
      <CodeBlockHeader>
        <CodeBlockTitle>{language || "text"}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={code} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent>
        {lines.map((line, i) => (
          <CodeBlockLine key={i}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
}

/** Fenced code goes to a CodeBlock; inline code stays inline (the `pre` decides, so inline code never reaches it). Links open in a new tab. */
const COMPONENTS: Components = {
  pre: ({ node }) => {
    const code = node?.children[0];
    const className = code && "properties" in code ? code.properties.className : undefined;
    const language = Array.isArray(className) ? String(className[0] ?? "").replace("language-", "") : "";
    return <FencedCode code={textOf(code).replace(/\n$/, "")} language={language} />;
  },
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

const INLINE = ["strong", "em", "del", "code", "a"];

/**
 * Markdown where only a line of text fits (a choice, a one-line record): emphasis, code and links are drawn,
 * every block is unwrapped to its text.
 */
export function InlineMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} allowedElements={INLINE} unwrapDisallowed components={{ a: COMPONENTS.a }}>
      {text}
    </ReactMarkdown>
  );
}

/** The agent's text: GitHub-flavoured markdown at thread size. */
export default function ThreadMarkdown({ text }: { text: string }) {
  return (
    <div className="prose-drawer text-sm leading-6 [&_h1]:mt-4 [&_h1]:border-0 [&_h1]:pb-0 [&_h1]:text-base [&_h2]:mt-4 [&_h2]:text-base [&_h3]:mt-3 [&_h3]:text-sm [&>*+*]:mt-3">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
