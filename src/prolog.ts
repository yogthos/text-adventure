/**
 * SWI-Prolog session wrapper for the text-adventure world model.
 *
 * Adapted from reasoning-harness/src/harness/prolog.ts. The world's
 * ground-truth knowledge base lives inside one persistent session: the
 * DM asserts lore + state through `assert`, and queries facts through
 * `query`. Inference limit guards every query so a runaway labeling
 * (e.g. an over-broad CLP(FD) goal) can't hang the game loop.
 */

import { initProlog, type PrologFull } from "prolog-wasm-full";

const MAX_ANSWERS = 1000;
const DEFAULT_INFERENCE_LIMIT = 50_000_000;

const LIMIT_MARKER_VAR = "AdvLimitResult_3F2A1B";
const LIMIT_EXCEEDED_ATOM = "inference_limit_exceeded";

export interface PrologAnswer {
  bindings: Record<string, string>;
  formatted: string;
}

export type PrologResult =
  | { status: "success"; answers: PrologAnswer[] }
  | { status: "error"; error: string };

function isAtomBare(s: string): boolean {
  return /^[a-z][a-zA-Z0-9_]*$/.test(s);
}

function termToProlog(value: unknown): string {
  if (value === null || value === undefined) return "_";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (isAtomBare(value)) return value;
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  if (Array.isArray(value)) {
    return `[${value.map(termToProlog).join(", ")}]`;
  }
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (v.$t === "t" && typeof v.functor === "string") {
      const fn = v.functor;
      const argsWrap = v[fn];
      const args: unknown[] =
        Array.isArray(argsWrap) &&
        argsWrap.length === 1 &&
        Array.isArray(argsWrap[0])
          ? (argsWrap[0] as unknown[])
          : Array.isArray(argsWrap)
            ? (argsWrap as unknown[])
            : [argsWrap];
      if (fn === "-" && args.length === 2) {
        return `${termToProlog(args[0])}-${termToProlog(args[1])}`;
      }
      return `${fn}(${args.map(termToProlog).join(", ")})`;
    }
    return JSON.stringify(v);
  }
  return JSON.stringify(value);
}

function bindingsToFormatted(bindings: Record<string, string>): string {
  const entries = Object.entries(bindings);
  if (entries.length === 0) return "true";
  return entries.map(([k, v]) => `${k} = ${v}`).join(", ");
}

/** Strip surrounding single quotes and unescape Prolog atom/string escapes. */
export function unq(s: string | undefined): string {
  if (!s) return "";
  if (s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  }
  return s;
}

let plPromise: Promise<PrologFull> | null = null;
let pathCounter = 0;

async function getPl(): Promise<PrologFull> {
  plPromise ??= (async () => {
    const pl = await initProlog();
    pl.consult(`
      :- use_module(library(lists)).
      :- use_module(library(clpfd)).
    `);
    return pl;
  })();
  return plPromise;
}

function uniqueTempPath(prefix: string): string {
  return `/tmp/_adv_${prefix}_${Date.now()}_${pathCounter++}.pl`;
}

const SAFE_PATH_RE = /^[/A-Za-z0-9_.-]+$/;

function normalizeQuery(q: string): string {
  let s = q.trim();
  if (s.startsWith("?-")) s = s.slice(2).trim();
  if (s.endsWith(".")) s = s.slice(0, -1).trim();
  // Block Prolog metacharacters that the LLM should never emit in a
  // read-only query: disjunction, cut, line/block comments.
  if (/[;!]/.test(s)) {
    throw new Error(`query contains disallowed metacharacters: "${s.slice(0, 80)}"`);
  }
  if (s.includes("%") || s.includes("/*")) {
    throw new Error(`query contains comments: "${s.slice(0, 80)}"`);
  }
  return s;
}

class CapReachedError extends Error {}
class LimitExceededError extends Error {}

