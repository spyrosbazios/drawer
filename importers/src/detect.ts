import type { ImportSite } from "@drawer/shared/api";

/** A model page on a site we know, with the id the site's API wants. */
export interface ModelRef {
  site: Exclude<ImportSite, "generic">;
  /** Numeric id (printables, thingiverse, makerworld, myminifactory) or slug (cults3d). */
  id: string;
}

const CULTS_MODEL_SECTIONS = new Set(["3d-model", "modele-3d", "modelo-3d", "modello-3d", "3d-modell"]);

function hostIs(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function segments(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean).map(decodeSafe);
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Pure URL matching. Returns null for anything that is not a recognised model page. */
export function parseModelUrl(raw: string): ModelRef | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  const parts = segments(url);

  if (hostIs(host, "printables.com")) {
    // /model/<id>-slug, optionally behind a language prefix (/de/model/...)
    const i = parts.indexOf("model");
    const m = i >= 0 ? /^(\d+)(?:-|$)/.exec(parts[i + 1] ?? "") : null;
    return m?.[1] ? { site: "printables", id: m[1] } : null;
  }

  if (hostIs(host, "thingiverse.com")) {
    // /thing:<id>, with optional /files, /comments ... after it
    for (const part of parts) {
      const m = /^thing:(\d+)$/.exec(part);
      if (m?.[1]) return { site: "thingiverse", id: m[1] };
    }
    return null;
  }

  if (hostIs(host, "makerworld.com")) {
    // /<lang>/models/<id>-slug, or /models/<id>
    const i = parts.indexOf("models");
    const m = i >= 0 ? /^(\d+)(?:-|$)/.exec(parts[i + 1] ?? "") : null;
    return m?.[1] ? { site: "makerworld", id: m[1] } : null;
  }

  if (hostIs(host, "cults3d.com")) {
    // /<lang>/3d-model/<category>/<slug>; the section word is translated per language
    const i = parts.findIndex((p) => CULTS_MODEL_SECTIONS.has(p));
    const slug = i >= 0 ? parts[i + 2] : undefined;
    return slug ? { site: "cults3d", id: slug } : null;
  }

  if (hostIs(host, "myminifactory.com")) {
    // /object/3d-print-<slug>-<id>
    const i = parts.indexOf("object");
    const m = i >= 0 ? /(?:^|-)(\d+)$/.exec(parts[i + 1] ?? "") : null;
    return m?.[1] ? { site: "myminifactory", id: m[1] } : null;
  }

  return null;
}

export function detectSite(url: string): ImportSite {
  return parseModelUrl(url)?.site ?? "generic";
}
