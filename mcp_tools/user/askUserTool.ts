import { newId } from "../../src/framework/ids.ts";
import type {
  JsonObject,
  JsonValue,
  UserInputOption,
  UserInputQuestion,
} from "../../src/framework/types.ts";
import type { RegisteredTool } from "../toolRegistry.ts";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_QUESTIONS = 3;
const MAX_OPTIONS = 8;

function invalid(message: string) {
  return {
    summary: message,
    error: { code: "invalid_user_input_request", message },
  };
}

function textField(value: JsonValue | undefined, name: string, maxLength: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${name} must be at most ${maxLength} characters`);
  return normalized;
}

function idField(value: JsonValue | undefined, name: string): string {
  const id = textField(value, name, 64);
  if (!id || !ID_PATTERN.test(id)) throw new Error(`${name} must match ${ID_PATTERN}`);
  return id;
}

function integerField(value: JsonValue | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function parseOption(value: JsonValue, questionId: string, index: number): UserInputOption {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`questions.${questionId}.options[${index}] must be an object`);
  }
  const raw = value as JsonObject;
  const option: UserInputOption = {
    id: idField(raw.id, `questions.${questionId}.options[${index}].id`),
    label: textField(raw.label, `questions.${questionId}.options[${index}].label`, 80)!,
  };
  const description = textField(raw.description, `questions.${questionId}.options[${index}].description`, 240, true);
  if (description) option.description = description;
  if (raw.recommended !== undefined) {
    if (typeof raw.recommended !== "boolean") {
      throw new Error(`questions.${questionId}.options[${index}].recommended must be a boolean`);
    }
    if (raw.recommended) option.recommended = true;
  }
  return option;
}

function parseQuestion(value: JsonValue, index: number): UserInputQuestion {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`questions[${index}] must be an object`);
  }
  const raw = value as JsonObject;
  const id = idField(raw.id, `questions[${index}].id`);
  if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > MAX_OPTIONS) {
    throw new Error(`questions.${id}.options must contain 2-${MAX_OPTIONS} options`);
  }
  const options = raw.options.map((option, optionIndex) => parseOption(option, id, optionIndex));
  if (new Set(options.map((option) => option.id)).size !== options.length) {
    throw new Error(`questions.${id}.options ids must be unique`);
  }
  const min = integerField(raw.min_selections, 1, `questions.${id}.min_selections`);
  const max = integerField(raw.max_selections, options.length, `questions.${id}.max_selections`);
  if (min < 1 || max < min || max > options.length) {
    throw new Error(`questions.${id} selection limits must satisfy 1 <= min_selections <= max_selections <= options.length`);
  }
  const question: UserInputQuestion = {
    id,
    question: textField(raw.question, `questions.${id}.question`, 500)!,
    options,
    min_selections: min,
    max_selections: max,
  };
  const header = textField(raw.header, `questions.${id}.header`, 40, true);
  if (header) question.header = header;
  return question;
}

export function createAskUserTool(): RegisteredTool {
  return {
    name: "ask_user",
    description:
      "Ask the user 1-3 structured questions when their input is required before proceeding. " +
      'Input: {"questions":[{"id":"stable_id","header":"optional short label","question":"text","options":[{"id":"stable_id","label":"short title","description":"optional tradeoff","recommended":false}],"min_selections":1,"max_selections":2}]}. ' +
      "Each question has 2-8 selectable options and may allow multiple selections; all questions submit together. This must be the only action in the step. " +
      "Set reply to a concise introduction to the questions. Do not use this when you can proceed safely without user input.",
    category: "main",
    inputSchema: {
      type: "object",
      required: ["questions"],
      properties: {
        questions: {
          type: "array",
          description: "1-3 questions. All questions are submitted together.",
          items: {
            type: "object",
            required: ["id", "question", "options"],
            properties: {
              id: { type: "string", description: "Stable unique id using letters, digits, underscore, or hyphen." },
              header: { type: "string", description: "Optional short section label, at most 40 characters." },
              question: { type: "string", description: "The question shown to the user." },
              options: {
                type: "array",
                description: "2-8 options.",
                items: {
                  type: "object",
                  required: ["id", "label"],
                  properties: {
                    id: { type: "string", description: "Stable option id unique within this question." },
                    label: { type: "string", description: "Short option title." },
                    description: { type: "string", description: "Optional explanation of the choice and tradeoff." },
                    recommended: { type: "boolean", description: "True to show a recommendation badge; this never preselects the option." },
                  },
                },
              },
              min_selections: { type: "number", description: "Minimum selections required; defaults to 1." },
              max_selections: { type: "number", description: "Maximum selections allowed; defaults to all options." },
            },
          },
        },
      },
    },
    execute: async (input) => {
      try {
        if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > MAX_QUESTIONS) {
          return invalid(`questions must contain 1-${MAX_QUESTIONS} items`);
        }
        const questions = input.questions.map(parseQuestion);
        if (new Set(questions.map((question) => question.id)).size !== questions.length) {
          return invalid("question ids must be unique");
        }
        return {
          summary: `Waiting for the user to answer ${questions.length} question${questions.length === 1 ? "" : "s"}.`,
          user_input_request: {
            request_id: newId("input"),
            questions,
          },
        };
      } catch (error) {
        return invalid(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
