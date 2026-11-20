import { joinPath } from "./paths";

/** Where a reference added to a new project lands: everything goes to `refs/`, where the agent measures it. */
export function newProjectUploadPath(filename: string): string {
  return joinPath("refs", filename);
}

/** Where a file uploaded into a folder lands. */
export function uploadPathIn(folder: string, filename: string): string {
  return joinPath(folder, filename);
}
