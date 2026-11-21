import type { FitBody, MeasureBody, ProbeBody, SectionBody, SliceBody } from "@drawer/shared/api";
import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { featuresOfFile, fetchField, fitFeature, measureFile, probeFile, sectionFile, sliceFile } from "@/services/measure";
import { paramsKey } from "./parts";

/**
 * Measuring a file is keyed by the file's rev (or the revision asked for), so a write makes a new entry
 * and an old one never goes stale. Pass the tree entry's `rev` for the current file.
 */
export const measureKeys = {
  measure: (slug: string, path: string, version: string, params?: MeasureBody["params"]) => ["measure", slug, path, version, paramsKey(params ?? {})] as const,
  slice: (slug: string, path: string, version: string, body: SliceBody) => ["slice", slug, path, version, body.axis, body.at, body.shadow] as const,
  probe: (slug: string, path: string, version: string, body: ProbeBody) => ["probe", slug, path, version, body.axis, body.from.join(",")] as const,
  section: (slug: string, path: string, version: string, body: SectionBody) => ["section", slug, path, version, body.axis, body.at, body.size ?? 800] as const,
  field: (url: string) => ["field", url] as const,
};

/** `version`: the file's rev, or the revision id when `body.revision` is set. */
export const measureQuery = (slug: string, path: string, version: string, body: MeasureBody = {}) =>
  queryOptions({ queryKey: measureKeys.measure(slug, path, version, body.params), queryFn: () => measureFile(slug, path, body), staleTime: Infinity });

export const useMeasure = (slug: string, path: string | undefined, version: string, body: MeasureBody = {}) =>
  useQuery({ ...measureQuery(slug, path ?? "", version, body), enabled: path !== undefined });

/** `body` undefined = nothing asked yet. */
export const useSlice = (slug: string, path: string, version: string, body: SliceBody | undefined) =>
  useQuery({
    queryKey: body ? measureKeys.slice(slug, path, version, body) : ["slice", "off"],
    queryFn: () => sliceFile(slug, path, body ?? { axis: "z", at: 0 }),
    enabled: body !== undefined,
    staleTime: Infinity,
  });

export const useProbe = (slug: string, path: string, version: string, body: ProbeBody | undefined) =>
  useQuery({
    queryKey: body ? measureKeys.probe(slug, path, version, body) : ["probe", "off"],
    queryFn: () => probeFile(slug, path, body ?? { axis: "z", from: [0, 0, 0] }),
    enabled: body !== undefined,
    staleTime: Infinity,
  });

export const useSection = (slug: string, path: string, version: string, body: SectionBody | undefined) =>
  useQuery({
    queryKey: body ? measureKeys.section(slug, path, version, body) : ["section", "off"],
    queryFn: () => sectionFile(slug, path, body ?? { axis: "z", at: 0 }),
    enabled: body !== undefined,
    staleTime: Infinity,
  });

/** A per-triangle `.f32` field (wall thickness, deviation). Field URLs are content-addressed: cached for good. */
export const fieldQuery = (url: string) => queryOptions({ queryKey: measureKeys.field(url), queryFn: () => fetchField(url), staleTime: Infinity, gcTime: 10 * 60_000 });

export const useField = (url: string | null | undefined) => useQuery({ ...fieldQuery(url ?? ""), enabled: typeof url === "string" && url !== "" });


export const useFeatures = (slug: string, path: string, version: string, revision: string | undefined, enabled: boolean) =>
  useQuery({
    queryKey: ["features", slug, path, version, revision],
    queryFn: () => featuresOfFile(slug, path, revision ? { revision } : {}),
    enabled,
    staleTime: Infinity,
  });

export const useFitFeature = (slug: string, path: string, revision?: string) =>
  useMutation({
    mutationFn: (at: FitBody["at"]) => fitFeature(slug, path, { at, ...(revision ? { revision } : {}) }),
  });
