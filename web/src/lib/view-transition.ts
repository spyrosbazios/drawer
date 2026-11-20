import type { createRouter } from "@tanstack/react-router";

type ViewTransition = NonNullable<Parameters<typeof createRouter>[0]["defaultViewTransition"]>;

const supportsTypes = (): boolean =>
  typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("selector(:active-view-transition-type(route))");

/** A change of screen crossfades; search-param changes (selection, filters, panels) stay in place. */
export const viewTransition: ViewTransition = supportsTypes()
  ? { types: ({ fromLocation, toLocation }) => (fromLocation && fromLocation.pathname !== toLocation.pathname ? ["route"] : false) }
  : false;
