import type {
  ComponentChildEdge,
  ComponentChildLayout,
  ComponentChildren,
  ComponentManifest,
  ComponentNode,
  Diagnostic,
  ResolvedComponentNode,
} from "../shared/contracts";
import {
  parseActionReferenceNodeId,
  parseComponentActionReference,
  parseSelectionActionReference,
  REVEAL_ACTION_ARGS_SCHEMA,
} from "../shared/action-reference";
import { actionInvocation } from "../shared/action-invocation";
import { validateActionArgumentTemplates, validateActionArguments } from "./action-arguments";
import { isLegacyActionTarget } from "../migrations/action-references";
import { diagnostic, errorMessage } from "./diagnostics";
import { resolveContainedPath } from "./paths";
import { validatePromptInvocation, type PromptTemplate } from "./prompt-templates";
import { validatePropsSchema } from "./yaml";
import { referenceLocations, type ReferenceLocation } from "./tree-links";

/**
 * Tree validation. Every check reads a resolved or configured node and returns
 * diagnostics; none of them changes props or the tree.
 */

const AGENT_PROMPT_ARGS_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    // The editable input the composer opens with.
    prompt: { type: "string", minLength: 1, maxLength: 12000 },
    template: { type: "string", pattern: "^(?:dash-bored/)?[a-z0-9][a-z0-9-]{0,63}$" },
    vars: {
      type: "object",
      maxProperties: 32,
      propertyNames: { pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" },
      additionalProperties: { type: ["string", "number", "boolean"] },
    },
  },
};

export function childPath(parent: string, index: number): string {
  return `${parent}.children.${index}`;
}

/** Per-node checks that need only the node's manifest and configured content. */
export function validateNode(
  manifest: ComponentManifest,
  node: ComponentNode,
  props: Record<string, unknown>,
  edges: readonly ComponentChildEdge[],
  nodePath: string,
): Diagnostic[] {
  return [
    ...validateResourceProviderId(manifest, node.id, nodePath),
    ...validateComponentProps(manifest, props, nodePath),
    ...validateProcessResource(manifest, props, nodePath),
    ...validateChildren(manifest, props, node.children, edges, nodePath),
  ];
}

function validateResourceProviderId(manifest: ComponentManifest, id: string | undefined, nodePath: string): Diagnostic[] {
  if (!manifest.resources || Object.keys(manifest.resources).length === 0 || id !== undefined) return [];
  return [diagnostic({
    code: "NODE_ID_REQUIRED",
    message: `${manifest.name} provides app-owned resources and requires an explicit id so they remain stable across reloads.`,
    path: nodePath,
  })];
}

function validateComponentProps(manifest: ComponentManifest, props: Record<string, unknown>, nodePath: string): Diagnostic[] {
  return validatePropsSchema(manifest.propsSchema, props).map((error) => diagnostic({
    code: "COMPONENT_PROPS_INVALID",
    message: error.message ?? "Invalid component props.",
    path: `${nodePath}.props${error.instancePath.replaceAll("/", ".")}`,
  }));
}

function validateProcessResource(manifest: ComponentManifest, props: Record<string, unknown>, nodePath: string): Diagnostic[] {
  const processResource = manifest.resources?.process;
  if (!processResource) return [];
  const diagnostics: Diagnostic[] = [];
  const command = props[processResource.commandProp];
  if (typeof command !== "string" || command.trim() === "") {
    diagnostics.push(diagnostic({
      code: "COMPONENT_PROCESS_COMMAND_INVALID",
      message: `${manifest.name}'s ${processResource.commandProp} prop must contain a command.`,
      path: `${nodePath}.props.${processResource.commandProp}`,
    }));
  }
  if (processResource.cwdProp) {
    const cwd = props[processResource.cwdProp];
    if (cwd !== undefined && (typeof cwd !== "string" || cwd.trim() === "")) {
      diagnostics.push(diagnostic({
        code: "COMPONENT_PROCESS_CWD_INVALID",
        message: `${manifest.name}'s ${processResource.cwdProp} prop must be a non-empty directory path.`,
        path: `${nodePath}.props.${processResource.cwdProp}`,
      }));
    }
  }
  if (processResource.envProp) {
    const env = props[processResource.envProp];
    if (
      env !== undefined
      && (
        typeof env !== "object"
        || env === null
        || Array.isArray(env)
        || Object.values(env).some((value) => typeof value !== "string")
      )
    ) {
      diagnostics.push(diagnostic({
        code: "COMPONENT_PROCESS_ENV_INVALID",
        message: `${manifest.name}'s ${processResource.envProp} prop must contain string-valued environment variables.`,
        path: `${nodePath}.props.${processResource.envProp}`,
      }));
    }
  }
  return diagnostics;
}

