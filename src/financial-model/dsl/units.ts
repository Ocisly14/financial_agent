import type { Unit } from "../types.ts";

export type ArithOp = "+" | "-" | "*" | "/";
export type UnitTerm = { unit: Unit; literal?: number };

export function sameUnit(a: Unit, b: Unit): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "currency" && b.kind === "currency") return a.code === b.code;
  if (a.kind === "per_share" && b.kind === "per_share") return a.code === b.code;
  return true;
}

export function unitLabel(unit: Unit): string {
  return unit.kind === "currency" || unit.kind === "per_share"
    ? `${unit.kind}:${unit.code}`
    : unit.kind;
}

function isRate(unit: Unit): boolean {
  return unit.kind === "percent" || unit.kind === "ratio";
}

function isDimensionless(unit: Unit): boolean {
  return unit.kind === "number" || isRate(unit);
}

function isLiteral(term: UnitTerm, value: number): boolean {
  return term.unit.kind === "number" && term.literal === value;
}

export function compatibleUnit(a: Unit, b: Unit): boolean {
  return sameUnit(a, b) || (isDimensionless(a) && isDimensionless(b));
}

export function assignableTo(term: UnitTerm, target: Unit): boolean {
  return isLiteral(term, 0) || compatibleUnit(term.unit, target);
}

export function commonUnit(left: Unit, right: Unit): Unit | null {
  if (sameUnit(left, right)) return left;
  if (isDimensionless(left) && isDimensionless(right)) return { kind: "ratio" };
  return null;
}

/**
 * Returns the result unit for an explicitly supported arithmetic combination.
 * A null result means the operands are incompatible.
 */
export function combine(left: UnitTerm, op: ArithOp, right: UnitTerm): Unit | null {
  const leftUnit = left.unit;
  const rightUnit = right.unit;

  if (op === "+" || op === "-") {
    if (isLiteral(left, 0)) return rightUnit;
    if (isLiteral(right, 0)) return leftUnit;
    if (isLiteral(left, 1) && isRate(rightUnit)) return { kind: "ratio" };
    if (sameUnit(leftUnit, rightUnit)) return leftUnit;
    if (isRate(leftUnit) && isRate(rightUnit)) return { kind: "ratio" };
    return null;
  }

  if (op === "*") {
    if (leftUnit.kind === "currency" && isDimensionless(rightUnit)) return leftUnit;
    if (isDimensionless(leftUnit) && rightUnit.kind === "currency") return rightUnit;
    if (leftUnit.kind === "shares" && isDimensionless(rightUnit)) return leftUnit;
    if (leftUnit.kind === "per_share" && rightUnit.kind === "shares") {
      return { kind: "currency", code: leftUnit.code };
    }
    if (leftUnit.kind === "shares" && rightUnit.kind === "per_share") {
      return { kind: "currency", code: rightUnit.code };
    }
    if (isDimensionless(leftUnit) && isDimensionless(rightUnit)) {
      if (leftUnit.kind === "number") return rightUnit;
      if (rightUnit.kind === "number") return leftUnit;
      return { kind: "ratio" };
    }
    return null;
  }

  if (leftUnit.kind === "currency" && rightUnit.kind === "currency") {
    return leftUnit.code === rightUnit.code ? { kind: "ratio" } : null;
  }
  if (leftUnit.kind === "currency" && rightUnit.kind === "shares") {
    return { kind: "per_share", code: leftUnit.code };
  }
  if (leftUnit.kind === "currency" && isDimensionless(rightUnit)) return leftUnit;
  if (leftUnit.kind === "shares" && rightUnit.kind === "shares") return { kind: "ratio" };
  if (leftUnit.kind === "shares" && isDimensionless(rightUnit)) return leftUnit;
  if (leftUnit.kind === "number" && rightUnit.kind === "number") return { kind: "number" };
  if (isRate(leftUnit) && rightUnit.kind === "number") return leftUnit;
  if (isRate(leftUnit) && isRate(rightUnit)) return { kind: "ratio" };
  return null;
}
