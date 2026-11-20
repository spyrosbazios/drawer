import type { TreeEntry } from "@drawer/shared/api";
import { baseName } from "./paths";

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  entry: TreeEntry | null;
  children: TreeNode[];
}

/** Placeholder files that only keep an empty folder alive; they are never shown. */
const HIDDEN = new Set([".gitkeep"]);
const PINNED = "AGENTS.md";

function compare(a: TreeNode, b: TreeNode): number {
  if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
  return a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" });
}

function sortNodes(nodes: TreeNode[], root: boolean): void {
  nodes.sort(compare);
  if (root) {
    const i = nodes.findIndex((n) => n.type === "file" && n.name === PINNED);
    if (i > 0) nodes.unshift(...nodes.splice(i, 1));
  }
  for (const n of nodes) sortNodes(n.children, false);
}

/** Nests a flat entry list. Does not trust the server's order; `AGENTS.md` is pinned first at the root. */
export function buildTree(entries: readonly TreeEntry[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const dirs = new Map<string, TreeNode>();

  const ensureDir = (path: string): TreeNode => {
    const found = dirs.get(path);
    if (found) return found;
    const node: TreeNode = { name: baseName(path), path, type: "dir", entry: null, children: [] };
    dirs.set(path, node);
    const i = path.lastIndexOf("/");
    (i < 0 ? roots : ensureDir(path.slice(0, i)).children).push(node);
    return node;
  };

  for (const e of entries) {
    const name = baseName(e.path);
    if (e.type === "file" && HIDDEN.has(name)) {
      const i = e.path.lastIndexOf("/");
      if (i > 0) ensureDir(e.path.slice(0, i));
      continue;
    }
    if (e.type === "dir") {
      ensureDir(e.path).entry = e;
      continue;
    }
    const i = e.path.lastIndexOf("/");
    const node: TreeNode = { name, path: e.path, type: "file", entry: e, children: [] };
    (i < 0 ? roots : ensureDir(e.path.slice(0, i)).children).push(node);
  }
  sortNodes(roots, true);
  return roots;
}

export interface TreeRow {
  node: TreeNode;
  depth: number;
}

/** The rows to draw: a folder's children appear only while it is in `expanded`. */
export function visibleRows(nodes: readonly TreeNode[], expanded: ReadonlySet<string>, depth = 0): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.type === "dir" && expanded.has(node.path)) rows.push(...visibleRows(node.children, expanded, depth + 1));
  }
  return rows;
}

/** Every file entry under a node, depth-first. */
export function filesUnder(node: TreeNode): TreeEntry[] {
  if (node.type === "file") return node.entry ? [node.entry] : [];
  return node.children.flatMap(filesUnder);
}

/** Every folder node, depth-first. */
export function allDirs(nodes: readonly TreeNode[]): TreeNode[] {
  return nodes.flatMap((n) => (n.type === "dir" ? [n, ...allDirs(n.children)] : []));
}
