import { Link, useRouter } from "@tanstack/react-router";
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NotFoundError } from "@/services/api";

export function ErrorView({ error, reset }: { error: unknown; reset?: () => void }) {
  const router = useRouter();
  const missing = error instanceof NotFoundError;
  const message = error instanceof Error ? error.message : "The page could not be loaded.";
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <TriangleAlertIcon className="size-8 text-warn" />
      <div>
        <h1 className="text-lg font-semibold">{missing ? "Not found" : "Something went wrong"}</h1>
        <p className="mt-1 max-w-md text-sm text-dim">{message}</p>
      </div>
      <div className="flex gap-2">
        {!missing && (
          <Button
            variant="outline"
            onClick={() => {
              reset?.();
              void router.invalidate();
            }}
          >
            <RefreshCwIcon /> Try again
          </Button>
        )}
        <Button asChild>
          <Link to="/">Back to projects</Link>
        </Button>
      </div>
    </div>
  );
}

export function NotFoundView() {
  return <ErrorView error={new NotFoundError("There is nothing at this address.")} />;
}
