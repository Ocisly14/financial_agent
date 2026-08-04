/**
 * 把若干指标读数汇总成三个维度的描述性评分。
 *
 * 纯函数、无网络无 IO：模型不用心算，我们也能直接单测。输出的是维度打分和依据，
 * 不是买卖信号——这与 skill 正文的第三条硬约束一致。
 *
 * 作为 skill 脚本运行时：stdin 收 JSON ScoreInput，stdout 出 JSON ScoreResult。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

export type ScoreInput = {
  rsi?: number;
  macdHistogram?: number;
  price?: number;
  sma50?: number;
  sma200?: number;
  atrPercent?: number;
};

export type ScoreResult = {
  trend: number;
  momentum: number;
  volatility: "low" | "normal" | "high" | "unknown";
  evidence: string[];
};

function volatilityBand(atrPercent: number | undefined): ScoreResult["volatility"] {
  if (atrPercent === undefined) return "unknown";
  if (atrPercent < 1) return "low";
  if (atrPercent < 4) return "normal";
  return "high";
}

export function scoreIndicators(input: ScoreInput): ScoreResult {
  const evidence: string[] = [];
  let trend = 0;
  let momentum = 0;

  if (input.price !== undefined && input.sma50 !== undefined) {
    const above = input.price > input.sma50;
    trend += above ? 1 : -1;
    evidence.push(`price ${input.price} is ${above ? "above" : "below"} sma50 ${input.sma50}`);
  }
  if (input.price !== undefined && input.sma200 !== undefined) {
    const above = input.price > input.sma200;
    trend += above ? 1 : -1;
    evidence.push(`price ${input.price} is ${above ? "above" : "below"} sma200 ${input.sma200}`);
  }
  if (input.price === undefined || (input.sma50 === undefined && input.sma200 === undefined)) {
    evidence.push("no moving averages supplied; trend not scored");
  }

  if (input.rsi !== undefined) {
    if (input.rsi >= 70) momentum += 2;
    else if (input.rsi >= 55) momentum += 1;
    else if (input.rsi <= 30) momentum -= 2;
    else if (input.rsi <= 45) momentum -= 1;
    evidence.push(`rsi ${input.rsi}`);
  } else {
    evidence.push("no rsi supplied");
  }

  if (input.macdHistogram !== undefined) {
    // 柱状图只用来确认 RSI 给出的方向，不叠加成第二票——两者都源自价格动量。
    if (input.macdHistogram > 0 && momentum < 0) momentum += 1;
    if (input.macdHistogram < 0 && momentum > 0) momentum -= 1;
    evidence.push(`macd histogram ${input.macdHistogram}`);
  }

  const volatility = volatilityBand(input.atrPercent);
  if (volatility === "unknown") evidence.push("no atr supplied; volatility not banded");
  else evidence.push(`atr ${input.atrPercent}% of price`);

  const clamp = (value: number): number => Math.max(-2, Math.min(2, value));
  return { trend: clamp(trend), momentum: clamp(momentum), volatility, evidence };
}

// 作为脚本被 run_skill_script 调用时的入口。被单测 import 时这段不执行，
// 否则测试进程会挂在一个永远等不到 end 的 stdin 上。
//
// import.meta.url 是 Node 解析后的 realpath，而 process.argv[1] 只是词法上的
// path.resolve，两边任何一段路径祖先是符号链接（macOS /tmp、Docker 挂载、CI
// 工作区都常见）就会不相等，脚本静默地不挂 stdin 监听、不产出任何 stdout。
// 两边都 realpathSync 之后再比较，避免符号链接把这条门槛判假。
function isMainEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(path.resolve(process.argv[1]));
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  let raw = "";
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    const args = JSON.parse(raw || "{}") as ScoreInput;
    process.stdout.write(JSON.stringify(scoreIndicators(args)));
  });
}
