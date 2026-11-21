import { LIBRARY_SLUG } from "@drawer/shared/api";
import { useNavigate } from "@tanstack/react-router";
import { useProjectNav } from "@/lib/nav";
import { partHome } from "./assembly-model";

/** Opens a part of the assembly: in this project, or in the library project for "_library/<id>". */
export function useOpenPart(slug: string) {
  const nav = useProjectNav(slug);
  const navigate = useNavigate();
  return (part: string) => {
    const home = partHome(part);
    if (home.library) void navigate({ to: "/p/$slug", params: { slug: LIBRARY_SLUG }, search: { part: home.id } });
    else nav.selectPart(home.id);
  };
}
