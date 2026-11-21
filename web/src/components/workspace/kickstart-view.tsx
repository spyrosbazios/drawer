import { BRIEF_FILE, LIBRARY_SLUG } from "@drawer/shared/api";
import type { TreeEntry } from "@drawer/shared/api";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { BotIcon, BoxIcon, DownloadIcon, ImageIcon, LibraryIcon, ListChecksIcon, MessagesSquareIcon, SendIcon, UnplugIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { sectionOf } from "@/core/parts";
import { fileTextQuery } from "@/hooks/files";
import { useStartAgent } from "@/hooks/start-agent";
import { useIsDesktop } from "@/hooks/use-media";
import { useProjectNav } from "@/lib/nav";
import { PROJECT_DEFAULTS } from "@/lib/route-search";
import { AgentAtWork } from "./agent-at-work";
import { briefHasContent, kickstartActions, kickstartPrompt } from "./kickstart";
import type { KickstartId } from "./kickstart";

const ICON: Record<KickstartId, typeof BoxIcon> = {
  interview: MessagesSquareIcon,
  "first-part": BoxIcon,
  plan: ListChecksIcon,
  "study-refs": ImageIcon,
  import: DownloadIcon,
  library: LibraryIcon,
};

interface KickstartProps {
  slug: string;
  entries: readonly TreeEntry[] | undefined;
  onImport: () => void;
}

const route = getRouteApi("/p/$slug");

/** While a session of the project is on it: the animation, and nothing to read. The agent panel owns the state and the activity. */
function AgentOnIt({ slug, session, library }: { slug: string; session: string; library: boolean }) {
  const nav = useProjectNav(slug);
  const desktop = useIsDesktop();
  const search = route.useSearch();
  const shown = desktop ? (search.panel ?? PROJECT_DEFAULTS.panel) === "session" : search.sheet === "session";
  return (
    <div className="flex h-full overflow-y-auto scroll-contain">
      <div className="m-auto flex w-full max-w-lg flex-col items-center gap-5 p-6">
        <AgentAtWork label={library ? "The agent is setting up the library." : "The agent is on it."} />
        {!shown && (
          <Button variant="outline" onClick={() => nav.openSession(session, { reveal: !desktop })}>
            <BotIcon /> Open the agent panel
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The centre of a project with nothing to look at yet: a few ways to get the agent going, and a free text
 * field. While a session is on it, an animation instead: the actions would only start a second one.
 */
export function Kickstart({ slug, entries, onImport }: KickstartProps) {
  const agent = useStartAgent(slug);
  if (agent.ongoing) return <AgentOnIt slug={slug} session={agent.ongoing.id} library={slug === LIBRARY_SLUG} />;
  return <StartActions slug={slug} entries={entries} onImport={onImport} agent={agent} />;
}

function StartActions({ slug, entries, onImport, agent }: KickstartProps & { agent: ReturnType<typeof useStartAgent> }) {
  const library = slug === LIBRARY_SLUG;
  const [text, setText] = useState("");
  const briefExists = (entries ?? []).some((e) => e.path === BRIEF_FILE);
  const brief = useQuery({ ...fileTextQuery(slug, BRIEF_FILE), enabled: briefExists });
  const refs = (entries ?? []).filter((e) => e.type === "file" && sectionOf(e.path) === "references").length;
  const context = { library, hasBrief: briefHasContent(brief.data?.text), refs };
  const idle = agent.pending || agent.noRunner;

  const submit = () => {
    const message = text.trim();
    if (message === "" || idle) return;
    agent.start(message);
    setText("");
  };

  return (
    <div className="flex h-full overflow-y-auto scroll-contain">
      <div className="m-auto flex w-full max-w-lg flex-col gap-5 p-6">
        <h2 className="text-lg font-medium">{library ? "Set up the library" : "Start this project"}</h2>
        <div className="flex flex-col gap-2">
          {kickstartActions(context).map((a) => {
            const Icon = ICON[a.id];
            return (
              <Button
                key={a.id}
                variant="outline"
                className="h-auto justify-start gap-3 px-3 py-3 text-left whitespace-normal"
                disabled={a.kind === "prompt" && idle}
                onClick={() => (a.kind === "import" ? onImport() : agent.start(kickstartPrompt(a.id, context)))}
              >
                <Icon className="text-dim" />
                {a.label}
              </Button>
            );
          })}
        </div>
        {!library && (
          <InputGroup className="h-auto">
            <InputGroupTextarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="Describe what you want to make"
              aria-label="Describe what you want to make"
              rows={3}
            />
            <InputGroupAddon align="block-end">
              <InputGroupButton variant="default" size="sm" className="ml-auto" disabled={text.trim() === "" || idle} onClick={submit}>
                <SendIcon /> Send
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        )}
        {agent.noRunner && (
          <p className="flex items-center gap-2 text-xs text-warn">
            <UnplugIcon className="size-3.5 shrink-0" aria-hidden /> No agent runner is connected.
          </p>
        )}
      </div>
    </div>
  );
}
