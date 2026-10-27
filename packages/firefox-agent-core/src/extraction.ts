export type FirefoxExtractionType =
  | "text"
  | "number"
  | "integer"
  | "date"
  | "time"
  | "datetime"
  | "duration"
  | "list"
  | "list.number"
  | "list.date";

export type FirefoxExtractionField = {
  type: FirefoxExtractionType;
  instructions?: string;
  unit?: string;
  decimals?: number;
  selector?: {
    role?: string;
    name?: string;
    label?: string;
    text?: string;
    exact?: boolean;
  };
};

export type FirefoxExtractionCandidate = {
  text: string;
  ref?: string;
};

export type FirefoxExtractionEvidence = {
  text: string;
  ref?: string;
  truncated?: boolean;
};

export type FirefoxExtractionAbsent = {
  status: "absent";
  type: FirefoxExtractionType;
  evidence: [];
};

export type FirefoxExtractionUncertain = {
  status: "uncertain";
  type?: FirefoxExtractionType;
  reason: string;
  evidence: FirefoxExtractionEvidence[];
};

export type FirefoxExtractionSuccess =
  | {
      status: "extracted";
      type: "text" | "date" | "time" | "datetime";
      value: string;
      evidence: FirefoxExtractionEvidence[];
    }
  | {
      status: "extracted";
      type: "number" | "integer" | "duration";
      value: number;
      unit?: string;
      evidence: FirefoxExtractionEvidence[];
    }
  | {
      status: "extracted";
      type: "list";
      value: string[];
      evidence: FirefoxExtractionEvidence[];
    }
  | {
      status: "extracted";
      type: "list.number";
      value: number[];
      unit?: string;
      evidence: FirefoxExtractionEvidence[];
    }
  | {
      status: "extracted";
      type: "list.date";
      value: string[];
      evidence: FirefoxExtractionEvidence[];
    };

export type FirefoxExtractionResult =
  | FirefoxExtractionSuccess
  | FirefoxExtractionAbsent
  | FirefoxExtractionUncertain;

export type FirefoxExtractionResults = Record<string, FirefoxExtractionResult>;

const MAX_FIELDS = 64;
const MAX_FIELD_RESULT_BYTES = 8_192;
const MAX_CANDIDATES = 20;
const MAX_EVIDENCE = 3;
const MAX_CANDIDATE_CHARS = 4_096;
const MAX_EVIDENCE_CHARS = 240;
const MAX_VALUE_CHARS = 1_000;
const MAX_LIST_ITEMS = 100;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const REF = /^e[0-9]{1,64}$/u;
const TYPES = new Set<FirefoxExtractionType>([
  "text",
  "number",
  "integer",
  "date",
  "time",
  "datetime",
  "duration",
  "list",
  "list.number",
  "list.date",
]);
const DURATION_UNITS: Record<string, number> = {
  ms: 0.001,
  s: 1,
  min: 60,
  h: 3_600,
  d: 86_400,
};

// Conversion is intentionally local and literal. The source-bound approach is informed by surf-cli:
// https://github.com/surf-cli/surf
export function extractFirefoxFields(
  fields: Record<string, FirefoxExtractionField>,
  sources: Record<string, FirefoxExtractionCandidate[]>,
): FirefoxExtractionResults {
  const results: FirefoxExtractionResults = {};
  if (!isPlainObject(fields)) return results;
  const names = Object.keys(fields).slice(0, MAX_FIELDS);
  for (const name of names) {
    if (!FIELD_NAME.test(name)) continue;
    const fieldResult = extractField(
      fields[name] as FirefoxExtractionField,
      isPlainObject(sources) ? sources[name] : undefined,
    );
    const result =
      new TextEncoder().encode(JSON.stringify(fieldResult)).byteLength <=
      MAX_FIELD_RESULT_BYTES
        ? fieldResult
        : uncertain(
            "result_limit",
            "type" in fieldResult ? fieldResult.type : undefined,
            fieldResult.evidence,
          );
    Object.defineProperty(results, name, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: result,
    });
  }
  return results;
}

