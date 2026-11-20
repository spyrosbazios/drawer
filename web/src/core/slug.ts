export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

/** A readable explanation of why a slug is not acceptable, or null when it is. */
export function slugError(slug: string): string | null {
  if (slug === "") return "Give the project a name";
  if (!isValidSlug(slug)) return "Use lower-case letters, digits and dashes, starting with a letter or digit";
  return null;
}

/** Suggests a slug from a free-form name. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
