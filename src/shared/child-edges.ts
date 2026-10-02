import type { ComponentChildEdge, ComponentChildLayout, ComponentChildren } from "./contracts";

/**
 * Every child edge of a node in document order, whether `children` is a
 * managed array or a tiled split layout. The single owner of this walk for
 * core and renderer; callers that need split paths or transforms keep their
 * own layout recursion.
 */
export function childEdges<Node>(children: ComponentChildren<Node> | undefined): ComponentChildEdge<Node>[] {
  if (children === undefined) return [];
  if (Array.isArray(children)) return children;
  const edges: ComponentChildEdge<Node>[] = [];
  const collect = (layout: ComponentChildLayout<Node>): void => {
    if ("node" in layout) edges.push(layout);
    else {
      collect(layout.first);
      collect(layout.second);
    }
  };
  collect(children);
  return edges;
}
