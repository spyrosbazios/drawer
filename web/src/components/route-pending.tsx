import { Skeleton } from "@/components/ui/skeleton";

/** Shown only when a navigation outlasts the router's pending delay: the shape of the app, not a spinner. */
export function RoutePending() {
  return (
    <div className="flex h-dvh flex-col" aria-busy="true">
      <div className="flex h-14 items-center gap-3 border-b border-line px-4">
        <Skeleton className="size-7 rounded-md" />
        <Skeleton className="h-5 w-24" />
        <Skeleton className="ml-auto h-8 w-40" />
      </div>
      <div className="grid flex-1 grid-cols-2 gap-4 p-4 md:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-44 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
