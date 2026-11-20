import { BRIEF_FILE, LIBRARY_SLUG } from "@drawer/shared/api";
import type { TreeEntry } from "@drawer/shared/api";
import { useQuery } from "@tanstack/react-query";
import { BoxIcon, DownloadIcon, ImageIcon, LibraryIcon, ListChecksIcon, MessagesSquareIcon, SendIcon, UnplugIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { sectionOf } from "@/core/parts";
import { newestSession } from "@/core/sessions";
import { fileTextQuery } from "@/hooks/files";
import { useCreateSession, useSendMessage, useSessions } from "@/hooks/sessions";
import { useIsDesktop } from "@/hooks/use-media";
import { useAgentOptions } from "@/hooks/agents";
import { useProjectNav } from "@/lib/nav";
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

/**
 * Sends the first message of a kickstart: into the project's newest session while one is running, else a new
 * session with the agent the person picked. Then opens the agent panel (the phone's session sheet).
 * The one place the workspace starts a session.
 */
function useStartAgent(slug: string) {
  const nav = useProjectNav(slug);
  const desktop = useIsDesktop();
  const sessions = useSessions(slug);
  const agent = useAgentOptions();
  const latest = newestSession(sessions.data, slug);
  const running = latest && latest.status !== "stopped" && latest.status !== "failed" ? latest : undefined;
  const send = useSendMessage(running?.id ?? "");
  const create = useCreateSession();
  const noRunner = agent.noRunner;

  const start = (message: string) => {
    const opened = { onSuccess: (s: { id: string }) => nav.openSession(s.id, { reveal: !desktop }), onError: (err: Error) => toast.error(err.message) };
    if (running) send.mutate({ text: message }, opened);
    else create.mutate({ slug, message, ...agent.request }, { ...opened, onSuccess: (s) => { agent.pick(null); opened.onSuccess(s); } });
  };
  return { start, pending: send.isPending || create.isPending, noRunner };
}

interface KickstartProps {
  slug: string;
  entries: readonly TreeEntry[] | undefined;
  onImport: () => void;
}

/** The centre of a project with nothing to look at yet: a few ways to get the agent going, and a free text field. */
export function Kickstart({ slug, entries, onImport }: KickstartProps) {
  const library = slug === LIBRARY_SLUG;
  const agent = useStartAgent(slug);
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
