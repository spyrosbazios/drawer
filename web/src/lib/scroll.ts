/** Scroll restoration ids: a scroller keeps its position per what it shows (see blueprint scroll-and-paging). */
export const SCROLL_KEY = "app";

const of = (...parts: (string | null | undefined)[]) => parts.map((p) => (p ?? "").replace(/["\\]/g, "")).join("|");

export const listScroll = (screen: string, filter?: string) => of("list", screen, filter);
export const detailScroll = (id: string) => of("detail", id);

export const SCROLL_TOP = ["list", "detail"].map((k) => `[data-scroll-restoration-id^="${k}|"]`);
