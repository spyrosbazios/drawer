import { createFileRoute } from "@tanstack/react-router";
import { ErrorView } from "@/components/error-view";
import { WorkspacePage } from "@/components/workspace/workspace-page";
import { projectLoader } from "@/lib/loaders";
import { validateProjectSearch } from "@/lib/route-search";

export const Route = createFileRoute("/p/$slug")({
  validateSearch: validateProjectSearch,
  loaderDeps: ({ search }) => ({ part: search.part, file: search.file, at: search.at }),
  loader: ({ context, params, deps }) => projectLoader(context.queryClient, params.slug, deps),
  component: WorkspacePage,
  errorComponent: ({ error, reset }) => <ErrorView error={error} reset={reset} />,
});
