/**
 * The prompts that get an empty project going. One module, so the wording lives in one place and follows
 * `server/src/guide.md`: read first, ask once before the first model (the agent's `ask_user` tool), spec before
 * model, honest stop. Each prompt says what the project already has, so the agent does not ask for it again.
 */

export interface KickstartContext {
  /** The project is the shared library, not a part project. */
  library: boolean;
  /** brief.md has text beyond its title. */
  hasBrief: boolean;
  /** Files under refs/. */
  refs: number;
}

export type PromptId = "interview" | "first-part" | "plan" | "study-refs" | "library";
export type KickstartId = PromptId | "import";

/** What an action starts: a session with its prompt, or the import dialog. */
export type KickstartAction = { id: PromptId; label: string; kind: "prompt" } | { id: "import"; label: string; kind: "import" };

const READ_FIRST = "Start by reading the project overview, the library notes (printer, materials, tolerances) and everything in the references. Measure what you can instead of guessing a size.";
const ASK_ONCE = "Ask me what is still open in ONE ask_user message: state your assumptions and offer short options. Skip it if nothing is open.";
const NO_MODEL = "Do not write a model yet.";

/** The actions to offer, best first. The text field is always offered besides them. */
export function kickstartActions({ library, hasBrief, refs }: KickstartContext): KickstartAction[] {
  if (library) return [{ id: "library", label: "Set up the library with the agent", kind: "prompt" }];
  const out: KickstartAction[] = [];
  if (hasBrief) {
    out.push({ id: "first-part", label: "Design the first part from the brief", kind: "prompt" });
    out.push({ id: "plan", label: "Plan the parts first", kind: "prompt" });
    out.push({ id: "interview", label: "Refine the brief with me", kind: "prompt" });
  } else {
    out.push({ id: "interview", label: "Interview me and write the brief", kind: "prompt" });
    if (refs > 0) out.push({ id: "study-refs", label: "Study my references", kind: "prompt" });
  }
  out.push({ id: "import", label: "Start from a model I import", kind: "import" });
  return out;
}

/** The first message for a `prompt` action. */
export function kickstartPrompt(id: PromptId, { hasBrief, refs }: KickstartContext): string {
  const refsLine = refs > 0 ? ` The project has ${refs} ${refs === 1 ? "reference" : "references"} under refs/: look at ${refs === 1 ? "it" : "them"} before you ask me anything they already answer.` : "";
  switch (id) {
    case "interview":
      return [
        hasBrief ? "The brief exists, but I want to sharpen it before anything is modelled." : "This project is new and its brief is empty. Interview me before you model anything.",
        READ_FIRST + refsLine,
        `Then ask me, in ONE ask_user message, what the brief leaves open: what the thing is for and how it is used, the sizes and mating objects that are fixed (offer to measure anything I attach), the material and how strict the fit must be, how many parts it is, and what it must not do. State your assumptions and offer short options.`,
        `Write what we agree into brief.md as a clear brief, tell me what you would build first, and stop. ${NO_MODEL}`,
      ].join("\n\n");
    case "first-part":
      return [
        "Design the first part of this project from its brief.",
        READ_FIRST + refsLine,
        "Decide what is one part and what is several. Tell me your assumptions and how you will build it. " + ASK_ONCE,
        "Then write the spec before the model: every size the brief or a mating object fixes becomes a dimension with a tolerance. Model the first part and read the report after every write. Keep going until every gate passes, or say \"not done\" and name the gates that still fail and why.",
      ].join("\n\n");
    case "plan":
      return [
        "Plan the parts of this project from its brief. " + NO_MODEL,
        READ_FIRST + refsLine,
        "Work out which things are printed parts, which are bought (reuse library parts that exist), and whether the design needs an assembly. " + ASK_ONCE,
        "Then write a spec (set_part_spec) for each printed part with its dimensions and tolerances, so the gates are ready before any model exists, and record the plan and your decisions in the project memory as fact lines. Finish with the order you suggest building the parts in.",
      ].join("\n\n");
    case "study-refs":
      return [
        "Study the references I added and tell me what we can build from them. " + NO_MODEL,
        "Read everything under refs/. Measure every model and every photo you can, and never guess a size. Write what you found into the project memory as fact lines.",
        "Then tell me in a few lines what you could make from them and ask me what I want, in ONE ask_user message with short options.",
      ].join("\n\n");
    case "library":
      return [
        "Set up the shared library: what every project reuses. Start by reading what is already here (overview, notes, printer.json, materials.json, the parts).",
        "Then interview me in ONE ask_user message: my printer (model, nozzle, bed size, layer heights, minimum wall, overhang limit), the materials I print with and how each shrinks, how tight my fits must be (press and sliding) and what I have measured, and the bought hardware I keep in stock (screws, magnets, bearings, heat-set inserts). State your assumptions and offer short options.",
        "Write the answers into the library notes as fact lines, and add each piece of hardware as a library part with source bought and only its envelope and mating surfaces. The printer profile and the materials are mine: do not change printer.json or materials.json, tell me exactly what they should say.",
      ].join("\n\n");
  }
}

/** brief.md says something: anything beyond blank lines and headings. */
export const briefHasContent = (text: string | undefined): boolean => (text ?? "").split("\n").some((l) => l.trim() !== "" && !l.trim().startsWith("#"));
