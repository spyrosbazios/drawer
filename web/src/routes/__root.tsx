import type { QueryClient } from "@tanstack/react-query";
import { Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import { useEffect } from "react";
import { ErrorView, NotFoundView } from "@/components/error-view";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootLayout,
  notFoundComponent: NotFoundView,
  errorComponent: ({ error, reset }) => <ErrorView error={error} reset={reset} />,
});

function RootLayout() {
  useEffect(() => {
    // The launch layer from index.html fades out once the first screen has rendered.
    const boot = document.getElementById("boot");
    if (!boot) return;
    boot.classList.add("done");
    const t = setTimeout(() => boot.remove(), 400);
    return () => clearTimeout(t);
  }, []);
  return (
    <div data-vt="page" className="h-dvh">
      <Outlet />
    </div>
  );
}