async function executeQuery(
  pl: PrologFull,
  goal: string,
): Promise<PrologResult> {
  let normalized: string;
  try {
    normalized = normalizeQuery(goal);
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
  if (!normalized) return { status: "error", error: "empty query" };

  // catch existence_error so queries against undefined-but-declared-dynamic
  // (or wholly unknown) predicates silently fail rather than raising —
  // the DM probes the KB liberally and we don't want stderr pollution.
  // call_with_inference_limit guards against runaway labelings.
  const wrapped = `catch(call_with_inference_limit((${normalized}), ${DEFAULT_INFERENCE_LIMIT}, ${LIMIT_MARKER_VAR}), error(existence_error(procedure, _), _), fail)`;

  let handle: ReturnType<PrologFull["query"]>;
  try {
    handle = pl.query(wrapped);
  } catch (e) {
    return {
      status: "error",
      error: `query error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const answers: PrologAnswer[] = [];
  let limitExceeded = false;
  try {
    try {
      handle.forEach((rawBindings) => {
        if (answers.length >= MAX_ANSWERS) throw new CapReachedError();
        const marker = rawBindings[LIMIT_MARKER_VAR];
        if (marker === LIMIT_EXCEEDED_ATOM) {
          limitExceeded = true;
          throw new LimitExceededError();
        }
        const bindings: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawBindings)) {
          if (k === LIMIT_MARKER_VAR) continue;
          bindings[k] = termToProlog(v);
        }
        answers.push({ bindings, formatted: bindingsToFormatted(bindings) });
      });
    } finally {
      try {
        handle.close();
      } catch {
        /* best-effort */
      }
    }
  } catch (e) {
    if (e instanceof LimitExceededError || limitExceeded) {
      return {
        status: "error",
        error: `query exceeded inference limit (${DEFAULT_INFERENCE_LIMIT.toLocaleString()})`,
      };
    }
    if (!(e instanceof CapReachedError)) {
      return {
        status: "error",
        error: `answer error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    // Cap reached — return what we have.
  }
  return { status: "success", answers };
}

function cleanupTempFile(pl: PrologFull, path: string): void {
  try {
    const preds = pl
      .query(`source_file(P, '${path}'), functor(P, F, A)`)
      .all();
    for (const row of preds) {
      const f = (row as Record<string, unknown>).F;
      const a = (row as Record<string, unknown>).A;
      if (typeof f !== "string" || typeof a !== "number") continue;
      if (!isAtomBare(f)) continue;
      try {
        pl.stock.call(`abolish(${f}/${a})`);
      } catch {
        /* best-effort */
      }
    }
    pl.stock.call(`unload_file('${path}')`);
  } catch {
    /* best-effort */
  }
  try {
    pl.em.FS.unlink(path);
  } catch {
    /* file may already be gone */
  }
}

export interface PrologSession {
  /** Append rules/facts to the persistent KB. */
  assert(code: string): Promise<{ status: "ok" } | { status: "error"; error: string }>;
  /** Run a single arbitrary goal against the session. */
  query(goal: string): Promise<PrologResult>;
  /** Tear down everything this session asserted. */
  dispose(): Promise<void>;
}

export async function createSession(): Promise<PrologSession> {
  const pl = await getPl();
  const tempfiles: string[] = [];

  function consultCode(code: string): { path: string } | { error: string } {
    const path = uniqueTempPath("session");
    if (!SAFE_PATH_RE.test(path)) {
      return { error: `internal: tempfile path failed safety check: ${path}` };
    }
    try {
      pl.em.FS.writeFile(path, code);
      pl.stock.call(`consult('${path}')`);
      return { path };
    } catch (e) {
      try {
        pl.em.FS.unlink(path);
      } catch {
        /* best-effort */
      }
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  return {
    async assert(code: string) {
      const trimmed = code.trim();
      if (!trimmed) return { status: "error", error: "assert requires non-empty code" };
      const r = consultCode(trimmed);
      if ("error" in r) return { status: "error", error: r.error };
      tempfiles.push(r.path);
      return { status: "ok" };
    },
    async query(goal: string) {
      return executeQuery(pl, goal);
    },
    async dispose() {
      for (const path of tempfiles) cleanupTempFile(pl, path);
      tempfiles.length = 0;
    },
  };
}
