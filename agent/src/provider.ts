/**
 * The boundary between orchestration and a model provider. The runner only sees this: a provider gets
 * bound tools and a prompt, and reports what happens as normalised events.
 */
import type { ProviderKind, ProviderState } from "@drawer/shared/api";
import type { z } from "zod";
import type { ImageMediaType } from "./images.ts";
import type { ToolOutput } from "./tools.ts";

/** A drawer tool with its session context already bound. */
export interface BoundTool {
  name: string;
  description: string;
  input: z.ZodRawShape;
  call(input: unknown): Promise<ToolOutput>;
}

export type ProviderEvent =
  /** The provider's handle for this conversation, for resuming it next turn. */
  | { type: "resume"; handle: string }
  | { type: "assistant_text"; text: string }
  | { type: "tool_started"; callId: string; name: string; input: unknown }
  | { type: "tool_finished"; callId: string; name: string; ok: boolean; summary: string; text: string; images: string[] }
  | { type: "activity"; text: string };

/** An image a person attached, as bytes the provider can send as image input. */
export interface TurnImage {
  mediaType: ImageMediaType;
  data: Uint8Array;
}

/**
 * One message from the person. `text` stands on its own: it names every attachment (id, name, type,
 * size, where it was filed) and says which ones follow as images. A provider without image input sends
 * `text` and leaves `images` out; the agent can still file, measure and read the attachments with its tools.
 */
export interface TurnMessage {
  text: string;
  images: TurnImage[];
}

export interface Turn {
  /** drawer's session id: stable across turns (a provider may key local state on it). */
  sessionId: string;
  systemPrompt: string;
  /** The person's pending messages, oldest first. */
  messages: TurnMessage[];
  resume: string | null;
  /** null = the provider's own default. */
  model: string | null;
  tools: BoundTool[];
  signal: AbortSignal;
  onEvent(event: ProviderEvent): void;
}

/** What a provider found on this host, without a model call. `disabled` is the runner's to say, from settings. */
export interface ProviderCheck {
  state: Exclude<ProviderState, "disabled">;
  version: string | null;
  models: string[];
  /** Why it is not ready, or how to sign in. */
  message: string | null;
  /** The CLI this provider runs, as resolved on this host; null when none was found. */
  binary: string | null;
}

export interface Provider {
  kind: ProviderKind;
  /** Probes the CLI (installed, version, sign-in, models). Never throws. */
  check(): Promise<ProviderCheck>;
  /** Resolves when the agent ends its turn; rejects on failure or abort. */
  run(turn: Turn): Promise<void>;
}

/** The turn must not run: the provider would have, or tried to use, a tool that is not drawer's. */
export class ForeignToolError extends Error {
  override name = "ForeignToolError";
  constructor(what: string) {
    super(`refusing to run: the agent ${what}; it may only use drawer's tools`);
  }
}