function extractField(
  field: FirefoxExtractionField,
  candidates: unknown,
): FirefoxExtractionResult {
  if (!isPlainObject(field) || !TYPES.has(field.type)) {
    return uncertain("invalid_field", undefined, []);
  }
  const type = field.type;
  const evidenceCandidates = Array.isArray(candidates) ? candidates : [];
  const evidence = evidenceCandidates.slice(0, MAX_EVIDENCE).map(makeEvidence);
  if (evidenceCandidates.length > MAX_CANDIDATES)
    return uncertain("candidate_limit", type, evidence);
  if (
    field.instructions !== undefined &&
    (typeof field.instructions !== "string" ||
      field.instructions.trim().length > 0)
  ) {
    return uncertain("unsupported_instructions", type, evidence);
  }
  if (
    field.decimals !== undefined &&
    ((type !== "number" && type !== "list.number") ||
      !Number.isSafeInteger(field.decimals) ||
      field.decimals < 0 ||
      field.decimals > 12)
  ) {
    return uncertain("invalid_decimals", type, evidence);
  }
  if (
    field.unit !== undefined &&
    (typeof field.unit !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,23}$/u.test(field.unit))
  ) {
    return uncertain("invalid_unit", type, evidence);
  }
  if (
    field.unit !== undefined &&
    !["number", "integer", "duration", "list.number"].includes(type)
  ) {
    return uncertain("unsupported_unit", type, evidence);
  }

  if (
    candidates === undefined ||
    (Array.isArray(candidates) && candidates.length === 0)
  )
    return absent(type);
  if (!Array.isArray(candidates))
    return uncertain("invalid_sources", type, evidence);
  const nonempty: { text: string; candidate: FirefoxExtractionCandidate }[] =
    [];
  for (const candidate of candidates) {
    if (!isPlainObject(candidate) || typeof candidate.text !== "string") {
      return uncertain("invalid_candidate", type, evidence);
    }
    if (candidate.text.length > MAX_CANDIDATE_CHARS)
      return uncertain("source_limit", type, evidence);
    const text = candidate.text.trim();
    if (text)
      nonempty.push({
        text,
        candidate: candidate as FirefoxExtractionCandidate,
      });
  }
  if (nonempty.length === 0) return absent(type);

  const converted = nonempty.map(({ text }) => convert(type, text, field));
  if (converted.some((item) => !item.ok)) {
    const reason =
      converted.find((item) => !item.ok)?.reason ?? "invalid_value";
    return uncertain(reason, type, evidence);
  }
  const first = converted[0];
  if (!first?.ok) return uncertain("invalid_value", type, evidence);
  if (
    converted.some((item) => !item.ok || !sameValue(item.value, first.value))
  ) {
    return uncertain("conflicting_candidates", type, evidence);
  }

  const usedEvidence = nonempty
    .slice(0, MAX_EVIDENCE)
    .map(({ candidate }) => makeEvidence(candidate));
  if (type === "number" || type === "integer") {
    return {
      status: "extracted",
      type,
      value: first.value as number,
      ...(field.unit ? { unit: field.unit } : {}),
      evidence: usedEvidence,
    };
  }
  if (type === "duration") {
    return {
      status: "extracted",
      type,
      value: first.value as number,
      unit: "s",
      evidence: usedEvidence,
    };
  }
  if (type === "list.number") {
    return {
      status: "extracted",
      type,
      value: first.value as number[],
      ...(field.unit ? { unit: field.unit } : {}),
      evidence: usedEvidence,
    };
  }
  if (type === "list")
    return {
      status: "extracted",
      type,
      value: first.value as string[],
      evidence: usedEvidence,
    };
  if (type === "list.date")
    return {
      status: "extracted",
      type,
      value: first.value as string[],
      evidence: usedEvidence,
    };
  return {
    status: "extracted",
    type,
    value: first.value as string,
    evidence: usedEvidence,
  };
}

type Conversion =
  | { ok: true; value: string | number | string[] | number[] }
  | { ok: false; reason: string };

function convert(
  type: FirefoxExtractionType,
  text: string,
  field: FirefoxExtractionField,
): Conversion {
  switch (type) {
    case "text":
      return text.length <= MAX_VALUE_CHARS
        ? { ok: true, value: text }
        : { ok: false, reason: "value_limit" };
    case "number":
      return parseNumber(text, field.decimals);
    case "integer": {
      if (!/^-?(?:0|[1-9][0-9]*)$/u.test(text))
        return { ok: false, reason: "ambiguous_number" };
      const value = Number(text);
      return Number.isSafeInteger(value)
        ? { ok: true, value }
        : { ok: false, reason: "number_range" };
    }
    case "date":
      return validDate(text)
        ? { ok: true, value: text }
        : { ok: false, reason: "ambiguous_date" };
    case "time":
      return validTime(text)
        ? { ok: true, value: text }
        : { ok: false, reason: "ambiguous_time" };
    case "datetime":
      return normalizeDateTime(text);
    case "duration":
      return parseDuration(text, field.unit);
    case "list":
    case "list.number":
    case "list.date": {
      const parts = splitList(text);
      if (parts.length > MAX_LIST_ITEMS)
        return { ok: false, reason: "list_limit" };
      if (parts.length === 0) return { ok: false, reason: "invalid_list" };
      if (type === "list") return { ok: true, value: parts };
      if (type === "list.number") {
        const values: number[] = [];
        for (const part of parts) {
          const number = parseNumber(part, field.decimals);
          if (!number.ok) return number;
          values.push(number.value as number);
        }
        return { ok: true, value: values };
      }
      const dates: string[] = [];
      for (const part of parts) {
        if (!validDate(part)) return { ok: false, reason: "ambiguous_date" };
        dates.push(part);
      }
      return { ok: true, value: dates };
    }
  }
}

