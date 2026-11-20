import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { TreeNode } from "./attempt-tree";

/** Asks before an old attempt becomes the current model (History → Make current). */
export function RestoreDialog({ node, onClose, onConfirm }: { node: TreeNode | null; onClose: () => void; onConfirm: (node: TreeNode) => void }) {
  return (
    <AlertDialog open={node !== null} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Make {node?.label} current?</AlertDialogTitle>
          <AlertDialogDescription>
            The model goes back to “{node?.attempt.message}”. Nothing is lost: the current attempt stays in the tree, and the agent&apos;s next change branches from {node?.label}.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => node && onConfirm(node)}>Make current</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
