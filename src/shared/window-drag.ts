/** CSS viewport coordinates, projected onto the native window's content view. */
export interface WindowDragRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowDragRegions {
  width: number;
  height: number;
  drag: WindowDragRect[];
  exclude: WindowDragRect[];
}

export function validWindowDragRegions(value: WindowDragRegions): boolean {
  const positive = (number: number) => Number.isFinite(number) && number > 0;
  return !!value && positive(value.width) && positive(value.height)
    && Array.isArray(value.drag) && Array.isArray(value.exclude)
    && value.drag.length <= 8 && value.exclude.length <= 512
    && [...value.drag, ...value.exclude].every((rect) => !!rect
      && Number.isFinite(rect.x) && Number.isFinite(rect.y)
      && positive(rect.width) && positive(rect.height));
}
