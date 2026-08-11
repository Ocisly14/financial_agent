import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyLevelRole,
  classifyMetricDirection,
  decodeMarkPayload,
  figureFreshness,
  parseAnswerSources,
  parseMarkDate,
  sourceSiteLabel,
  rewriteSemanticMarks,
  rewriteSourceList,
  markdownPreviewText,
} from "../semanticMarks.ts";

function payloads(rewritten: string, attribute = "t"): string[] {
  return [...rewritten.matchAll(new RegExp(`${attribute}="([^"]*)"`, "g"))]
    .map((match) => decodeMarkPayload(match[1]!));
}

test("lowers an inline mark onto a self-closing tag", () => {
  const rewritten = rewriteSemanticMarks("净利率回到 [[metric:23.4%|+2.4pp vs Q1]]。");
  assert.match(rewritten, /^净利率回到 <Mark k="metric" t="[^"]+" x="[^"]+" \/>。$/);
  assert.deepEqual(payloads(rewritten), ["23.4%"]);
  assert.deepEqual(payloads(rewritten, "x"), ["+2.4pp vs Q1"]);
});

test("keeps the extra slot optional", () => {
  const rewritten = rewriteSemanticMarks("阻力在 [[level:179.5]] 附近。");
  assert.match(rewritten, /<Mark k="level" t="[^"]+" \/>/);
  assert.doesNotMatch(rewritten, /x="/);
});

test("payload survives quotes, angle brackets and ampersands", () => {
  const rewritten = rewriteSemanticMarks(`[[unverified:a "b" <c> & d|口径 "存疑"]]`);
  assert.deepEqual(payloads(rewritten), ['a "b" <c> & d']);
  assert.deepEqual(payloads(rewritten, "x"), ['口径 "存疑"']);
  assert.ok(!rewritten.includes("<c>"), "angle brackets never reach the parser");
  assert.ok(!rewritten.includes('"b"'), "quotes never break out of the attribute");
});

test("unknown kinds degrade to their plain text", () => {
  assert.equal(rewriteSemanticMarks("看 [[highlight:这里]] 一眼"), "看 这里 一眼");
});

test("caps metric marks per paragraph and keeps later paragraphs intact", () => {
  const many = Array.from({ length: 8 }, (_, index) => `[[metric:${index}%]]`).join(" ");
  const rewritten = rewriteSemanticMarks(`${many}\n\n[[metric:9%]]`);
  const marks = rewritten.match(/<Mark k="metric"/g) ?? [];
  assert.equal(marks.length, 7, "6 in the first paragraph plus 1 in the second");
  assert.match(rewritten, /6% 7%/, "the over-budget marks became plain text");
});

test("wraps a block container into a card tag with its body encoded", () => {
  const rewritten = rewriteSemanticMarks(":::thesis\n估值已反映降息预期。\n:::");
  assert.match(rewritten, /<MarkBlock k="thesis" body="[^"]+" \/>/);
  assert.deepEqual(payloads(rewritten, "body"), ["估值已反映降息预期。"]);
});

test("block bodies keep their own inline marks", () => {
  const rewritten = rewriteSemanticMarks(":::risk\n跌破 [[level:177.5|支撑]] 则失效。\n:::");
  assert.match(decodeMarkPayload(/body="([^"]+)"/.exec(rewritten)![1]!), /<Mark k="level"/);
});

test("caps thesis at one and risk at three per answer", () => {
  const source = [
    ":::thesis\nA\n:::",
    ":::thesis\nB\n:::",
    ":::risk\nR1\n:::",
    ":::risk\nR2\n:::",
    ":::risk\nR3\n:::",
    ":::risk\nR4\n:::",
  ].join("\n\n");
  const rewritten = rewriteSemanticMarks(source);
  assert.equal((rewritten.match(/k="thesis"/g) ?? []).length, 1);
  assert.equal((rewritten.match(/k="risk"/g) ?? []).length, 3);
  assert.ok(rewritten.includes("B") && rewritten.includes("R4"), "over-budget bodies stay as text");
});

test("never rewrites inside fenced or inline code", () => {
  const source = "```md\n[[metric:1%]]\n:::risk\nx\n:::\n```\n\n行内 `[[metric:2%]]` 保留。";
  const rewritten = rewriteSemanticMarks(source);
  assert.ok(rewritten.includes("[[metric:1%]]"));
  assert.ok(rewritten.includes(":::risk"));
  assert.ok(rewritten.includes("`[[metric:2%]]`"));
  assert.doesNotMatch(rewritten, /<Mark/);
});

test("holds back a half-streamed inline mark", () => {
  assert.equal(rewriteSemanticMarks("现价 [[metric:21", { streaming: true }), "现价 ");
  assert.equal(rewriteSemanticMarks("现价 [[metric:21"), "现价 [[metric:21");
});

test("an unterminated container shows its text without the marker", () => {
  const rewritten = rewriteSemanticMarks(":::risk\n杠杆偏高", { streaming: true });
  assert.equal(rewritten.trim(), "杠杆偏高");
  assert.doesNotMatch(rewritten, /:::/);
});

test("an unmarked answer passes through unchanged", () => {
  const source = "## 结论\n\n价格在 **213.4** 附近，见 <StockChart symbol=\"AAPL\" />\n\n- 一\n- 二";
  assert.equal(rewriteSemanticMarks(source), source);
});

test("classifies metric direction from the comparison basis, not the colour", () => {
  assert.equal(classifyMetricDirection("23.4%", "+2.4pp vs Q1"), "up");
  assert.equal(classifyMetricDirection("23.4%", "-1.2pp vs Q1"), "down");
  assert.equal(classifyMetricDirection("1.42", "低于市场预期"), "down");
  assert.equal(classifyMetricDirection("EPS 2.10", "beat consensus 1.98"), "up");
  assert.equal(classifyMetricDirection("18.3x", "行业中位数附近"), "flat");
});

test("classifies level roles across both languages", () => {
  assert.equal(classifyLevelRole("支撑"), "support");
  assert.equal(classifyLevelRole("resistance"), "resistance");
  assert.equal(classifyLevelRole("止损"), "stop");
  assert.equal(classifyLevelRole("target price"), "target");
  assert.equal(classifyLevelRole(""), "level");
});

test("finds the role word wherever the model puts it", () => {
  // Shapes seen in real answers.
  assert.equal(classifyLevelRole("Deutsche Bank PT"), "target");
  assert.equal(classifyLevelRole("分析师目标价"), "target");
  assert.equal(classifyLevelRole("next resistance zone"), "resistance");
  assert.equal(classifyLevelRole("first key support"), "support");
  assert.equal(classifyLevelRole("suggested stop-loss"), "stop");
  assert.equal(classifyLevelRole("Deutsche Bank"), "level", "a bank name alone is not a role");
});

test("figure freshness stays silent inside the ten-minute window", () => {
  const now = new Date("2026-07-29T14:00:00-04:00").getTime();
  assert.equal(figureFreshness(now - 5 * 60_000, now).level, "fresh");
  assert.equal(figureFreshness(now - 40 * 60_000, now).level, "aging");
  assert.equal(figureFreshness(new Date("2026-07-28T14:00:00-04:00").getTime(), now).level, "stale");
  assert.equal(figureFreshness(null, now).level, "fresh");
});

test("reads a bare catalyst date as a local calendar date", () => {
  const parsed = parseMarkDate("2026-10-28")!;
  assert.equal(parsed.getFullYear(), 2026);
  assert.equal(parsed.getMonth(), 9);
  assert.equal(parsed.getDate(), 28, "must not slip a day west of Greenwich");
  assert.equal(parseMarkDate("2026-10-28T14:30:00-04:00")!.getUTCHours(), 18);
  assert.equal(parseMarkDate("下周"), null);
  assert.equal(parseMarkDate(""), null);
});

test("collapses the blank lines a card tag injects", () => {
  const rewritten = rewriteSemanticMarks("段落\n\n:::risk\nR\n:::\n\n尾段");
  assert.doesNotMatch(rewritten, /\n{3,}/);
});

// Trimmed from a real orchestrator answer (NVDA, 2026-07-30) so the shapes the
// model actually emits stay covered: parenthesised bases, currency in CJK,
// negative leading values, repeated levels.
const LIVE_ANSWER = `:::thesis
短期内面临技术面破位与情绪降温的双重压力。
:::

市场流传一个未经验证的传闻：[[unverified:可能为 OpenAI 数据中心提供 2500 亿美元资金担保|引发对"循环交易"的担忧]]。

:::risk
**循环交易担忧**：若 [[metric:$2500亿|OpenAI data center backstop]] 的传闻发酵，将打击高估值逻辑。
:::

当前报价 [[metric:189.46|-3.85% vs prev close 197.05]]，已跌破 [[metric:203.13|SMA(20)]] 与 [[metric:207.04|SMA(50)]]；[[metric:38.51|RSI(14), 30 = oversold]] 逼近超卖，MACD（[[metric:-1.67|MACD]]）死叉。

阻力 [[level:190.20|resistance]]，支撑 [[level:170.77|support]]；财报 [[catalyst:Q2 earnings report|2026-08-26]]。`;

test("a real answer leaves no unparsed mark syntax behind", () => {
  const rewritten = rewriteSemanticMarks(LIVE_ANSWER);
  // Card bodies travel URI-encoded, so decode them before counting the marks
  // they contain — a metric inside a risk card still has to be a metric.
  const flattened = rewritten + [...rewritten.matchAll(/body="([^"]+)"/g)]
    .map((match) => decodeMarkPayload(match[1]!))
    .join("\n");
  assert.doesNotMatch(flattened, /\[\[|\]\]/, "no inline syntax survives");
  assert.doesNotMatch(flattened, /^:::/m, "no container marker survives");
  assert.equal((flattened.match(/<Mark k="metric"/g) ?? []).length, 6);
  assert.equal((flattened.match(/<Mark k="level"/g) ?? []).length, 2);
  assert.equal((flattened.match(/<Mark k="catalyst"/g) ?? []).length, 1);
  assert.equal((flattened.match(/<Mark k="unverified"/g) ?? []).length, 1);
  assert.equal((rewritten.match(/<MarkBlock/g) ?? []).length, 2);
});

test("directions from the live answer's comparison bases", () => {
  assert.equal(classifyMetricDirection("189.46", "-3.85% vs prev close 197.05"), "down");
  assert.equal(classifyMetricDirection("-1.67", "MACD"), "down");
  assert.equal(classifyMetricDirection("38.51", "RSI(14), 30 = oversold"), "flat");
  assert.equal(classifyMetricDirection("$2500亿", "OpenAI data center backstop"), "flat");
});

test("binds a citation to the answer's own numbered Sources list", () => {
  const answer = `传闻见 [[cite:2500 亿担保|2]]。

**Sources**:
1. [Stock Market News for July 27](https://finance.yahoo.com/a)
2. [Nvidia Reportedly Moves to Backstop $250 Billion](https://finance.yahoo.com/technology/b)
3. [NVDA Moved Down by 3.46%](https://www.tradingkey.com/news/c)`;

  const rewritten = rewriteSemanticMarks(answer);
  assert.match(rewritten, /<Mark k="cite" t="[^"]+" x="2"/);

  const sources = parseAnswerSources(answer);
  assert.equal(sources.size, 3);
  assert.deepEqual(sources.get(2), {
    index: 2,
    title: "Nvidia Reportedly Moves to Backstop $250 Billion",
    url: "https://finance.yahoo.com/technology/b",
  });
  assert.equal(sourceSiteLabel(sources.get(3)!.url), "tradingkey.com");
});

test("a citation pointing at a missing source still degrades to readable text", () => {
  const sources = parseAnswerSources("没有来源列表的答案");
  assert.equal(sources.size, 0);
  assert.match(rewriteSemanticMarks("见 [[cite:某个说法|7]]"), /<Mark k="cite"/);
});

test("rewriteSourceList lowers a trailing Sources list onto one tag", () => {
  const rewritten = rewriteSourceList(
    "正文。\n\n**Sources**\n\n1. [Tesla Q2 earnings](https://reuters.com/a)\n2. [Musk pay package](https://wsj.com/b)\n",
  );
  const items = JSON.parse(payloads(rewritten, "items")[0]!);
  assert.equal(items.length, 2);
  assert.deepEqual(items[1], { index: 2, title: "Musk pay package", url: "https://wsj.com/b" });
  // The heading stays; only the list itself is replaced.
  assert.match(rewritten, /\*\*Sources\*\*/);
  assert.doesNotMatch(rewritten, /reuters\.com\/a\)/);
});

