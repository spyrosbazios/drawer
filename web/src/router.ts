import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { SCROLL_KEY, SCROLL_TOP } from "@/lib/scroll";
import { parseSearch, stringifySearch } from "@/lib/route-search";
import { viewTransition } from "@/lib/view-transition";
import { RoutePending } from "@/components/route-pending";
import { isNotRetryable } from "@/services/api";
import { routeTree } from "./routeTree.gen";

export const queryClient = new QueryClient({
  defaultOptions: {
    // Realtime keeps data fresh; the window only stops back-to-back navigations from refetching.
    queries: { staleTime: 10_000, retry: (count, err) => count < 2 && !isNotRetryable(err) },
    mutations: { networkMode: "always" },
  },
});

export const router = createRouter({
  routeTree,
  context: { queryClient },
  parseSearch, // plain query strings (lib/route-search.ts)
  stringifySearch,
  defaultPreload: "intent", // hover / touchstart loads the chunk and runs the loader
  defaultPreloadStaleTime: 0, // the router caches nothing; TanStack Query's staleTime decides
  defaultPendingComponent: RoutePending, // shown only when a navigation outlasts defaultPendingMs
  defaultPendingMs: 400, // so a fast load never flashes
  defaultPendingMinMs: 300, // and once shown, long enough not to flicker
  defaultViewTransition: viewTransition,
  scrollRestoration: true, // scrollers restore per what they show (data-scroll-restoration-id)
  getScrollRestorationKey: () => SCROLL_KEY,
  scrollToTopSelectors: SCROLL_TOP,
  scrollRestorationBehavior: "instant",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
