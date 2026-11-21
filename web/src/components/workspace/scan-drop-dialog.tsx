import { SCAN_UNITS, type ScanUnit } from "@drawer/shared/api";
import { ScanLineIcon, UploadIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface Props {
  file: File;
  onScan: (name: string, units?: ScanUnit) => Promise<void>;
  onReference: () => void;
  onCancel: () => void;
}

export function ScanDropDialog({ file, onScan, onReference, onCancel }: Props) {
  const [name, setName] = useState(
    () =>
      file.name
        .replace(/\.[^.]+$/, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 63) || "scan",
  );
  const [units, setUnits] = useState<ScanUnit>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const embeddedUnits = file.name.toLowerCase().endsWith(".3mf");

  async function submit() {
    setError(null);
    setPending(true);
    try {
      await onScan(name, units);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan upload failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Is this a scan?</DialogTitle>
          <DialogDescription>{file.name}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="scan-name">Scan name</Label>
            <Input id="scan-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={63} pattern="[a-z0-9][a-z0-9-]*" required disabled={pending} />
          </div>
          {embeddedUnits ? (
            <p className="text-sm text-dim">Uses the units stored in the 3MF.</p>
          ) : (
            <div className="grid gap-2">
              <Label htmlFor="scan-units">Original units</Label>
              <Select value={units} onValueChange={(value) => setUnits(SCAN_UNITS.find((unit) => unit === value))} disabled={pending}>
                <SelectTrigger id="scan-units">
                  <SelectValue placeholder="Choose units" />
                </SelectTrigger>
                <SelectContent>
                  {SCAN_UNITS.map((unit) => (
                    <SelectItem key={unit} value={unit}>
                      {unit}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onReference} disabled={pending}>
              <UploadIcon /> Upload as reference
            </Button>
            <Button type="submit" disabled={pending || !name || (!embeddedUnits && !units)}>
              <ScanLineIcon /> {pending ? "Processing scan…" : "Add scan"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
