import { Link } from "@tanstack/react-router";

export function AppLogo() {
  return (
    <Link to="/" className="flex shrink-0 items-center gap-2 font-semibold tracking-tight">
      <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={28} height={28} className="size-7" />
      drawer
    </Link>
  );
}
