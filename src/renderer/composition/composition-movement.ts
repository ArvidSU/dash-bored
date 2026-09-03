import type {
  ComponentChildLayout,
  ComponentChildLocator,
  ComponentNode,
} from "../../shared/contracts";
import { childLocators } from "../lib/component-children";
import {
  nodeAtPath,
  type InsertionTarget,
  type NodePath,
} from "./dashboard-editor";

function sameLocator(left: ComponentChildLocator, right: ComponentChildLocator): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "managed" && right.type === "managed") return left.index === right.index;
  return left.type === "tiled"
    && right.type === "tiled"
    && left.path.length === right.path.length
    && left.path.every((segment, index) => segment === right.path[index]);
}

function axisAtLeaf(
  layout: ComponentChildLayout,
  path: readonly ("first" | "second")[],
): "horizontal" | "vertical" | null {
  if (layout.type === "child") return null;
  const [branch, ...rest] = path;
  if (!branch) return null;
  if (rest.length === 0) return layout.axis;
  return axisAtLeaf(layout[branch], rest);
}

/** Return the generic adjacent-sibling insertion target for keyboard moves. */
export function siblingMoveTarget(
  root: ComponentNode,
  source: NodePath,
  direction: "previous" | "next",
): InsertionTarget | null {
  const sourceLocator = source.at(-1);
  if (!sourceLocator) return null;
  const parentPath = source.slice(0, -1);
  const parent = nodeAtPath(root, parentPath);
  const siblings = childLocators(parent.children);
  const index = siblings.findIndex((locator) => sameLocator(locator, sourceLocator));
  if (index < 0) return null;
  const targetIndex = direction === "previous" ? index - 1 : index + 1;
  const targetLocator = siblings[targetIndex];
  if (!targetLocator) return null;

  if (sourceLocator.type === "managed" && targetLocator.type === "managed") {
    return {
      parentPath: [...parentPath],
      placement: {
        type: "managed",
        index: direction === "previous" ? targetLocator.index : targetLocator.index + 1,
      },
    };
  }
  if (sourceLocator.type !== "tiled" || targetLocator.type !== "tiled" || parent.children?.type !== "tiled") {
    return null;
  }
  const axis = axisAtLeaf(parent.children.layout, targetLocator.path);
  if (!axis) return null;
  return {
    parentPath: [...parentPath],
    placement: {
      type: "tiled",
      path: [...targetLocator.path],
      axis,
      position: direction === "previous" ? "first" : "second",
    },
  };
}
