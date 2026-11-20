import type { LibraryProfile } from "@drawer/shared/api";
import { libraryProfileSchema } from "@/core/schemas";
import { api, read } from "./api";

/** The printer and materials every gate reads (`_library/printer.json`, `materials.json`). */
export async function getLibraryProfile(): Promise<LibraryProfile> {
  const { data } = await api.get<unknown>("/library/profile");
  return read(libraryProfileSchema, data);
}
