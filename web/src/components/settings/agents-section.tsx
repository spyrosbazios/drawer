import { isModelId, PROVIDER_KINDS, type ProviderKind, type ProviderSettings, type Settings } from "@drawer/shared/api";
import { BotIcon, PlusIcon, TerminalIcon, UnplugIcon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { StatusChip } from "@/components/status/status-chip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useRunners, useRunnersCatchUp } from "@/hooks/sessions";
import { usePatchSettings, useSettings } from "@/hooks/settings";
import { PROVIDER_LABELS } from "@/lib/agent-choice";
import { codeSpans, providerView, type ProviderView } from "./model";
import { SettingsSection } from "./settings-section";

/** Radix Select takes no empty value: this stands for "the provider's own default model". */
const OWN_DEFAULT = "__provider-default__";

function useSave() {
  const patch = usePatchSettings();
  return (kind: ProviderKind, change: Partial<ProviderSettings>) =>
    patch.mutateAsync({ providers: { [kind]: change } }).then(
      () => true,
      (err: unknown) => {
        toast.error(err instanceof Error ? err.message : "Could not save");
        return false;
      },
    );
}

/** Providers: which agents new sessions may use, their default models, and what the runners found. */
export function AgentsSection() {
  const settings = useSettings();
  const runners = useRunners();
  const views = settings.data === undefined ? [] : PROVIDER_KINDS.map((k) => providerView(k, settings.data, runners.data ?? []));
  useRunnersCatchUp(views.some((v) => v.awaitingRunner));
  return (
    <SettingsSection id="agents" icon={<BotIcon className="size-4 text-dim" />} title="Agents" description="Each agent uses its own CLI login on the runner's host; drawer stores no keys.">
      {settings.data === undefined || runners.isPending ? (
        <Skeleton className="h-48 w-full rounded-xl" />
      ) : (
        <Agents settings={settings.data} noRunner={runners.isSuccess && runners.data.length === 0} views={views} />
      )}
    </SettingsSection>
  );
}

function Agents({ settings, views, noRunner }: { settings: Settings; views: ProviderView[]; noRunner: boolean }) {
  const patch = usePatchSettings();
  const enabled = PROVIDER_KINDS.filter((k) => settings.providers[k].enabled);
  return (
    <div className="space-y-3">
      {noRunner && (
        <p className="flex items-start gap-2 rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-xs text-warn">
          <UnplugIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            No agent runner connected, so nothing is checked. Start <code className="font-mono">drawer-agent</code> on the host.
          </span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label htmlFor="default-provider" className="text-dim">
          New sessions use
        </label>
        <Select
          value={settings.defaultProvider}
          onValueChange={(v) => {
            const kind = PROVIDER_KINDS.find((k) => k === v);
            if (kind) patch.mutate({ defaultProvider: kind }, { onError: (err) => toast.error(err.message) });
          }}
        >
          <SelectTrigger id="default-provider" size="sm" className="min-w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {enabled.map((k) => (
              <SelectItem key={k} value={k}>
                {PROVIDER_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <ul className="grid gap-3 md:grid-cols-2">
        {views.map((v) => (
          <li key={v.kind}>
            <ProviderCard view={v} own={settings.providers[v.kind]} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Message({ text }: { text: string }) {
  return (
    <span>
      {codeSpans(text).map((s, i) =>
        s.code ? (
          <code key={i} className="font-mono break-all select-all">
            {s.text}
          </code>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </span>
  );
}

function ProviderCard({ view, own }: { view: ProviderView; own: ProviderSettings }) {
  const save = useSave();
  const label = PROVIDER_LABELS[view.kind];
  return (
    <div className="space-y-3 border-t border-line pt-4">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">{label}</h3>
        {view.state ? <StatusChip kind="provider" status={view.state} /> : <span className="text-xs text-faint">{view.awaitingRunner ? "waiting for the runner" : "unknown"}</span>}
        {view.version && <span className="text-xs text-faint tabular-nums">v{view.version}</span>}
        <Switch
          className="ml-auto"
          checked={own.enabled}
          disabled={view.isDefault}
          title={view.isDefault ? "The default agent stays on" : undefined}
          aria-label={`Use ${label}`}
          onCheckedChange={(on) => void save(view.kind, { enabled: on })}
        />
      </div>
      {own.enabled && view.findings.map((f) => (
        <p key={f.runner} className="text-xs text-dim">
          <span className="text-faint">{f.runner}:</span> {f.message ? <Message text={f.message} /> : f.state === "ready" ? "ready" : f.state.replace("_", " ")}
        </p>
      ))}
      {view.findings.some((f) => f.binary !== null) && (
        <div className="space-y-0.5 text-xs">
          {view.findings.map((f) =>
            f.binary === null ? null : (
              <p key={f.runner} className="flex min-w-0 gap-1.5 text-dim">
                <TerminalIcon className="mt-0.5 size-3 shrink-0 text-faint" aria-hidden />
                <span className="text-faint">{f.runner}:</span>
                <code className="min-w-0 font-mono break-all select-all">{f.binary}</code>
              </p>
            ),
          )}
          <p className="text-faint">
            Set on the runner's host (<code className="font-mono">DRAWER_AGENT_{view.kind.toUpperCase()}_BIN</code>), not here.
          </p>
        </div>
      )}
      <div className="grid gap-2 text-xs">
        <Row label="Default model" htmlFor={`${view.kind}-model`}>
          <Select value={own.defaultModel ?? OWN_DEFAULT} onValueChange={(v) => void save(view.kind, { defaultModel: v === OWN_DEFAULT ? null : v })}>
            <SelectTrigger id={`${view.kind}-model`} size="sm" className="w-full min-w-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={OWN_DEFAULT}>{label}'s default</SelectItem>
              {view.models.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        <Row label="Extra models">
          <CustomModels kind={view.kind} models={own.customModels} />
        </Row>
      </div>
    </div>
  );
}

function Row({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-2">
      <label htmlFor={htmlFor} className="text-dim">
        {label}
      </label>
      {children}
    </div>
  );
}

function CustomModels({ kind, models }: { kind: ProviderKind; models: string[] }) {
  const save = useSave();
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const add = () => {
    const id = text.trim();
    if (id === "" || models.includes(id)) return setText("");
    if (!isModelId(id)) return setProblem("Use letters, digits and . _ : / @ + -");
    void save(kind, { customModels: [...models, id] }).then((ok) => ok && setText(""));
  };
  return (
    <div className="flex flex-wrap items-center gap-1">
      {models.map((m) => (
        <span key={m} className="inline-flex items-center gap-0.5 rounded-md border border-line bg-raised py-0.5 pr-0.5 pl-1.5 font-mono">
          {m}
          <Button variant="ghost" size="icon-xs" aria-label={`Remove ${m}`} onClick={() => void save(kind, { customModels: models.filter((x) => x !== m) })}>
            <XIcon />
          </Button>
        </span>
      ))}
      <div className="flex min-w-32 flex-1 items-center gap-1">
        <Input
          value={text}
          placeholder="model id"
          aria-label={`Add a model for ${PROVIDER_LABELS[kind]}`}
          aria-invalid={problem !== null}
          className="h-7 font-mono text-xs placeholder:font-sans"
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            setProblem(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <Button variant="ghost" size="icon-xs" aria-label="Add model" disabled={text.trim() === ""} onClick={add}>
          <PlusIcon />
        </Button>
      </div>
      {problem && <p role="alert" className="w-full text-xs text-destructive">{problem}</p>}
    </div>
  );
}
