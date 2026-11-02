import type { Database } from 'bun:sqlite';
import { RailError } from '@agent-rail/core';
import { all } from '@agent-rail/storage';
import { compareTaskIds } from './model.ts';

export type DependencyGraph = ReadonlyMap<string, readonly string[]>;

export function findCycle(graph: DependencyGraph): string[] | null {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const nodes = [...graph.keys()].sort();

  const visit = (node: string): string[] | null => {
    color.set(node, GREY);
    stack.push(node);
    for (const next of [...(graph.get(node) ?? [])].sort()) {
      const state = color.get(next) ?? WHITE;
      if (state === GREY) return [...stack.slice(stack.indexOf(next)), next];
      if (state === WHITE) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    color.set(node, BLACK);
    return null;
  };

  for (const node of nodes) {
    if ((color.get(node) ?? WHITE) !== WHITE) continue;
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return null;
}

export function topologicalOrder(graph: DependencyGraph, compare: (a: string, b: string) => number): string[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const [node, deps] of graph) {
    indegree.set(node, indegree.get(node) ?? 0);
    for (const dep of deps) {
      if (!graph.has(dep)) continue;
      indegree.set(node, (indegree.get(node) ?? 0) + 1);
      dependents.set(dep, [...(dependents.get(dep) ?? []), node]);
    }
  }
  const ready = [...indegree.entries()].filter(([, d]) => d === 0).map(([n]) => n);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort(compare);
    const node = ready.shift()!;
    order.push(node);
    for (const dependent of dependents.get(node) ?? []) {
      const left = indegree.get(dependent)! - 1;
      indegree.set(dependent, left);
      if (left === 0) ready.push(dependent);
    }
  }
  if (order.length !== graph.size) {
    throw new RailError('CYCLE_DETECTED', 'Dependency graph contains a cycle', {
      details: { cycle: findCycle(graph) },
    });
  }
  return order;
}

export function projectDependencyGraph(db: Database, projectId: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const { id } of all<{ id: string }>(db, 'SELECT id FROM tasks WHERE project_id = ?', projectId)) {
    graph.set(id, []);
  }
  const edges = all<{ task_id: string; depends_on_id: string }>(
    db,
    `SELECT d.task_id, d.depends_on_id FROM task_dependencies d JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ?`,
    projectId,
  );
  for (const edge of edges) graph.get(edge.task_id)?.push(edge.depends_on_id);
  return graph;
}

export function assertAcyclicWith(
  db: Database,
  projectId: string,
  taskId: string,
  dependencies: readonly string[],
): void {
  const graph = projectDependencyGraph(db, projectId);
  graph.set(taskId, [...dependencies]);
  const cycle = findCycle(graph);
  if (cycle) {
    throw new RailError('CYCLE_DETECTED', `Dependencies would create a cycle: ${cycle.join(' -> ')}`, {
      details: { cycle },
      suggestion: 'Remove one of the dependencies in the reported cycle.',
    });
  }
}

export function transitiveDependents(graph: DependencyGraph): Map<string, number> {
  const reverse = new Map<string, string[]>();
  for (const [node, deps] of graph) {
    for (const dep of deps) reverse.set(dep, [...(reverse.get(dep) ?? []), node]);
  }
  const counts = new Map<string, number>();
  for (const node of graph.keys()) {
    const seen = new Set<string>();
    const queue = [...(reverse.get(node) ?? [])];
    while (queue.length > 0) {
      const next = queue.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(reverse.get(next) ?? []));
    }
    counts.set(node, seen.size);
  }
  return counts;
}

export function sortTaskIds(ids: Iterable<string>): string[] {
  return [...ids].sort(compareTaskIds);
}
