/** Messages between the renderer and measure-worker.ts. */
import type { AlignResult, OpenClash, Axis, Feature, FeatureKind, MeshInfo, ProbeResult, SliceResult, Vec3 } from "@drawer/shared/api";
import type { ScanNormalization } from "@drawer/shared/contracts";
import type { ScanUnit } from "@drawer/shared/api";
import type { AnalysisResult, DeviationResult } from "./measure";

type Ask =
  | { op: "normalize"; format: MeshInfo["format"]; bytes: Uint8Array; units?: ScanUnit }
  | { op: "proxy"; mesh: string; dest: string; mapping: string }
  | { op: "info"; file: string }
  | { op: "convert"; format: MeshInfo["format"]; source: Uint8Array; dest: string; matrix?: number[] }
  | { op: "volume"; mesh: string }
  | { op: "analyse"; mesh: string; overhangDeg: number }
  | { op: "slice"; mesh: string; axis: Axis; at: number | null }
  | { op: "features"; mesh: string }
  | { op: "align"; mesh: string; to?: string }
  | { op: "fit"; mesh: string; at: Vec3; kind?: FeatureKind }
  | { op: "probe"; mesh: string; from: Vec3; axis: Axis }
  | { op: "deviation"; a: string; b: string }
  | { op: "gap"; a: { mesh: string; matrix: number[] }; b: { mesh: string; matrix: number[] }; clearanceMm: number };

export type WorkerRequest = Ask & { id: number };

export type WorkerAnswer =
  | { op: "normalize"; scan: ScanNormalization }
  | { op: "proxy" }
  | { op: "info"; info: MeshInfo }
  | { op: "convert"; info: MeshInfo }
  | { op: "volume"; mm3: number }
  | { op: "analyse"; analysis: AnalysisResult; thickness: Float32Array }
  | { op: "slice"; result: SliceResult }
  | { op: "features"; features: Feature[]; values: Float32Array }
  | { op: "fit"; feature: Feature | null }
  | { op: "align"; result: AlignResult }
  | { op: "probe"; probe: ProbeResult }
  | { op: "deviation"; result: DeviationResult }
  | { op: "gap"; gapMm: number; disjoint: boolean; penetration?: OpenClash };

export type WorkerReply = ({ id: number; ok: true } & WorkerAnswer) | { id: number; ok: false; error: string };

export type { Ask };
