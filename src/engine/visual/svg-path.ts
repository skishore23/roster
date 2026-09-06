export type SvgPathBounds = {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
};

type Point = { readonly x: number; readonly y: number };

const COMMANDS = new Set("MmZzLlHhVvCcSsQqTtAa".split(""));
const ARG_COUNTS: Readonly<Record<string, number>> = {
  M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0,
};
const TOKEN = /[A-Za-z]|[-+]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][-+]?\d+)?/g;
const TAU = Math.PI * 2;

const normalizeAngle = (angle: number): number => ((angle % TAU) + TAU) % TAU;

const vectorAngle = (ux: number, uy: number, vx: number, vy: number): number =>
  Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);

const pointOnArc = (
  center: Point,
  rx: number,
  ry: number,
  phi: number,
  theta: number,
): Point => ({
  x: center.x + rx * Math.cos(phi) * Math.cos(theta) - ry * Math.sin(phi) * Math.sin(theta),
  y: center.y + rx * Math.sin(phi) * Math.cos(theta) + ry * Math.cos(phi) * Math.sin(theta),
});

const angleOnArc = (theta: number, start: number, delta: number): boolean => {
  const epsilon = 1e-9;
  return delta >= 0
    ? normalizeAngle(theta - start) <= delta + epsilon
    : normalizeAngle(start - theta) <= -delta + epsilon;
};

const arcGeometry = (
  start: Point,
  end: Point,
  rawRx: number,
  rawRy: number,
  rotation: number,
  largeArc: number,
  sweep: number,
): { readonly center: Point; readonly rx: number; readonly ry: number; readonly phi: number; readonly startAngle: number; readonly deltaAngle: number } | undefined => {
  let rx = Math.abs(rawRx);
  let ry = Math.abs(rawRy);
  if (rx === 0 || ry === 0 || (start.x === end.x && start.y === end.y)) return undefined;
  const phi = rotation * Math.PI / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (start.x - end.x) / 2;
  const dy = (start.y - end.y) / 2;
  const xPrime = cosPhi * dx + sinPhi * dy;
  const yPrime = -sinPhi * dx + cosPhi * dy;
  const scale = xPrime ** 2 / rx ** 2 + yPrime ** 2 / ry ** 2;
  if (scale > 1) {
    const factor = Math.sqrt(scale);
    rx *= factor;
    ry *= factor;
  }
  const numerator = Math.max(0, rx ** 2 * ry ** 2 - rx ** 2 * yPrime ** 2 - ry ** 2 * xPrime ** 2);
  const denominator = rx ** 2 * yPrime ** 2 + ry ** 2 * xPrime ** 2;
  const coefficient = (largeArc === sweep ? -1 : 1) * Math.sqrt(denominator === 0 ? 0 : numerator / denominator);
  const centerPrimeX = coefficient * (rx * yPrime / ry);
  const centerPrimeY = coefficient * (-ry * xPrime / rx);
  const center = {
    x: cosPhi * centerPrimeX - sinPhi * centerPrimeY + (start.x + end.x) / 2,
    y: sinPhi * centerPrimeX + cosPhi * centerPrimeY + (start.y + end.y) / 2,
  };
  const startVector: readonly [number, number] = [
    (xPrime - centerPrimeX) / rx,
    (yPrime - centerPrimeY) / ry,
  ];
  const endVector: readonly [number, number] = [
    (-xPrime - centerPrimeX) / rx,
    (-yPrime - centerPrimeY) / ry,
  ];
  const startAngle = vectorAngle(1, 0, startVector[0], startVector[1]);
  let deltaAngle = vectorAngle(startVector[0], startVector[1], endVector[0], endVector[1]);
  if (!sweep && deltaAngle > 0) deltaAngle -= TAU;
  if (sweep && deltaAngle < 0) deltaAngle += TAU;
  return { center, rx, ry, phi, startAngle, deltaAngle };
};

/**
 * Parses the supported SVG path subset and returns conservative curve bounds.
 * Bézier control hulls bound curves exactly enough for region enforcement;
 * elliptical arcs include their true rotated extrema only when swept.
 */
