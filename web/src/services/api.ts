import { HEADER_AUTHOR } from "@drawer/shared/api";
import type { ApiError, ErrorCode } from "@drawer/shared/api";
import axios, { AxiosError } from "axios";
import type { ZodType } from "zod";

/** The server's typed error. The UI branches on these classes, not on status codes. */
export class DrawerError extends Error {
  override name = "DrawerError";
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The file changed since it was read; `rev` is its current revision. */
export class ConflictError extends DrawerError {
  override name = "ConflictError";
  constructor(
    message: string,
    readonly rev: string | undefined,
  ) {
    super("conflict", message, 409);
  }
}

export class NotFoundError extends DrawerError {
  override name = "NotFoundError";
  constructor(message: string) {
    super("not_found", message, 404);
  }
}

export class InvalidError extends DrawerError {
  override name = "InvalidError";
  constructor(message: string) {
    super("invalid", message, 400);
  }
}

/** Only a person may do this (waiving a gate); the server refused it for this author. */
export class ForbiddenError extends DrawerError {
  override name = "ForbiddenError";
  constructor(message: string) {
    super("forbidden", message, 403);
  }
}

export class ExistsError extends DrawerError {
  override name = "ExistsError";
  constructor(message: string) {
    super("exists", message, 409);
  }
}

const CODES: readonly ErrorCode[] = ["not_found", "conflict", "exists", "invalid", "edit_no_match", "render_failed", "import_failed", "forbidden", "internal"];

function isApiError(data: unknown): data is ApiError {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return typeof d.message === "string" && typeof d.error === "string" && CODES.some((c) => c === d.error);
}

export function toDrawerError(err: unknown): Error {
  if (!(err instanceof AxiosError)) return err instanceof Error ? err : new Error(String(err));
  const status = err.response?.status ?? 0;
  const data: unknown = err.response?.data;
  if (isApiError(data)) {
    switch (data.error) {
      case "conflict":
        return new ConflictError(data.message, data.rev);
      case "not_found":
        return new NotFoundError(data.message);
      case "invalid":
        return new InvalidError(data.message);
      case "exists":
        return new ExistsError(data.message);
      case "forbidden":
        return new ForbiddenError(data.message);
      default:
        return new DrawerError(data.error, data.message, status);
    }
  }
  if (status === 404) return new NotFoundError("Not found");
  if (!err.response) return new DrawerError("internal", "Cannot reach the drawer server", 0);
  return new DrawerError("internal", `Unexpected response from the server (${status})`, status);
}

/** The only HTTP client. Everything is relative, so dev (proxy) and production (same origin) behave alike. */
export const api = axios.create({
  baseURL: "/api",
  timeout: 30_000,
  headers: { [HEADER_AUTHOR]: "web" },
});

api.interceptors.response.use(
  (r) => r,
  (err: unknown) => Promise.reject(toDrawerError(err)),
);

/** Runs a response through its schema; a malformed body is an error, never an `any`. */
export function read<T>(schema: ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new DrawerError("internal", "The server sent an unexpected response", 502);
  return parsed.data;
}

export function isNotRetryable(err: unknown): boolean {
  return err instanceof DrawerError && err.status >= 400 && err.status < 500;
}