function validateChildren(
  manifest: ComponentManifest,
  props: Record<string, unknown>,
  children: ComponentChildren | undefined,
  edges: readonly ComponentChildEdge[],
  nodePath: string,
): Diagnostic[] {
  const definition = manifest.children;
  const childrenPath = `${nodePath}.children`;
  const diagnostics: Diagnostic[] = [];
  if (definition?.select !== undefined && definition.presentation.type !== "managed") {
    diagnostics.push(diagnostic({
      code: "COMPONENT_SELECTION_PRESENTATION_INVALID",
      message: `${manifest.name} can select children only with managed presentation.`,
      path: childrenPath,
    }));
  }
  if (typeof props.defaultChild === "string" && definition?.select === "single"
    && !edges.some((edge) => edge.node.id === props.defaultChild)) {
    diagnostics.push(diagnostic({
      code: "COMPONENT_DEFAULT_CHILD_MISSING",
      message: `${manifest.name} defaultChild ${props.defaultChild} is not a direct child node ID.`,
      path: `${nodePath}.props.defaultChild`,
    }));
  }
  if (definition === undefined && children !== undefined) {
    diagnostics.push(diagnostic({
      code: "COMPONENT_CHILDREN_UNSUPPORTED",
      message: `${manifest.name} does not accept children.`,
      path: childrenPath,
    }));
  }
  if (
    definition !== undefined &&
    children !== undefined &&
    (definition.presentation.type === "managed") !== Array.isArray(children)
  ) {
    diagnostics.push(diagnostic({
      code: "COMPONENT_CHILD_PRESENTATION_INVALID",
      message: `${manifest.name} requires ${definition.presentation.type} children.`,
      path: childrenPath,
    }));
  }
  if (definition !== undefined && edges.length < definition.min) {
    diagnostics.push(diagnostic({
      code: "COMPONENT_CHILD_CARDINALITY",
      message: `${manifest.name} requires at least ${definition.min} child${definition.min === 1 ? "" : "ren"}.`,
      path: childrenPath,
    }));
  }
  if (definition?.max !== undefined && edges.length > definition.max) {
    diagnostics.push(diagnostic({
      code: "COMPONENT_CHILD_CARDINALITY",
      message: `${manifest.name} accepts at most ${definition.max} child${definition.max === 1 ? "" : "ren"}.`,
      path: childrenPath,
    }));
  }
  if (children !== undefined && !Array.isArray(children)) {
    diagnostics.push(...validateLayout(manifest, children, childrenPath));
  }
  diagnostics.push(...validateChildMetadata(manifest, edges, nodePath));
  return diagnostics;
}

function validateLayout(manifest: ComponentManifest, layout: ComponentChildLayout, layoutPath: string): Diagnostic[] {
  if ("node" in layout) return [];
  const presentation = manifest.children?.presentation;
  const diagnostics: Diagnostic[] = [];
  if (
    layout.axis === "vertical" && "ratio" in layout ||
    layout.axis === "horizontal" && layout.ratio !== undefined &&
    (!Number.isFinite(layout.ratio) || layout.ratio < 0.1 || layout.ratio > 0.9)
  ) {
    diagnostics.push(diagnostic({
      code: "COMPONENT_CHILD_RATIO_INVALID",
      message: layout.axis === "vertical"
        ? "Vertical splits use document flow and cannot declare a ratio."
        : "Horizontal split ratios must be between 0.1 and 0.9.",
      path: `${layoutPath}.ratio`,
    }));
  }
  if (presentation?.type === "tiled" && presentation.axes !== "both" && layout.axis !== presentation.axes) {
    diagnostics.push(diagnostic({
      code: "COMPONENT_CHILD_AXIS_INVALID",
      message: `${manifest.name} only allows ${presentation.axes} tiled splits.`,
      path: `${layoutPath}.axis`,
    }));
  }
  return [
    ...diagnostics,
    ...validateLayout(manifest, layout.first, `${layoutPath}.first`),
    ...validateLayout(manifest, layout.second, `${layoutPath}.second`),
  ];
}

