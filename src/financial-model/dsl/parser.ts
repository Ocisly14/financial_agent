import { FinancialModelError } from "../errors.ts";
import type { ArithOp } from "./units.ts";

export type FnName =
  | "SUM" | "AVERAGE" | "LAG" | "YOY" | "CAGR"
  | "MIN" | "MAX" | "ABS" | "POW" | "YEAR_INDEX"
  | "DISCOUNT_FACTOR";

export type Ast =
  | { t: "num"; v: number }
  | { t: "ref"; id: string }
  | { t: "neg"; e: Ast }
  | { t: "bin"; op: ArithOp; l: Ast; r: Ast }
  | { t: "call"; fn: FnName; args: Ast[] };

export const FN_ARITY: Record<FnName, number | "variadic"> = {
  SUM: 3,
  AVERAGE: 3,
  LAG: 2,
  YOY: 1,
  CAGR: 2,
  MIN: "variadic",
  MAX: "variadic",
  ABS: 1,
  POW: 2,
  YEAR_INDEX: 0,
  DISCOUNT_FACTOR: 1,
};

/**
 * Argument positions that must be integer literals. Computed offsets would
 * make dependencies data-dependent and impossible to resolve before runtime.
 */
const INTEGER_LITERAL_ARGS: Partial<Record<FnName, number[]>> = {
  SUM: [1, 2],
  AVERAGE: [1, 2],
  LAG: [1],
  CAGR: [1],
};

export const MAX_LENGTH = 2000;
export const MAX_DEPTH = 32;
export const MAX_NODES = 400;

function fail(message: string): never {
  throw new FinancialModelError("invalid_formula", message);
}

type Token =
  | { k: "num"; v: number }
  | { k: "id"; v: string }
  | { k: "op"; v: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const ch = source[index]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      index += 1;
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      let end = index;
      while (end < source.length && /[0-9.]/.test(source[end]!)) end += 1;
      const text = source.slice(index, end);
      const value = Number(text);
      if (!Number.isFinite(value)) fail(`invalid number: ${text}`);
      tokens.push({ k: "num", v: value });
      index = end;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let end = index;
      while (end < source.length && /[A-Za-z0-9_.]/.test(source[end]!)) end += 1;
      tokens.push({ k: "id", v: source.slice(index, end) });
      index = end;
      continue;
    }
    if ("+-*/(),".includes(ch)) {
      tokens.push({ k: "op", v: ch });
      index += 1;
      continue;
    }
    fail(`unexpected character: ${ch}`);
  }

  return tokens;
}

/**
 * Parses the allowlisted formula grammar. Syntax that cannot be represented by
 * this AST is rejected before it reaches dependency analysis or evaluation.
 */
export function parseFormula(source: string): Ast {
  if (source.length > MAX_LENGTH) {
    fail(`formula too long: ${source.length} > ${MAX_LENGTH}`);
  }

  const tokens = tokenize(source);
  let position = 0;
  let nodes = 0;

  const peek = (): Token | undefined => tokens[position];
  const isOp = (value: string): boolean => {
    const token = peek();
    return token?.k === "op" && token.v === value;
  };
  const eat = (value: string): void => {
    if (!isOp(value)) fail(`unexpected token, expected '${value}'`);
    position += 1;
  };
  const count = (): void => {
    nodes += 1;
    if (nodes > MAX_NODES) fail(`formula too complex: over ${MAX_NODES} nodes`);
  };

  function expression(depth: number): Ast {
    if (depth > MAX_DEPTH) fail(`formula too deep: over ${MAX_DEPTH} levels`);
    return additive(depth);
  }

  function additive(depth: number): Ast {
    let left = multiplicative(depth);
    while (isOp("+") || isOp("-")) {
      const op = (peek() as { v: string }).v as ArithOp;
      position += 1;
      count();
      left = { t: "bin", op, l: left, r: multiplicative(depth + 1) };
    }
    return left;
  }

  function multiplicative(depth: number): Ast {
    let left = unary(depth);
    while (isOp("*") || isOp("/")) {
      const op = (peek() as { v: string }).v as ArithOp;
      position += 1;
      count();
      left = { t: "bin", op, l: left, r: unary(depth + 1) };
    }
    return left;
  }

  function unary(depth: number): Ast {
    if (isOp("-")) {
      position += 1;
      count();
      return { t: "neg", e: unary(depth + 1) };
    }
    return primary(depth);
  }

  function primary(depth: number): Ast {
    if (depth > MAX_DEPTH) fail(`formula too deep: over ${MAX_DEPTH} levels`);
    const token = peek();
    if (token === undefined) fail("unexpected end of formula");

    if (token.k === "op" && token.v === "(") {
      position += 1;
      const inner = expression(depth + 1);
      eat(")");
      return inner;
    }
    if (token.k === "num") {
      position += 1;
      count();
      return { t: "num", v: token.v };
    }
    if (token.k === "id") {
      position += 1;
      count();
      if (isOp("(")) return call(token.v, depth);
      return { t: "ref", id: token.v };
    }
    fail(`unexpected token: ${token.v}`);
  }

  function call(name: string, depth: number): Ast {
    if (!(name in FN_ARITY)) fail(`unknown function: ${name}`);
    const fn = name as FnName;
    eat("(");
    const args: Ast[] = [];
    if (!isOp(")")) {
      args.push(expression(depth + 1));
      while (isOp(",")) {
        position += 1;
        args.push(expression(depth + 1));
      }
    }
    eat(")");

    const arity = FN_ARITY[fn];
    if (arity === "variadic") {
      if (args.length === 0) fail(`${fn} expects at least 1 argument`);
    } else if (args.length !== arity) {
      fail(`${fn} expects ${arity} argument${arity === 1 ? "" : "s"}, received ${args.length}`);
    }

    for (const index of INTEGER_LITERAL_ARGS[fn] ?? []) {
      const arg = args[index];
      const literal = arg?.t === "num"
        ? arg.v
        : arg?.t === "neg" && arg.e.t === "num"
          ? -arg.e.v
          : undefined;
      if (literal === undefined || !Number.isInteger(literal)) {
        fail(`${fn} argument ${index + 1} must be an integer literal`);
      }
    }

    if (fn === "DISCOUNT_FACTOR" && args[0]?.t !== "ref") {
      fail("DISCOUNT_FACTOR requires a line-item reference");
    }

    return { t: "call", fn, args };
  }

  const ast = expression(0);
  if (position !== tokens.length) fail("unexpected trailing input");
  return ast;
}