function parseNumber(text: string, decimals: number | undefined): Conversion {
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(text))
    return { ok: false, reason: "ambiguous_number" };
  const fraction = text.split(".")[1] ?? "";
  if (decimals !== undefined && fraction.length > decimals)
    return { ok: false, reason: "precision_exceeded" };
  const value = Number(text);
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
    return { ok: false, reason: "number_range" };
  const significant = text
    .replace(/^-?/u, "")
    .replace(".", "")
    .replace(/^0+/u, "")
    .replace(/0+$/u, "");
  const fractionHasValue = /\.[0-9]*[1-9][0-9]*$/u.test(text);
  if (
    significant.length > 15 &&
    !(Number.isSafeInteger(value) && !fractionHasValue)
  ) {
    return { ok: false, reason: "precision_exceeded" };
  }
  return { ok: true, value };
}

function parseDuration(text: string, unit: string | undefined): Conversion {
  const iso =
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/u.exec(
      text,
    );
  if (
    iso &&
    (iso[1] || iso[2] || iso[3] || iso[4]) &&
    (!text.includes("T") || iso[2] || iso[3] || iso[4])
  ) {
    if (unit !== undefined) return { ok: false, reason: "unsupported_unit" };
    const value =
      Number(iso[1] ?? 0) * 86_400 +
      Number(iso[2] ?? 0) * 3_600 +
      Number(iso[3] ?? 0) * 60 +
      Number(iso[4] ?? 0);
    return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER
      ? { ok: true, value }
      : { ok: false, reason: "number_range" };
  }
  if (!unit || !Object.hasOwn(DURATION_UNITS, unit))
    return { ok: false, reason: "ambiguous_duration" };
  const number = parseNumber(text, undefined);
  if (!number.ok) return number;
  const value = (number.value as number) * (DURATION_UNITS[unit] ?? 1);
  return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER
    ? { ok: true, value }
    : { ok: false, reason: "number_range" };
}

function splitList(text: string): string[] {
  const parts = text.split(/[,;\n]/u).map((part) => part.trim());
  return parts.every(Boolean) ? parts : [];
}

function validDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function validTime(text: string): boolean {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(text);
  if (!match) return false;
  return (
    Number(match[1]) <= 23 &&
    Number(match[2]) <= 59 &&
    Number(match[3] ?? 0) <= 59
  );
}

function normalizeDateTime(text: string): Conversion {
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)(Z|[+-]\d{2}:\d{2})$/u.exec(
      text,
    );
  if (!match || !validDate(match[1] ?? ""))
    return { ok: false, reason: "ambiguous_datetime" };
  const time = match[2] ?? "";
  const timeBase = time.split(".")[0] ?? "";
  if (!validTime(timeBase)) return { ok: false, reason: "ambiguous_datetime" };
  const offset = match[3] ?? "";
  if (offset !== "Z") {
    const offsetParts = /([+-])(\d{2}):(\d{2})/u.exec(offset);
    if (
      !offsetParts ||
      Number(offsetParts[2]) > 14 ||
      Number(offsetParts[3]) > 59 ||
      (Number(offsetParts[2]) === 14 && Number(offsetParts[3]) !== 0)
    ) {
      return { ok: false, reason: "ambiguous_datetime" };
    }
  }
  const millis = Date.parse(text);
  if (!Number.isFinite(millis))
    return { ok: false, reason: "ambiguous_datetime" };
  return { ok: true, value: new Date(millis).toISOString() };
}

function makeEvidence(candidate: unknown): FirefoxExtractionEvidence {
  if (!isPlainObject(candidate) || typeof candidate.text !== "string")
    return { text: "" };
  const text = candidate.text.slice(0, MAX_EVIDENCE_CHARS);
  const evidence: FirefoxExtractionEvidence = { text };
  if (candidate.text.length > MAX_EVIDENCE_CHARS) evidence.truncated = true;
  if (typeof candidate.ref === "string" && REF.test(candidate.ref))
    evidence.ref = candidate.ref;
  return evidence;
}

function absent(type: FirefoxExtractionType): FirefoxExtractionAbsent {
  return { status: "absent", type, evidence: [] };
}

function uncertain(
  reason: string,
  type: FirefoxExtractionType | undefined,
  evidence: FirefoxExtractionEvidence[],
): FirefoxExtractionUncertain {
  return { status: "uncertain", ...(type ? { type } : {}), reason, evidence };
}

function sameValue(
  left: string | number | string[] | number[],
  right: string | number | string[] | number[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