function validateChildMetadata(manifest: ComponentManifest, edges: readonly ComponentChildEdge[], nodePath: string): Diagnostic[] {
  const metadataSchema = manifest.children?.metadataSchema;
  return edges.flatMap((edge, index) => {
    const metadataPath = `${childPath(nodePath, index)}.metadata`;
    if (metadataSchema === undefined) {
      return edge.metadata === undefined ? [] : [diagnostic({
        code: "COMPONENT_CHILD_METADATA_UNSUPPORTED",
        message: `${manifest.name} does not declare child metadata.`,
        path: metadataPath,
      })];
    }
    return validatePropsSchema(metadataSchema, edge.metadata ?? {}).map((error) => diagnostic({
      code: "COMPONENT_CHILD_METADATA_INVALID",
      message: error.message ?? "Invalid child metadata.",
      path: `${metadataPath}${error.instancePath.replaceAll("/", ".")}`,
    }));
  });
}

/** What reference checks may consult about the resolved tree. */
export interface ReferenceIndex {
  nodesById: ReadonlyMap<string, ResolvedComponentNode>;
  explicitNodeIds: ReadonlySet<string>;
  resourceProviders: ReadonlyMap<string, ReadonlySet<string>>;
  /** The bundle's own prompt templates; linked bundles validate against theirs. */
  promptTemplates: ReadonlyMap<string, PromptTemplate>;
}

export function referenceIndex(
  nodes: readonly ResolvedComponentNode[],
  explicitNodeIds: ReadonlySet<string>,
  promptTemplates: ReadonlyMap<string, PromptTemplate>,
): ReferenceIndex {
  const nodesById = new Map<string, ResolvedComponentNode>();
  const resourceProviders = new Map<string, Set<string>>();
  for (const node of nodes) {
    // Duplicate IDs are reported during resolution; the first node wins here.
    if (!nodesById.has(node.id)) nodesById.set(node.id, node);
    for (const resource of Object.keys(node.manifest?.resources ?? {})) {
      const providers = resourceProviders.get(resource) ?? new Set<string>();
      providers.add(node.id);
      resourceProviders.set(resource, providers);
    }
  }
  return { nodesById, explicitNodeIds, resourceProviders, promptTemplates };
}

/** Check every manifest-declared action and resource reference in a node's props. */
export function validateNodeReferences(index: ReferenceIndex, node: ResolvedComponentNode): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const [propName, reference] of Object.entries(node.manifest?.references ?? {})) {
    const allowsItemTemplates = propName.includes(".*.");
    for (const location of referenceLocations(node.props, propName)) {
      const diagnosticPath = `${node.id}.props.${location.path}`;
      diagnostics.push(...(reference.resource === "action"
        ? validateActionReference(index, node, location.parent[location.key], diagnosticPath, allowsItemTemplates)
        : validateResourceReference(index, node, reference.resource, location, diagnosticPath)));
    }
  }
  return diagnostics;
}

function validateResourceReference(
  index: ReferenceIndex,
  node: ResolvedComponentNode,
  resource: string,
  { parent, key }: ReferenceLocation,
  diagnosticPath: string,
): Diagnostic[] {
  const rawReference = parent[key];
  if (typeof rawReference === "string" && index.resourceProviders.get(resource)?.has(rawReference)) return [];
  return [diagnostic({
    code: "COMPONENT_RESOURCE_REFERENCE_UNKNOWN",
    message: `${node.manifest?.name ?? node.component} references unknown ${resource} resource node: ${String(rawReference)}`,
    path: diagnosticPath,
  })];
}

