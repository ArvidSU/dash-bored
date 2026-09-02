import { describe, expect, test } from "bun:test";
import {
  keyboardEventMatchesShortcut,
  keyboardShortcutAccelerator,
  keyboardShortcutFromEvent,
  keyboardShortcutLabel,
  normalizeKeyboardShortcut,
} from "../../src/shared/keyboard-shortcut";

describe("keyboard shortcuts", () => {
  test("normalizes, labels, and converts portable shortcuts", () => {
    expect(normalizeKeyboardShortcut("Shift+Mod+k")).toBe("Mod+Shift+K");
    expect(normalizeKeyboardShortcut("Mod+," )).toBe("Mod+,");
    expect(keyboardShortcutLabel("Mod+Shift+K", true)).toBe("⌘⇧K");
    expect(keyboardShortcutLabel("Mod+Shift+K", false)).toBe("Ctrl+Shift+K");
    expect(keyboardShortcutAccelerator("Mod+Shift+K")).toBe("CommandOrControl+Shift+K");
  });

  test("captures and matches modifier and plain-key events exactly", () => {
    const event = { key: "k", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true };
    expect(keyboardShortcutFromEvent(event)).toBe("Mod+Shift+K");
    expect(keyboardEventMatchesShortcut(event, "Mod+Shift+K")).toBeTrue();
    expect(keyboardEventMatchesShortcut({ ...event, altKey: true }, "Mod+Shift+K")).toBeFalse();
    expect(keyboardShortcutFromEvent({ key: "Shift", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true })).toBeNull();
  });
});
