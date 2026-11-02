// Pure geometry helpers for the floating keyboard (no gi imports — unit-testable in node).

export const DEFAULT_WIDTH_FRACTION = 0.7;
export const MIN_WIDTH_FRACTION = 0.4;

/**
 * Clamp a rectangle into an area. Width/height are first limited to the area size,
 * then x/y are moved so the rectangle lies completely inside the area.
 *
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @param {{x:number,y:number,width:number,height:number}} area
 * @returns {{x:number,y:number,width:number,height:number}} new object (integers)
 */
export function clampRect(rect, area) {
    const width = Math.round(Math.max(0, Math.min(rect.width, area.width)));
    const height = Math.round(Math.max(0, Math.min(rect.height, area.height)));
    const x = Math.round(Math.min(Math.max(rect.x, area.x), area.x + area.width - width));
    const y = Math.round(Math.min(Math.max(rect.y, area.y), area.y + area.height - height));
    return {x, y, width, height};
}

/**
 * Allowed width range for the floating keyboard on a monitor/work area.
 *
 * @param {{width:number}} monitor
 * @param {{width:number}} area
 * @returns {[number, number]} [min, max]
 */
export function widthRange(monitor, area) {
    const max = Math.max(1, Math.min(monitor.width, area.width));
    const min = Math.min(max, Math.round(monitor.width * MIN_WIDTH_FRACTION));
    return [min, max];
}

/**
 * Clamp a width into the allowed range; -1 (or any value <= 0) selects the default (70 %).
 *
 * @param {number} width
 * @param {{width:number}} monitor
 * @param {{width:number}} area
 * @returns {number}
 */
export function resolveWidth(width, monitor, area) {
    const [min, max] = widthRange(monitor, area);
    const w = width > 0 ? width : Math.round(monitor.width * DEFAULT_WIDTH_FRACTION);
    return Math.round(Math.min(Math.max(w, min), max));
}

/**
 * Compute the floating geometry from stored settings values.
 * x === -1 → centred horizontally in the work area; y === -1 → bottom of the work area.
 *
 * @param {{x:number,y:number,width:number,height:number}} stored  height = current container height
 * @param {{x:number,y:number,width:number,height:number}} monitor
 * @param {{x:number,y:number,width:number,height:number}} area    work area of that monitor
 * @returns {{x:number,y:number,width:number,height:number}}
 */
export function resolveGeometry(stored, monitor, area) {
    const width = resolveWidth(stored.width, monitor, area);
    const height = Math.max(0, stored.height || 0);
    const x = stored.x === -1 ? area.x + Math.round((area.width - width) / 2) : stored.x;
    const y = stored.y === -1 ? area.y + area.height - Math.min(height, area.height) : stored.y;
    return clampRect({x, y, width, height}, area);
}

/**
 * New width while dragging the bottom-right resize grip. The keyboard keeps its aspect ratio
 * (height follows width), so the dominant drag direction (dx, or dy projected via aspect) wins.
 *
 * @param {number} startWidth
 * @param {number} startHeight
 * @param {number} dx
 * @param {number} dy
 * @returns {number} unclamped width
 */
export function resizeWidth(startWidth, startHeight, dx, dy) {
    const aspect = startWidth > 0 && startHeight > 0 ? startHeight / startWidth : 0;
    const fromY = aspect > 0 ? dy / aspect : 0;
    const delta = Math.abs(fromY) > Math.abs(dx) ? fromY : dx;
    return startWidth + delta;
}
