import { LIBRARY_SLUG } from "@drawer/shared/api";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { getLibraryProfile } from "@/services/library";
import { useParts } from "./parts";

export const libraryKeys = {
  profile: () => ["library-profile"] as const,
};

export const libraryProfileQuery = () => queryOptions({ queryKey: libraryKeys.profile(), queryFn: getLibraryProfile, staleTime: 60_000 });

/** Printer and materials: what the gates read and what new parts pick a material from. */
export const useLibraryProfile = () => useQuery(libraryProfileQuery());

/** Shared parts of the library, mostly bought hardware. An assembly refers to them as `_library/<id>`. */
export const useLibraryParts = () => useParts(LIBRARY_SLUG);
