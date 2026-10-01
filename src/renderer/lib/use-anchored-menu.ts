import { useCallback, useEffect, useRef, useState } from "react";

export function useAnchoredMenu(keepOpenInsideTrigger = false) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const triggerContainerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  function openAt(anchorX: number, anchorY: number, alignRight = false): void {
    const width = Math.min(224, window.innerWidth - 24);
    const requestedLeft = alignRight ? anchorX - width : anchorX;
    setPosition({
      left: Math.max(12, Math.min(requestedLeft, window.innerWidth - width - 12)),
      top: Math.max(12, Math.min(anchorY, window.innerHeight - 208 - 12)),
    });
    setOpen(true);
  }

  function toggleFromTrigger(): void {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) openAt(rect.right, rect.bottom + 5, true);
    else setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (keepOpenInsideTrigger && triggerContainerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      requestAnimationFrame(() => triggerRef.current?.focus());
    };
    const closeOnViewportChange = (): void => setOpen(false);
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    requestAnimationFrame(() => {
      popoverRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']:not(:disabled)")?.focus();
    });
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [keepOpenInsideTrigger, open]);

  return {
    open,
    position,
    triggerRef,
    triggerContainerRef,
    popoverRef,
    openAt,
    toggleFromTrigger,
    close,
  };
}
