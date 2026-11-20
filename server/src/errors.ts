import type { ApiError, ErrorCode } from "@drawer/shared/api";

const STATUS: Record<ErrorCode, number> = {
  not_found: 404,
  conflict: 409,
  exists: 409,
  invalid: 400,
  edit_no_match: 422,
  render_failed: 422,
  import_failed: 502,
  forbidden: 403,
  internal: 500,
};

/** An error that maps one-to-one onto an ApiError response. */
export class ApiException extends Error {
  override name = "ApiException";
  readonly code: ErrorCode;
  readonly rev: string | undefined;

  constructor(code: ErrorCode, message: string, rev?: string) {
    super(message);
    this.code = code;
    this.rev = rev;
  }

  get status(): number {
    return STATUS[this.code];
  }

  toBody(): ApiError {
    return this.rev === undefined
      ? { error: this.code, message: this.message }
      : { error: this.code, message: this.message, rev: this.rev };
  }
}

export const notFound = (message: string): ApiException => new ApiException("not_found", message);
export const invalid = (message: string): ApiException => new ApiException("invalid", message);
export const exists = (message: string): ApiException => new ApiException("exists", message);
export const conflict = (message: string, rev: string): ApiException => new ApiException("conflict", message, rev);
export const forbidden = (message: string): ApiException => new ApiException("forbidden", message);
