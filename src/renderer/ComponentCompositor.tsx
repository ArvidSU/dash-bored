import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type {
  ComponentChildHandle,
  ComponentChildLayout,
  ComponentRenderedChildren,
  ResolvedComponentNode,
} from "../shared/contracts";
import { layoutBranchKey, layoutStructureKey, type LayoutBranch } from "./component-children";
import { SplitLayout } from "./SplitLayout";
import {
  DEFAULT_SPLIT_MIN_PX,
  effectiveSplitRatio,
  normalizeSplitRatio,
  type SplitRatioOverrides,
} from "./split-layout";

export const ComponentVisibilityContext = createContext(true);

interface ComponentCompositorProps {
  node: ResolvedComponentNode;
  splitRatioOverrides: Readonly<SplitRatioOverrides>;
  onSplitRatioChange: (
    branchKey: string,
    defaultRatio: number,
    ratio: number | null,
    node: ResolvedComponentNode,
    splitPath: readonly LayoutBranch[],
  ) => void;
  renderNode: (node: ResolvedComponentNode) => ReactNode;
}

function childDisplayName(node: ResolvedComponentNode): string {
  const title = node.props.title ?? node.props.label ?? node.props.name;
  return typeof title === "string" && title.trim().length > 0
    ? title.trim()
    : node.manifest?.name ?? node.component;
}

function VisibleChild({
  node,
  visible,
  renderNode,
}: {
  node: ResolvedComponentNode;
  visible: boolean;
  renderNode: (node: ResolvedComponentNode) => ReactNode;
}): ReactNode {
  const parentVisible = useContext(ComponentVisibilityContext);
  return (
    <ComponentVisibilityContext.Provider value={parentVisible && visible}>
      {renderNode(node)}
    </ComponentVisibilityContext.Provider>
  );
}

export function composeComponentChildren({
  node,
  splitRatioOverrides,
  onSplitRatioChange,
  renderNode,
}: ComponentCompositorProps): ComponentRenderedChildren | undefined {
  const children = node.children;
  if (!children) return undefined;

  if (children.type === "managed") {
    const items: ComponentChildHandle[] = children.items.map((edge) => ({
      id: edge.node.id,
      reference: edge.node.component,
      displayName: childDisplayName(edge.node),
      metadata: edge.metadata ?? {},
      render: ({ visible = true } = {}) => (
        <VisibleChild
          key={edge.node.id}
          node={edge.node}
          visible={visible}
          renderNode={renderNode}
        />
      ),
    }));
    return { type: "managed", items };
  }

  const renderLayout = (
    layout: ComponentChildLayout<ResolvedComponentNode>,
    path: LayoutBranch[] = [],
  ): ReactNode => {
    if (layout.type === "child") {
      return <VisibleChild node={layout.child.node} visible renderNode={renderNode} />;
    }
    const branchKey = layoutBranchKey(node.id, path);
    const structureKey = layoutStructureKey(layout);
    const defaultRatio = normalizeSplitRatio(layout.ratio);
    const runtimeOverride = splitRatioOverrides[branchKey];
    return (
      <SplitLayout
        key={`${branchKey}:${structureKey}`}
        axis={layout.axis}
        first={renderLayout(layout.first, [...path, "first"])}
        second={renderLayout(layout.second, [...path, "second"])}
        ratio={effectiveSplitRatio(defaultRatio, runtimeOverride)}
        defaultRatio={defaultRatio}
        minFirstPx={DEFAULT_SPLIT_MIN_PX}
        minSecondPx={DEFAULT_SPLIT_MIN_PX}
        resizable={layout.axis === "horizontal"}
        label={`${childDisplayName(node)} ${path.length ? path.join(" ") : "root"} tiles`}
        onRatioChange={layout.axis === "horizontal"
          ? (ratio) => onSplitRatioChange(branchKey, defaultRatio, ratio, node, path)
          : undefined}
        onRatioReset={() => onSplitRatioChange(branchKey, defaultRatio, null, node, path)}
      />
    );
  };

  return { type: "tiled", surface: renderLayout(children.layout) };
}