test("rewriteSourceList accepts markdown and Chinese headings", () => {
  for (const heading of ["## Sources", "### 来源", "参考资料：", "References"]) {
    const rewritten = rewriteSourceList(`${heading}\n1. [T](https://a.com/x)\n`);
    assert.match(rewritten, /<SourceList items=/, heading);
  }
});

test("rewriteSourceList leaves a numbered list that merely contains a link", () => {
  const source = "步骤：\n\n1. [打开页面](https://a.com/x) 然后确认\n2. 收工\n";
  assert.equal(rewriteSourceList(source), source);
});

test("rewriteSourceList leaves a Sources heading with no list under it", () => {
  const source = "**Sources**\n\n本轮未使用外部来源。\n";
  assert.equal(rewriteSourceList(source), source);
});

test("rewriteSourceList is a no-op while streaming", () => {
  const source = "**Sources**\n\n1. [T](https://a.com/x)\n";
  assert.equal(rewriteSourceList(source, { streaming: true }), source);
});

test("rewriteSourceList indexes survive out-of-order or gapped numbering", () => {
  const rewritten = rewriteSourceList("**Sources**\n\n2. [B](https://b.com/1)\n5. [E](https://e.com/1)\n");
  const items = JSON.parse(payloads(rewritten, "items")[0]!);
  assert.deepEqual(items.map((item: { index: number }) => item.index), [2, 5]);
});

test("markdownPreviewText strips the syntax sidebar previews used to leak", () => {
  const source = ":::thesis\nTesla (TSLA) 当前 [[metric:307.51|+3.18%]] 见 **支撑**\n:::";
  assert.equal(markdownPreviewText(source), "Tesla (TSLA) 当前 307.51 见 支撑");
});

test("markdownPreviewText drops tags, links and images", () => {
  assert.equal(
    markdownPreviewText('看图 <StockChart symbol="AAPL" /> 和 [来源](https://a.com) 与 ![](https://i/x.png)'),
    "看图 和 来源 与",
  );
});
