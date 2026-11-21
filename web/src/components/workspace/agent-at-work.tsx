import { motion, useReducedMotion } from "motion/react";

/**
 * What an empty project shows while its first session runs: a part that is laid down layer by layer, outlined,
 * then measured, on a loop. It says "the agent is on it" without words; the agent panel owns the state and the
 * activity. A viewer who asked for less motion gets the finished drawing, still.
 */

const SCALE = 62;
const CX = 120;
const TOP = 40;
/** The box's height in units of its side. */
const HEIGHT = 0.7;
const LAYERS = 8;
const LOOP_SECONDS = 6;
/** Where in the loop everything has been drawn and starts to fade for the next round. */
const HOLD_UNTIL = 0.9;

/** A point of the unit box in the drawing, isometric: x runs down to the right, y down to the left, z up. */
function iso(x: number, y: number, z: number): string {
  const px = CX + (x - y) * SCALE * 0.866;
  const py = TOP + (x + y) * SCALE * 0.5 + (HEIGHT - z) * SCALE;
  return `${px.toFixed(1)} ${py.toFixed(1)}`;
}

const line = (...points: [number, number, number][]): string => points.map((p, i) => `${i === 0 ? "M" : "L"}${iso(...p)}`).join(" ");

const GROUND = `${line([-0.3, -0.3, 0], [1.3, -0.3, 0], [1.3, 1.3, 0], [-0.3, 1.3, 0])} Z`;
/** One printed layer: the two faces turned to the viewer, at one height. */
const layer = (k: number): string => {
  const z = ((k + 0.5) / LAYERS) * HEIGHT;
  return line([0, 1, z], [1, 1, z], [1, 0, z]);
};
const BASE = line([0, 1, 0], [1, 1, 0], [1, 0, 0]);
const UPRIGHTS = [line([0, 1, 0], [0, 1, HEIGHT]), line([1, 1, 0], [1, 1, HEIGHT]), line([1, 0, 0], [1, 0, HEIGHT])];
const LID = `${line([0, 0, HEIGHT], [1, 0, HEIGHT], [1, 1, HEIGHT], [0, 1, HEIGHT])} Z`;
/** The dimension line under the front edge, with its two end ticks. */
const MEASURE = [line([0, 1.24, 0], [1, 1.24, 0]), line([0, 1.16, 0], [0, 1.32, 0]), line([1, 1.16, 0], [1, 1.32, 0])].join(" ");

/** A stroke that draws itself between two moments of the loop (fractions of it), holds, and fades with the rest. */
function Stroke({ d, from, to, still, className, width = 1.75 }: { d: string; from: number; to: number; still: boolean; className?: string; width?: number }) {
  const common = { d, fill: "none", stroke: "currentColor", strokeWidth: width, strokeLinecap: "round", strokeLinejoin: "round", className } as const;
  if (still) return <path {...common} />;
  return (
    <motion.path
      {...common}
      initial={{ pathLength: 0, opacity: 0 }}
      animate={{ pathLength: [0, 0, 1, 1, 1], opacity: [0, 0, 1, 1, 0] }}
      transition={{ duration: LOOP_SECONDS, times: [0, from, to, HOLD_UNTIL, 1], ease: "easeInOut", repeat: Infinity }}
    />
  );
}

export function AgentAtWork({ label }: { label: string }) {
  const still = useReducedMotion() === true;
  return (
    <output className="block w-72 max-w-full">
      <span className="sr-only">{label}</span>
      <svg viewBox="0 0 240 190" className="w-full text-fg" aria-hidden>
        <path d={GROUND} fill="none" stroke="currentColor" strokeWidth={1} strokeDasharray="2 5" strokeLinecap="round" className="text-line" />
        {Array.from({ length: LAYERS }, (_, k) => (
          <Stroke key={k} d={layer(k)} from={0.04 + k * 0.045} to={0.11 + k * 0.045} still={still} width={3} className="text-brand/45" />
        ))}
        <Stroke d={BASE} from={0.42} to={0.5} still={still} />
        {UPRIGHTS.map((d, i) => (
          <Stroke key={d} d={d} from={0.46 + i * 0.02} to={0.56 + i * 0.02} still={still} />
        ))}
        <Stroke d={LID} from={0.54} to={0.68} still={still} />
        <Stroke d={MEASURE} from={0.7} to={0.8} still={still} width={1.5} className="text-up" />
      </svg>
    </output>
  );
}
