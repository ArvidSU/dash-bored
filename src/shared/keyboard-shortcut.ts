const NAMED_KEYS = new Map<string, string>([
  [" ", "Space"],
  ["Spacebar", "Space"],
  ["Esc", "Escape"],
  ["Up", "ArrowUp"],
  ["Down", "ArrowDown"],
  ["Left", "ArrowLeft"],
  ["Right", "ArrowRight"],
  ["+", "Plus"],
]);

const ALLOWED_NAMED_KEYS = new Set([
  "Enter", "Escape", "Space", "Tab", "Backspace", "Delete", "Home", "End",
  "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Plus",
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
]);

function normalizedKey(value: string): string | null {
  const named = NAMED_KEYS.get(value) ?? value;
  if (named.length === 1 && named !== "+" && !/\s/.test(named)) return named.toLocaleUpperCase();
  return ALLOWED_NAMED_KEYS.has(named) ? named : null;
}

export function normalizeKeyboardShortcut(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parts = value.split("+").map((part) => part.trim()).filter(Boolean);
  const key = normalizedKey(parts.at(-1) ?? "");
  if (!key) return null;
  const modifiers = new Set(parts.slice(0, -1));
  if ([...modifiers].some((part) => !["Mod", "Alt", "Shift"].includes(part))) return null;
  return [
    ...(modifiers.has("Mod") ? ["Mod"] : []),
    ...(modifiers.has("Alt") ? ["Alt"] : []),
    ...(modifiers.has("Shift") ? ["Shift"] : []),
    key,
  ].join("+");
}

export function keyboardShortcutFromEvent(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): string | null {
  if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return null;
  const key = normalizedKey(event.key);
  if (!key) return null;
  return [
    ...(event.metaKey || event.ctrlKey ? ["Mod"] : []),
    ...(event.altKey ? ["Alt"] : []),
    ...(event.shiftKey ? ["Shift"] : []),
    key,
  ].join("+");
}

export function keyboardEventMatchesShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  shortcut: string | null | undefined,
): boolean {
  return shortcut !== null
    && shortcut !== undefined
    && keyboardShortcutFromEvent(event) === shortcut;
}

export function keyboardShortcutLabel(shortcut: string | null | undefined, mac = false): string {
  if (!shortcut) return "Not set";
  const parts = shortcut.split("+");
  if (!mac) return parts.map((part) => part === "Mod" ? "Ctrl" : part).join("+");
  return parts.map((part) => ({ Mod: "⌘", Alt: "⌥", Shift: "⇧", Enter: "↵", Space: "Space" })[part] ?? part).join("");
}

export function keyboardShortcutAccelerator(shortcut: string | null | undefined): string | undefined {
  if (!shortcut) return undefined;
  const acceleratorKeys: Record<string, string> = {
    Mod: "CommandOrControl",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
  };
  return shortcut.split("+").map((part) => acceleratorKeys[part] ?? part).join("+");
}