function argumentsError(
  schema: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
  allowsItemTemplates: boolean,
): string | undefined {
  return allowsItemTemplates
    ? validateActionArgumentTemplates(schema, args)
    : validateActionArguments(schema, args);
}

function validateActionReference(
  index: ReferenceIndex,
  node: ResolvedComponentNode,
  rawReference: unknown,
  diagnosticPath: string,
  allowsItemTemplates: boolean,
): Diagnostic[] {
  const invocation = actionInvocation(rawReference);
  if (!invocation) {
    return [diagnostic({
      code: "COMPONENT_ACTION_REFERENCE_INVALID",
      message: `${node.manifest?.name ?? node.component} action reference must be a string or an object with run and with fields.`,
      path: diagnosticPath,
    })];
  }
  const targetId = invocation.run;
  if (allowsItemTemplates && targetId.includes("${item.")) {
    return [diagnostic({
      code: "COMPONENT_ACTION_ARGUMENTS_INVALID",
      message: "Item templates are only allowed in action argument values, not in the action reference.",
      path: diagnosticPath,
    })];
  }
  if (targetId === "agent:prompt") {
    const error = argumentsError(AGENT_PROMPT_ARGS_SCHEMA, invocation.with, allowsItemTemplates)
      ?? validatePromptInvocation(index.promptTemplates, invocation.with);
    return error ? [diagnostic({
      code: "COMPONENT_ACTION_ARGUMENTS_INVALID",
      message: `agent:prompt arguments are invalid: ${error}`,
      path: `${diagnosticPath}.with`,
    })] : [];
  }
  const diagnostics: Diagnostic[] = [];
  const targetNodeId = parseActionReferenceNodeId(targetId);
  if (targetId.startsWith("reveal:") && Object.keys(invocation.with).length > 0) {
    const error = argumentsError(REVEAL_ACTION_ARGS_SCHEMA, invocation.with, allowsItemTemplates);
    if (error) diagnostics.push(diagnostic({
      code: "COMPONENT_ACTION_ARGUMENTS_INVALID",
      message: `reveal arguments are invalid: ${error}`,
      path: `${diagnosticPath}.with`,
    }));
  }
  const selectionTarget = parseSelectionActionReference(targetId);
  if (selectionTarget) {
    const container = index.nodesById.get(selectionTarget.containerId);
    const valid = container?.manifest?.children?.select === "single"
      && Array.isArray(container.children)
      && container.children.some((edge) => edge.node.id === selectionTarget.childId);
    if (!valid) diagnostics.push(diagnostic({
      code: "COMPONENT_ACTION_REFERENCE_UNKNOWN",
      message: `Selection action must target a selectable container and one of its child IDs: ${selectionTarget.containerId}/${selectionTarget.childId}`,
      path: diagnosticPath,
    }));
    return diagnostics;
  }
  // Positional targets are rewritten and reported by the legacy migration.
  if (isLegacyActionTarget(targetId)) return diagnostics;
  if (targetNodeId !== undefined && !index.explicitNodeIds.has(targetNodeId)) {
    diagnostics.push(diagnostic({
      code: "COMPONENT_ACTION_REFERENCE_UNKNOWN",
      message: `Action reference targets unknown node ID: ${targetNodeId}`,
      path: diagnosticPath,
    }));
  } else if (targetNodeId === undefined && targetId.startsWith("component:")) {
    diagnostics.push(diagnostic({
      code: "COMPONENT_ACTION_REFERENCE_INVALID",
      message: "Malformed component action reference; expected component:<node-id>:<action-id>.",
      path: diagnosticPath,
    }));
  } else if (targetNodeId === undefined && /^(focus|process|reveal|select):/.test(targetId)) {
    diagnostics.push(diagnostic({
      code: "COMPONENT_ACTION_REFERENCE_INVALID",
      message: "Malformed node action reference; expected focus:<node-id>, reveal:<node-id>, process:<node-id>, select:<container-id>/<child-id>, or component:<node-id>:<action-id>.",
      path: diagnosticPath,
    }));
  }
  const componentReference = parseComponentActionReference(targetId);
  if (componentReference && index.explicitNodeIds.has(targetNodeId ?? "")) {
    const target = index.nodesById.get(targetNodeId!);
    const definition = target?.manifest?.actions?.find((action) => action.id === componentReference.actionId);
    if (definition) {
      const error = argumentsError(definition.args, invocation.with, allowsItemTemplates);
      if (error) diagnostics.push(diagnostic({
        code: "COMPONENT_ACTION_ARGUMENTS_INVALID",
        message: `Arguments for ${definition.label} are invalid: ${error}`,
        path: `${diagnosticPath}.with`,
      }));
    }
  }
  return diagnostics;
}

