import type { Attempt } from "@drawer/shared/api";

/** One attempt placed on the strip: `col` grows with depth from the root, `lane` is the branch row. */
export interface TreeNode {
  attempt: Attempt;
  /** "r1", "r2", ... in date order: what a person reads instead of a revision id. */
  label: string;
  col: number;
  lane: number;
}

export interface TreeEdge {
  from: TreeNode;
  to: TreeNode;
}

export interface TreeLayout {
  nodes: TreeNode[];
  edges: TreeEdge[];
  cols: number;
  lanes: number;
}

/**
 * Lays the attempt tree out left to right. The first child (oldest) continues its parent's lane; every
 * other child opens a new lane under the lanes already used, so branches read as rows. An attempt whose
 * parent is not in the list is a root.
 */
export function layoutAttempts(attempts: readonly Attempt[]): TreeLayout {
  const byDate = [...attempts].sort((a, b) => a.date.localeCompare(b.date) || a.revisionId.localeCompare(b.revisionId));
  const labels = new Map(byDate.map((a, i) => [a.revisionId, `r${i + 1}`]));
  const known = new Set(byDate.map((a) => a.revisionId));
  const children = new Map<string | null, Attempt[]>();
  for (const a of byDate) {
    const parent = a.parent !== null && known.has(a.parent) ? a.parent : null;
    const list = children.get(parent) ?? [];
    list.push(a);
    children.set(parent, list);
  }

  const nodes: TreeNode[] = [];
  const edges: TreeEdge[] = [];
  let lanes = 0;
  let cols = 0;
  // Iterative depth-first walk: deep histories must not overflow the stack.
  const stack: { attempt: Attempt; col: number; lane: number; parent: TreeNode | null }[] = [];
  for (const root of [...(children.get(null) ?? [])].reverse()) stack.push({ attempt: root, col: 0, lane: -1, parent: null });
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) break;
    const lane = item.lane >= 0 ? item.lane : lanes++;
    const node: TreeNode = { attempt: item.attempt, label: labels.get(item.attempt.revisionId) ?? "", col: item.col, lane };
    nodes.push(node);
    cols = Math.max(cols, item.col + 1);
    if (item.parent) edges.push({ from: item.parent, to: node });
    const kids = children.get(item.attempt.revisionId) ?? [];
    const order: typeof stack = [];
    // Pushed in reverse so the first child is walked first and keeps the lane before siblings claim new ones.
    kids.forEach((kid, i) => order.push({ attempt: kid, col: item.col + 1, lane: i === 0 ? lane : -1, parent: node }));
    stack.push(...order.reverse());
  }
  return { nodes, edges, cols, lanes };
}
