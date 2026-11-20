/**
 * Routes for parts, measuring, assemblies and the project overview (docs/SPEC.md → HTTP routes).
 */
import type { CompareSide, EvaluateBody, PrintBody } from "@drawer/shared/api";
import { invalid } from "../errors.ts";
import type { Service } from "../service.ts";
import { normalizePath } from "../store/paths.ts";
import type { Router, RouteContext } from "./router.ts";
import { onlyFields, optInt, optParams, optString, readJsonBody, reqAxis, reqNumber, reqString, reqVec3, type Obj } from "./validate.ts";

type Json = (body: unknown, status?: number) => Response;

function side(value: unknown, name: string): CompareSide {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(`${name} must be an object`);
  const o = value as Obj;
  onlyFields(o, ["part", "path", "at"]);
  const part = optString(o, "part");
  const path = optString(o, "path");
  const at = optString(o, "at");
  if ((part === undefined) === (path === undefined)) throw invalid(`${name} needs exactly one of part and path`);
  return { ...(part === undefined ? {} : { part }), ...(path === undefined ? {} : { path: normalizePath(path) }), ...(at === undefined ? {} : { at }) };
}

export function registerPartRoutes(r: Router, service: Service, deps: { json: Json; author: (req: Request) => string }): void {
  const { json, author } = deps;
  const parts = service.parts;
  const slug = (ctx: RouteContext): string => ctx.params.slug as string;
  const id = (ctx: RouteContext): string => ctx.params.id as string;
  const path = (ctx: RouteContext): string => normalizePath(ctx.rest);

  r.add("GET", "/library/profile", async () => json(await parts.profile()));
  r.add("GET", "/projects/:slug/overview", async (ctx) => json(await service.overview(slug(ctx))));

  r.add("GET", "/projects/:slug/parts", async (ctx) => json({ parts: await parts.list(slug(ctx)) }));
  r.add("PUT", "/projects/:slug/parts/:id", async (ctx) => json(await parts.put(slug(ctx), id(ctx), await readJsonBody(ctx.req), author(ctx.req))));
  r.add("DELETE", "/projects/:slug/parts/:id", async (ctx) => json(await parts.remove(slug(ctx), id(ctx), author(ctx.req))));
  r.add("GET", "/projects/:slug/parts/:id/report", async (ctx) => json(await parts.report(slug(ctx), id(ctx))));
  r.add("POST", "/projects/:slug/parts/:id/evaluate", async (ctx) => {
    const body = await readJsonBody(ctx.req, { optional: true });
    onlyFields(body, ["at", "params"]);
    const at = optString(body, "at");
    const params = optParams(body, "params");
    const evaluate: EvaluateBody = { ...(at === undefined ? {} : { at }), ...(params === undefined ? {} : { params }) };
    return json(await parts.evaluate(slug(ctx), id(ctx), evaluate));
  });
  r.add("POST", "/projects/:slug/parts/:id/params", async (ctx) => {
    const body = await readJsonBody(ctx.req);
    onlyFields(body, ["rev", "values", "message"]);
    const values = optParams(body, "values");
    if (values === undefined || Object.keys(values).length === 0) throw invalid("values must name at least one parameter");
    const message = optString(body, "message");
    return json(await parts.setParams(slug(ctx), id(ctx), { rev: reqString(body, "rev"), values, ...(message === undefined ? {} : { message }) }, author(ctx.req)));
  });
  r.add("POST", "/projects/:slug/parts/:id/waive", async (ctx) => {
    const body = await readJsonBody(ctx.req);
    onlyFields(body, ["gate", "reason"]);
    return json(await parts.waive(slug(ctx), id(ctx), { gate: reqString(body, "gate"), reason: reqString(body, "reason") }, author(ctx.req)));
  });
  r.add("POST", "/projects/:slug/parts/:id/prints", async (ctx) => {
    const body = await readJsonBody(ctx.req);
    onlyFields(body, ["outcome", "note", "revisionId"]);
    const outcome = body.outcome;
    if (outcome !== "ok" && outcome !== "issue") throw invalid("outcome must be ok or issue");
    const revisionId = optString(body, "revisionId");
    const print: PrintBody = { outcome, note: optString(body, "note") ?? "", ...(revisionId === undefined ? {} : { revisionId }) };
    return json(await parts.print(slug(ctx), id(ctx), print, author(ctx.req)));
  });
  r.add("GET", "/projects/:slug/parts/:id/attempts", async (ctx) => json({ attempts: await parts.attempts(slug(ctx), id(ctx)) }));
  r.add("POST", "/projects/:slug/parts/:id/restore", async (ctx) => {
    const body = await readJsonBody(ctx.req);
    onlyFields(body, ["revisionId"]);
    return json(await parts.restore(slug(ctx), id(ctx), reqString(body, "revisionId"), author(ctx.req)));
  });

  r.add("POST", "/projects/:slug/measure/*", async (ctx) => {
    const body = await readJsonBody(ctx.req, { optional: true });
    onlyFields(body, ["revision", "params"]);
    return json(await parts.measureFile(slug(ctx), path(ctx), optString(body, "revision"), optParams(body, "params")));
  });
  r.add("POST", "/projects/:slug/slice/*", async (ctx) => {
    const body = await readJsonBody(ctx.req);
    onlyFields(body, ["axis", "at", "revision"]);
    const revision = optString(body, "revision");
    return json(await parts.slice(slug(ctx), path(ctx), { axis: reqAxis(body, "axis"), at: reqNumber(body, "at"), ...(revision === undefined ? {} : { revision }) }));
  });
  r.add("POST", "/projects/:slug/probe/*", async (ctx) => {
    const body = await readJsonBody(ctx.req);
    onlyFields(body, ["from", "axis", "revision"]);
    const revision = optString(body, "revision");
    return json(await parts.probe(slug(ctx), path(ctx), { from: reqVec3(body, "from"), axis: reqAxis(body, "axis"), ...(revision === undefined ? {} : { revision }) }));
  });
  r.add("POST", "/projects/:slug/section/*", async (ctx) => {
    const body = await readJsonBody(ctx.req);
    onlyFields(body, ["axis", "at", "revision", "size"]);
    const revision = optString(body, "revision");
    const size = optInt(body, "size", 64, 4096);
    return json(await parts.section(slug(ctx), path(ctx), { axis: reqAxis(body, "axis"), at: reqNumber(body, "at"), ...(revision === undefined ? {} : { revision }), ...(size === undefined ? {} : { size }) }));
  });
  r.add("POST", "/projects/:slug/compare", async (ctx) => {
    const body = await readJsonBody(ctx.req);
    onlyFields(body, ["a", "b"]);
    return json(await parts.compare(slug(ctx), side(body.a, "a"), side(body.b, "b")));
  });

  r.add("GET", "/projects/:slug/assembly", async (ctx) => json(await parts.assemblyReport(slug(ctx))));
  r.add("PUT", "/projects/:slug/assembly", async (ctx) => json(await parts.putAssembly(slug(ctx), await readJsonBody(ctx.req), author(ctx.req))));
  r.add("POST", "/projects/:slug/assembly/evaluate", async (ctx) => json(await parts.assemblyReport(slug(ctx))));
}