/**
 * Resolve each process working directory below the project root. Filesystem
 * work is bounded to eight concurrent checks; diagnostics keep tree order.
 */
export async function validateProcessWorkingDirectories(
  projectRoot: string,
  nodes: readonly ResolvedComponentNode[],
): Promise<Map<ResolvedComponentNode, Diagnostic[]>> {
  const checks = nodes.flatMap((node) => {
    const propName = node.manifest?.resources?.process?.cwdProp;
    const cwd = propName === undefined ? undefined : node.props[propName];
    return typeof cwd === "string" && propName !== undefined ? [{ node, propName, cwd }] : [];
  });
  const results = new Map<ResolvedComponentNode, Diagnostic[]>();
  for (let offset = 0; offset < checks.length; offset += 8) {
    const batch = checks.slice(offset, offset + 8);
    const settled = await Promise.allSettled(
      batch.map(({ cwd }) => resolveContainedPath(projectRoot, cwd, { kind: "directory" })),
    );
    for (const [position, result] of settled.entries()) {
      const { node, propName } = batch[position]!;
      results.set(node, result.status === "rejected"
        ? [diagnostic({
            code: "COMPONENT_PROCESS_CWD_INVALID",
            message: errorMessage(result.reason),
            path: `${node.id}.props.${propName}`,
          })]
        : []);
    }
  }
  return results;
}

/** Check stable component action references only when the target opts into declarations. */
export function validateDeclaredComponentActionReferences(
  nodes: readonly ResolvedComponentNode[],
): Diagnostic[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const diagnostics: Diagnostic[] = [];
  for (const node of nodes) {
    for (const [propName, referenceDefinition] of Object.entries(node.manifest?.references ?? {})) {
      if (referenceDefinition.resource !== "action") continue;
      for (const { value, suffix } of referenceValues(node.props, propName)) {
        const invocation = actionInvocation(value);
        if (!invocation) continue;
        const target = parseComponentActionReference(invocation.run);
        if (!target) continue;
        const targetNode = nodesById.get(target.nodeId);
        const declaredActions = targetNode?.manifest?.actions;
        // Omission is the legacy dynamic-registration contract.
        if (declaredActions === undefined) continue;
        if (declaredActions.some((action) => action.id === target.actionId)) continue;
        diagnostics.push(diagnostic({
          code: "COMPONENT_ACTION_REFERENCE_UNKNOWN",
          message: `${targetNode?.manifest?.name ?? targetNode?.component ?? target.nodeId} does not declare action ${target.actionId}.`,
          path: `${node.id}.props.${suffix}`,
        }));
      }
    }
  }
  return diagnostics;
}

// Unlike referenceLocations, a trailing `*` yields the array items themselves.
function referenceValues(root: Record<string, unknown>, path: string): Array<{ value: unknown; suffix: string }> {
  const values: Array<{ value: unknown; suffix: string }> = [];
  const parts = path.split(".");
  const visit = (current: unknown, index: number, prefix: string[]): void => {
    if (index === parts.length) {
      values.push({ value: current, suffix: prefix.join(".") });
      return;
    }
    const part = parts[index]!;
    if (part === "*") {
      if (Array.isArray(current)) current.forEach((item, itemIndex) => visit(item, index + 1, [...prefix, String(itemIndex)]));
    } else if (current && typeof current === "object" && !Array.isArray(current)) {
      visit((current as Record<string, unknown>)[part], index + 1, [...prefix, part]);
    }
  };
  visit(root, 0, []);
  return values;
}
