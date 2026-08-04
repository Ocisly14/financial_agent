/**
 * End-to-end verification for member-input passthrough (Research → member
 * Topic `ask_user`, per .superpowers/sdd/2026-08-04-member-input-passthrough).
 *
 * This does NOT start the server itself — it drives an already-running one
 * over HTTP, then reads the SQLite event log back to check the eight
 * assertions from task-5-brief.md. It never touches the real session DB:
 * point it at a scratch server, e.g.
 *
 *   SESSION_DB_PATH=/tmp/member-input-verify.sqlite SERVER_PORT=3999 \
 *     node --env-file=.env --experimental-strip-types --experimental-sqlite src/server.ts &
 *
 *   node --env-file=.env --experimental-strip-types --experimental-sqlite \
 *     scripts/verify/member-input-passthrough.ts
 *
 * Env overrides: SERVER_URL (default http://localhost:3999),
 * VERIFY_DB_PATH (default /tmp/member-input-verify.sqlite), AGENT_ID
 * (default "verify-member-input").
 *
 * Note on the brief's Step 2 ("造一个必然触发反问的场景"): the natural-language
 * ambiguity examples in the brief (e.g. "last quarter" without specifying
 * calendar vs. fiscal) are not guaranteed to make the model ask — a
 * sufficiently capable member Topic may simply pick an interpretation and
 * answer, which is itself correct behavior, not a passthrough bug. Rather
 * than loop retrying prompts until the model happens to ask (flaky, and not
 * actually testing the passthrough), this script drives the member with an
 * explicit instruction to call `ask_user` before doing anything else. That
 * still exercises the real path end to end (POST /api/chat → Research
 * controller → ask_topic → orchestrator.run → topic model calls ask_user →
 * member_input_request frame) — it only removes the model's discretion over
 * *whether* to ask, not any code path. If a caller wants to test organic
 * question-asking, set FORCE_ASK_USER=0 and supply MESSAGE; in that mode the
 * script reports whether a question was asked and skips assertions 1-2 and
 * 5-7 if not (per the brief: "that is a result, not an obstacle").
 *
 * Exits 0 when all judgeable assertions pass. Exits 1 on any hard failure.
 */

import { DatabaseSync } from "node:sqlite";

const SERVER_URL = process.env["SERVER_URL"] ?? "http://localhost:3999";
const DB_PATH = process.env["VERIFY_DB_PATH"] ?? "/tmp/member-input-verify.sqlite";
const AGENT_ID = process.env["AGENT_ID"] ?? "verify-member-input";
const FORCE_ASK_USER = (process.env["FORCE_ASK_USER"] ?? "1") !== "0";

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

function pass(msg: string): void {
  console.log(`${GREEN}PASS${RESET} ${msg}`);
}
function fail(msg: string): void {
  console.log(`${RED}FAIL${RESET} ${msg}`);
}
function skip(msg: string): void {
  console.log(`${YELLOW}SKIP${RESET} ${msg}`);
}

type EventRow = {
  sequence: number;
  session_id: string;
  turn: number;
  kind: string;
  payload_json: string;
};

type ChatFrame = { type: string; [key: string]: unknown };

/** POSTs /api/chat and returns every SSE frame the turn emitted, in order. */
async function postChat(body: Record<string, unknown>): Promise<ChatFrame[]> {
  const res = await fetch(`${SERVER_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-Id": AGENT_ID },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST /api/chat failed: ${res.status} ${await res.text()}`);
  if (!res.body) throw new Error("no response body from /api/chat");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: ChatFrame[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sepIndex: number;
    while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      if (!chunk.startsWith("data: ")) continue; // pings etc.
      frames.push(JSON.parse(chunk.slice("data: ".length)) as ChatFrame);
    }
  }
  return frames;
}

