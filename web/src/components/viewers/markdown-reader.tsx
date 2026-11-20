import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Link as FileLink } from "@drawer/shared/api";
import { categoryTone } from "@/core/kinds";
import { remarkDrawer, resolveWikiTarget, stripFrontmatter } from "@/core/markdown";
import { cn } from "@/lib/utils";

interface MarkdownReaderProps {
  text: string;
  /** The file's outgoing links from FileInfo: how `[[target]]` chips find their file. */
  outgoing: readonly FileLink[];
  /** Opens a resolved link (same project or another). */
  onOpenLink: (link: FileLink) => void;
}

function dataAttr(props: object, name: string): string | undefined {
  const value = Object.entries(props).find(([k]) => k === name)?.[1];
  return typeof value === "string" ? value : undefined;
}

export default function MarkdownReader({ text, outgoing, onOpenLink }: MarkdownReaderProps) {
  const body = useMemo(() => stripFrontmatter(text).body, [text]);

  const components = useMemo<Components>(
    () => ({
      span: (props) => {
        const fact = dataAttr(props, "data-fact");
        if (fact !== undefined) {
          return <span data-fact={fact} className={cn("mr-1.5 inline-flex items-center rounded-md px-1.5 py-0.5 align-baseline text-xs font-medium", categoryTone(fact))}>{fact}</span>;
        }
        const target = dataAttr(props, "data-wiki");
        if (target !== undefined) {
          const link = resolveWikiTarget(target, outgoing);
          if (!link) {
            return (
              <span aria-disabled title="This note does not exist yet" className="inline-flex items-center rounded-md border border-dashed border-line px-1.5 py-0.5 text-xs text-faint">
                {target}
              </span>
            );
          }
          return (
            <button
              type="button"
              onClick={() => onOpenLink(link)}
              className="inline-flex items-center rounded-md border border-line bg-raised px-1.5 py-0.5 text-xs text-fg transition-colors hover:border-brand hover:text-brand focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {target}
            </button>
          );
        }
        return <span className={props.className}>{props.children}</span>;
      },
      a: ({ href, children }) => (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      ),
    }),
    [outgoing, onOpenLink],
  );

  return (
    <div className="prose-drawer mx-auto max-w-3xl px-4 py-6 md:px-8">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkDrawer]} components={components}>
        {body}
      </ReactMarkdown>
    </div>
  );
}
