export const REPO = "https://github.com/spyrosbazios/drawer";
export const LICENSE = `${REPO}/blob/main/LICENSE`;

export const cn = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(" ");
