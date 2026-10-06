/** Release-owned API targets. Retain each target and its SDK while it is supported. */
export const COMPONENT_API_VERSION = "1.0.0";
export const SUPPORTED_COMPONENT_API_VERSIONS: readonly string[] = [COMPONENT_API_VERSION];

/** Used by both the production compiler and the declaration generator. */
export const REACT_RUNTIME_EXPORTS = [
  "createElement", "Fragment", "Children", "cloneElement", "createContext", "createRef",
  "forwardRef", "isValidElement", "lazy", "memo", "startTransition", "useCallback",
  "useContext", "useDebugValue", "useDeferredValue", "useEffect", "useId",
  "useImperativeHandle", "useInsertionEffect", "useLayoutEffect", "useMemo", "useReducer",
  "useRef", "useState", "useSyncExternalStore", "useTransition",
] as const;
export const COMPONENT_REACT_EXPORTS = [
  "createElement", "Fragment", "useCallback", "useContext", "useDebugValue", "useDeferredValue",
  "useEffect", "useId", "useImperativeHandle", "useInsertionEffect", "useLayoutEffect", "useMemo",
  "useReducer", "useRef", "useState", "useSyncExternalStore", "useTransition",
] as const;
export const COMPONENT_RUNTIME_EXPORTS = [
  "defineComponent", "useTheme", "useComponentVisibility", "trackActivity", "TerminalSurface",
  ...COMPONENT_REACT_EXPORTS,
] as const;

/** Discovery documents access without claiming component isolation or typed RPC errors. */
export const COMPONENT_CAPABILITIES = [
  { permission: "filesystem:read", methods: ["filesystem.readText"], access: "UTF-8 files within the owning project root; 1 MiB maximum. The filesystem object also exists with filesystem:write, but read calls still require filesystem:read." },
  { permission: "filesystem:write", methods: ["filesystem.writeText"], access: "Direct UTF-8 writes within the owning project root; 1 MiB maximum. Read access requires filesystem:read separately." },
  { permission: "network:http", methods: ["http.request"], access: "Absolute HTTP(S) URLs; default 10 s, maximum 30 s; request and response bodies bounded to 2 MiB. HTTP error statuses return payloads." },
  { permission: "process:execute", methods: ["shell.run", "processes.start", "processes.open", "processes.runQuickAction", "processes.write", "processes.resize", "processes.stop", "dashboard.setupWithAgent"], access: "Shell calls default to 10 s, maximum 30 s, 1 MiB per output stream; processes require declarative resources. Commands retain the user's OS access." },
  { permission: "process:observe", methods: ["processes.get"], access: "Read supervised process snapshots by node ID; also available with process:execute." },
  { permission: "webview:embed", methods: ["webview.render"], access: "Trusted host-owned webviews; embedded pages have no dashboard RPC bridge." },
] as const;
