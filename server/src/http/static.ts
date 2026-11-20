import { stat } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { notFound } from "../errors.ts";

/** Serves the built web app; any other GET without a file falls back to index.html (SPA routing). */
export async function serveWeb(webDist: string, pathname: string): Promise<Response> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw notFound("not found");
  }
  const root = normalize(webDist);
  const candidate = normalize(join(root, decoded));
  if (candidate === root || candidate.startsWith(root + sep)) {
    const file = Bun.file(candidate);
    if (decoded !== "/" && (await stat(candidate).then((st) => st.isFile(), () => false))) {
      const immutable = decoded.startsWith("/assets/");
      return new Response(file, { headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" } });
    }
  }
  const index = Bun.file(join(root, "index.html"));
  if (!(await index.exists())) {
    return new Response("The web app is not built (web/dist is missing). The API is available under /api.\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(index, { headers: { "cache-control": "no-cache", "content-type": "text/html; charset=utf-8" } });
}