export const canvasSvgPathBounds = (path: string): SvgPathBounds => {
  const tokens = path.match(TOKEN) ?? [];
  const remainder = path.replace(TOKEN, "").replace(/[\s,]+/g, "");
  if (!tokens.length || remainder) throw new Error("SVG path contains unsupported syntax");
  let index = 0;
  let command = "";
  let previousCommand = "";
  let current: Point = { x: 0, y: 0 };
  let subpathStart: Point = current;
  let lastCubicControl: Point | undefined;
  let lastQuadraticControl: Point | undefined;
  let hasMove = false;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  const add = (point: Point): void => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("SVG path contains a non-finite coordinate");
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  };
  const read = (count: number): number[] => {
    const values: number[] = [];
    for (let offset = 0; offset < count; offset += 1) {
      const token = tokens[index++];
      if (token === undefined || /^[A-Za-z]$/.test(token)) throw new Error(`SVG path ${command} has incomplete arguments`);
      const value = Number(token);
      if (!Number.isFinite(value) || Math.abs(value) > 100_000) throw new Error("SVG path number is outside the parser limit");
      values.push(value);
    }
    return values;
  };
  const point = (x: number, y: number, relative: boolean): Point => relative
    ? { x: current.x + x, y: current.y + y }
    : { x, y };

  while (index < tokens.length) {
    const next = tokens[index]!;
    if (/^[A-Za-z]$/.test(next)) {
      if (!COMMANDS.has(next)) throw new Error(`Unsupported SVG path command ${next}`);
      command = next;
      index += 1;
    } else if (!command) {
      throw new Error("SVG path must begin with a command");
    }
    const upper = command.toUpperCase();
    if (!hasMove && upper !== "M") throw new Error("SVG path must begin with M or m");
    if (upper === "Z") {
      current = subpathStart;
      add(current);
      previousCommand = upper;
      lastCubicControl = undefined;
      lastQuadraticControl = undefined;
      command = "";
      continue;
    }
    const count = ARG_COUNTS[upper];
    if (count === undefined) throw new Error(`Unsupported SVG path command ${command}`);
    const values = read(count);
    const relative = command === command.toLowerCase();
    const resetControls = (): void => {
      lastCubicControl = undefined;
      lastQuadraticControl = undefined;
    };

    switch (upper) {
      case "M": {
        current = point(values[0]!, values[1]!, relative);
        subpathStart = current;
        add(current);
        hasMove = true;
        command = relative ? "l" : "L";
        resetControls();
        break;
      }
      case "L": {
        current = point(values[0]!, values[1]!, relative);
        add(current);
        resetControls();
        break;
      }
      case "H": {
        current = { x: relative ? current.x + values[0]! : values[0]!, y: current.y };
        add(current);
        resetControls();
        break;
      }
      case "V": {
        current = { x: current.x, y: relative ? current.y + values[0]! : values[0]! };
        add(current);
        resetControls();
        break;
      }
      case "C": {
        const control1 = point(values[0]!, values[1]!, relative);
        const control2 = point(values[2]!, values[3]!, relative);
        const end = point(values[4]!, values[5]!, relative);
        add(control1); add(control2); add(end);
        current = end;
        lastCubicControl = control2;
        lastQuadraticControl = undefined;
        break;
      }
      case "S": {
        const control1 = previousCommand === "C" || previousCommand === "S"
          ? { x: current.x * 2 - (lastCubicControl?.x ?? current.x), y: current.y * 2 - (lastCubicControl?.y ?? current.y) }
          : current;
        const control2 = point(values[0]!, values[1]!, relative);
        const end = point(values[2]!, values[3]!, relative);
        add(control1); add(control2); add(end);
        current = end;
        lastCubicControl = control2;
        lastQuadraticControl = undefined;
        break;
      }
      case "Q": {
        const control = point(values[0]!, values[1]!, relative);
        const end = point(values[2]!, values[3]!, relative);
        add(control); add(end);
        current = end;
        lastQuadraticControl = control;
        lastCubicControl = undefined;
        break;
      }
      case "T": {
        const control = previousCommand === "Q" || previousCommand === "T"
          ? { x: current.x * 2 - (lastQuadraticControl?.x ?? current.x), y: current.y * 2 - (lastQuadraticControl?.y ?? current.y) }
          : current;
        const end = point(values[0]!, values[1]!, relative);
        add(control); add(end);
        current = end;
        lastQuadraticControl = control;
        lastCubicControl = undefined;
        break;
      }
      case "A": {
        const [rx, ry, rotation, largeArc, sweep, rawX, rawY] = values;
        if ((largeArc !== 0 && largeArc !== 1) || (sweep !== 0 && sweep !== 1)) {
          throw new Error("SVG arc flags must be 0 or 1");
        }
        const end = point(rawX!, rawY!, relative);
        const arc = arcGeometry(current, end, rx!, ry!, rotation!, largeArc!, sweep!);
        add(end);
        if (arc) {
          const xAngle = Math.atan2(-arc.ry * Math.sin(arc.phi), arc.rx * Math.cos(arc.phi));
          const yAngle = Math.atan2(arc.ry * Math.cos(arc.phi), arc.rx * Math.sin(arc.phi));
          for (const candidate of [xAngle, xAngle + Math.PI, yAngle, yAngle + Math.PI]) {
            if (angleOnArc(candidate, arc.startAngle, arc.deltaAngle)) {
              add(pointOnArc(arc.center, arc.rx, arc.ry, arc.phi, candidate));
            }
          }
        }
        current = end;
        resetControls();
        break;
      }
    }
    previousCommand = upper;
  }
  if (!hasMove || !Number.isFinite(minX)) throw new Error("SVG path has no drawable coordinates");
  return { minX, minY, maxX, maxY };
};
