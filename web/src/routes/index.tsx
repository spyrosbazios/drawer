import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "@/components/home/home-page";
import { homeLoader } from "@/lib/loaders";
import { validateHomeSearch } from "@/lib/route-search";

export const Route = createFileRoute("/")({
  validateSearch: validateHomeSearch,
  loader: ({ context }) => homeLoader(context.queryClient),
  component: HomePage,
});
