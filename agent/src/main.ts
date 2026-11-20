/** The drawer agent runner: `bun agent/src/main.ts`. Configuration comes from the environment only. */
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { Client } from "@drawer/cli/client";
import { resolveServerUrl } from "@drawer/cli/config";
import { providerBinaries } from "./binaries.ts";
import { ClaudeProvider } from "./providers/claude.ts";
import { CodexProvider } from "./providers/codex.ts";
import { GeminiProvider } from "./providers/gemini.ts";
import { PiProvider } from "./providers/pi.ts";
import { Runner, type Logger } from "./runner.ts";

type Env = Record<string, string | undefined>;
const nonEmpty = (v: string | undefined): string | undefined => (v && v.length > 0 ? v : undefined);

const log: Logger = {
  info: (m) => console.error(`[drawer-agent] ${m}`),
  error: (m) => console.error(`[drawer-agent] error: ${m}`),
};

async function main(): Promise<void> {
  const env = process.env;
  const url = await resolveServerUrl(env);
  if (!url) {
    log.error("no server: set DRAWER_URL (or run `drawer server <url>` once)");
    process.exit(2);
  }
  let binaries: Awaited<ReturnType<typeof providerBinaries>>;
  try {
    binaries = await providerBinaries(env);
  } catch (err) {
    log.error(`bad CLI path: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  const concurrency = Number.parseInt(env.DRAWER_AGENT_CONCURRENCY ?? "2", 10);
  const stateDir = nonEmpty(env.DRAWER_AGENT_STATE) ?? join(nonEmpty(env.XDG_STATE_HOME) ?? join(homedir(), ".local", "state"), "drawer-agent");
  const runnerId = nonEmpty(env.DRAWER_AGENT_ID) ?? hostname();
  // A new nonce per process: the server fails what an earlier process with this id still held.
  const boot = crypto.randomUUID();
  const client = new Client(url, "agent");

  const runner = new Runner({
    client,
    toolClient: client,
    identity: { runner: runnerId, boot },
    providers: [
      new ClaudeProvider({ stateDir, binary: binaries.claude }),
      new CodexProvider({ stateDir, binary: binaries.codex }),
      new PiProvider({ stateDir, binary: binaries.pi }),
      new GeminiProvider({ stateDir, binary: binaries.gemini }),
    ],
    concurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 2,
    log,
  });

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) process.exit(1);
    stopping = true;
    log.info(`${signal}: stopping`);
    void runner.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log.info(`runner ${runnerId} (boot ${boot}) polling ${url} (concurrency ${concurrency}, state ${stateDir})`);
  await runner.run();
}

await main();