async function main(): Promise<void> {
  if (DB_PATH === "data/sessions.sqlite" || DB_PATH.endsWith("/data/sessions.sqlite")) {
    console.error(`${RED}Refusing to run against the real session DB (${DB_PATH}). Aborting.${RESET}`);
    process.exit(1);
  }

  console.log(`${BOLD}member-input-passthrough verification${RESET}`);
  console.log(`${DIM}server=${SERVER_URL} db=${DB_PATH} agent=${AGENT_ID} forceAskUser=${FORCE_ASK_USER}${RESET}\n`);

  // ── Step 1: a Topic + a Research containing it ───────────────────────────
  const topicRes = await fetch(`${SERVER_URL}/api/agents/${AGENT_ID}/topics`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "verify: member-input passthrough" }),
  });
  const topic = (await topicRes.json()) as { success: boolean; topic?: { id: string } };
  if (!topic.success || !topic.topic) throw new Error(`failed to create topic: ${JSON.stringify(topic)}`);
  const topicId = topic.topic.id;
  console.log(`Created Topic ${topicId}`);

  const researchRes = await fetch(`${SERVER_URL}/api/agents/${AGENT_ID}/researches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "verify: member-input passthrough", topicIds: [topicId] }),
  });
  const research = (await researchRes.json()) as { success: boolean; research?: { id: string } };
  if (!research.success || !research.research) throw new Error(`failed to create research: ${JSON.stringify(research)}`);
  const researchId = research.research.id;
  console.log(`Created Research ${researchId} (member: ${topicId})\n`);

  // ── Step 2: drive the member into asking a question ──────────────────────
  const message =
    process.env["MESSAGE"] ??
    (FORCE_ASK_USER
      ? `Ask the topic the following, verbatim, as its instruction: ` +
        `Before you answer anything else, you must first call your ask_user tool to ask me whether ` +
        `I mean the calendar quarter or the fiscal quarter, offering both as options. Do not attempt ` +
        `to infer or guess. Do not answer anything else until I respond to that question.`
      : `Ask the topic to compare its revenue growth to last quarter and tell me if it accelerated.`);

  const researchFrames = await postChat({ sessionId: researchId, message });
  console.log("First Research turn complete.\n");

  const memberInputFrame = researchFrames.find((f) => f.type === "member_input_request");
  const askedQuestion = !!memberInputFrame;

  if (!askedQuestion) {
    console.log(
      `${YELLOW}No member_input_request frame appeared — the member Topic did not ask a question this turn.${RESET}`,
    );
    console.log(`${DIM}This is a valid result per the brief, not necessarily a bug: it means the`);
    console.log(`member resolved the request on its own. Verbatim final frame:${RESET}`);
    console.log(JSON.stringify(researchFrames.find((f) => f.type === "final"), null, 2));
    console.log(`\nAssertions 1, 2, 5, 6, 7 cannot be judged without a question. Re-run with`);
    console.log(`FORCE_ASK_USER=1 (the default) to force one through the real ask_user path.\n`);
  }

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const eventsFor = (sessionId: string): EventRow[] =>
    db
      .prepare("SELECT sequence, session_id, turn, kind, payload_json FROM session_events WHERE session_id = ? ORDER BY sequence")
      .all(sessionId) as unknown as EventRow[];

  let hardFail = false;

  // Assertion 1: member_input_request frame, topicId = the driven member.
  const a1 = askedQuestion && (memberInputFrame!["topicId"] as string) === topicId;
  if (a1) pass(`1. member_input_request frame on the Research stream, topicId=${topicId}`);
  else if (askedQuestion) fail(`1. member_input_request frame's topicId did not match the driven member`);
  else skip(`1. no member_input_request frame emitted this run`);
  hardFail ||= askedQuestion && !a1;

  // Assertion 2: member session carries a user_input_required event, status pending.
  const memberEvents = eventsFor(topicId);
  const uirEvent = memberEvents.find((e) => e.kind === "user_input_required");
  let requestId: string | undefined;
  if (uirEvent) {
    const request = JSON.parse(uirEvent.payload_json).request as { request_id: string };
    requestId = request.request_id;
  }
  // status is derived (sessionState.ts userInputViewForEvent): pending until a
  // later user_message on that session answers or skips it. Re-derive here
  // rather than guessing a "status" column that doesn't exist on the raw row.
  function deriveStatus(events: EventRow[], uir: EventRow, reqId: string): "pending" | "answered" | "skipped" {
    const next = events.find((e) => e.kind === "user_message" && e.turn > uir.turn);
    if (!next) return "pending";
    const payload = JSON.parse(next.payload_json) as { response_to?: string; input_response?: unknown };
    if (payload.response_to === reqId && payload.input_response) return "answered";
    return "skipped";
  }
  const a2 = askedQuestion && !!uirEvent && !!requestId && deriveStatus(memberEvents, uirEvent, requestId) === "pending";
  if (a2) pass(`2. member session has user_input_required (request_id=${requestId}), status=pending`);
  else if (askedQuestion) fail(`2. member session missing a pending user_input_required event`);
  else skip(`2. no question was asked`);
  hardFail ||= askedQuestion && !a2;

  // Assertion 3: Research session has NO new user_input_required event.
  const researchEvents = eventsFor(researchId);
  const researchUir = researchEvents.filter((e) => e.kind === "user_input_required");
  const a3 = researchUir.length === 0;
  if (a3) pass(`3. Research session carries zero user_input_required events`);
  else fail(`3. Research session carries ${researchUir.length} user_input_required event(s) — the question moved`);
  hardFail ||= !a3;

  // Assertion 4: the Research turn ended normally (final + done), not a hang.
  const gotFinal = researchFrames.some((f) => f.type === "final");
  const gotDone = researchFrames.some((f) => f.type === "done");
  const a4 = gotFinal && gotDone;
  if (a4) pass(`4. Research turn ended with final + done (no hang)`);
  else fail(`4. Research turn did not end normally (final=${gotFinal} done=${gotDone})`);
  hardFail ||= !a4;

  // Assertion 5: Research's tool_result for this member says it's waiting on the user.
  const askTopicResults = researchEvents.filter((e) => e.kind === "tool_result" && JSON.parse(e.payload_json).name === "ask_topic");
  const waitingResult = askTopicResults.find((e) => {
    const payload = JSON.parse(e.payload_json) as { data?: { topicId?: string; status?: string }; summary?: string };
    return payload.data?.topicId === topicId && payload.data?.status === "needs_input";
  });
  const a5 = askedQuestion && !!waitingResult && /waiting on the user/i.test(String(JSON.parse(waitingResult?.payload_json ?? "{}").summary ?? ""));
  if (a5) pass(`5. Research's ask_topic tool_result for ${topicId} reports it is waiting on the user`);
  else if (askedQuestion) fail(`5. no matching tool_result found, or it doesn't mention waiting on the user`);
  else skip(`5. no question was asked`);
  hardFail ||= askedQuestion && !a5;

  // ── Step 4: answer the question directly on the member's session ─────────
  let a6 = false;
  let a7 = false;
  if (askedQuestion && uirEvent && requestId) {
    const request = JSON.parse(uirEvent.payload_json).request as {
      questions: { id: string; options: { id: string }[] }[];
    };
    const answers = request.questions.map((q) => ({ questionId: q.id, selectedOptionIds: [q.options[0]!.id] }));
    const answerFrames = await postChat({
      sessionId: topicId,
      inputResponse: { requestId, answers },
    });
    const answerDone = answerFrames.some((f) => f.type === "done");
    console.log(`\nPosted answer to ${topicId}; stream ended (done=${answerDone}).`);

    db.close(); // reopen to see fresh rows
    const db2 = new DatabaseSync(DB_PATH, { readOnly: true });
    const memberEventsAfter = db2
      .prepare("SELECT sequence, session_id, turn, kind, payload_json FROM session_events WHERE session_id = ? ORDER BY sequence")
      .all(topicId) as unknown as EventRow[];
    const uirEventAfter = memberEventsAfter.find((e) => e.sequence === uirEvent.sequence)!;
    const status = deriveStatus(memberEventsAfter, uirEventAfter, requestId);
    a6 = status === "answered";
    if (a6) pass(`6. user_input_required request status is now "answered"`);
    else fail(`6. request status is "${status}", expected "answered"`);
    hardFail ||= !a6;

    const newTurnMsg = memberEventsAfter.find(
      (e) => e.kind === "user_message" && e.turn > uirEventAfter.turn && JSON.parse(e.payload_json).response_to === requestId,
    );
    a7 = !!newTurnMsg;
    if (a7) pass(`7. member session gained turn ${newTurnMsg?.turn} with user_message.response_to=${requestId}`);
    else fail(`7. no new turn with a response_to-carrying user_message found`);
    hardFail ||= !a7;

    db2.close();
  } else {
    skip(`6. no question was asked — cannot answer it`);
    skip(`7. no question was asked — cannot answer it`);
  }

  if (!askedQuestion) db.close();

  console.log(`\n${BOLD}Note on assertion 8 (data/sessions.sqlite mtime unchanged):${RESET}`);
  console.log(`this script cannot check that itself — it only ever talks to ${DB_PATH}. Compare`);
  console.log(`\`stat -f "%m" data/sessions.sqlite\` before and after the whole run by hand.`);

  console.log(`\n${BOLD}Research session id:${RESET} ${researchId}  ${BOLD}Member Topic id:${RESET} ${topicId}`);
  console.log(`${DIM}(kept in ${DB_PATH} for inspection)${RESET}`);
  process.exit(hardFail ? 1 : 0);
}

main().catch((err) => {
  console.error(`${RED}Fatal error:${RESET}`, err);
  process.exit(1);
});
