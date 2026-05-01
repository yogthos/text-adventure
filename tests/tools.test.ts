import { describe, expect, it } from "vitest";
import { validateLore, validateStateSet } from "../src/tools.js";

describe("validateLore", () => {
  it("accepts a single location/3 clause", () => {
    expect(
      validateLore("location(crypt, 'Damp Crypt', 'A low stone vault.').").ok,
    ).toBe(true);
  });

  it("accepts multiple lore clauses in one block", () => {
    const code = `
      location(crypt, 'Damp Crypt', 'A low stone vault.').
      exit(crypt, up, cottage_cellar).
      exit(cottage_cellar, down, crypt).
      item_def(skull, 'yellowed skull', 'It grins back.', [takeable]).
      character_def(ghost, 'pale ghost', 'It hums.', wary).
      fact(ghost, killed_by, dragon).
    `;
    expect(validateLore(code).ok).toBe(true);
  });

  it("rejects a directive", () => {
    const r = validateLore(":- assertz(location(x, 'X', 'X')).");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/directives/);
  });

  it("rejects a clause for a state predicate", () => {
    const r = validateLore("player_at(yard).");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not a lore predicate/);
  });

  it("rejects empty input", () => {
    expect(validateLore("").ok).toBe(false);
    expect(validateLore("   \n  ").ok).toBe(false);
  });

  it("rejects a clause with a malformed period (unbalanced parens)", () => {
    const r = validateLore("location(x, 'X', 'X'.");
    expect(r.ok).toBe(false);
  });
});

describe("validateStateSet", () => {
  it("accepts a chained retractall+assertz directive", () => {
    expect(
      validateStateSet(
        ":- retractall(player_at(_)), assertz(player_at(crypt)).",
      ).ok,
    ).toBe(true);
  });

  it("accepts multiple directives in one block", () => {
    const code = `
      :- retractall(player_at(_)), assertz(player_at(crypt)).
      :- assertz(visited(crypt)).
      :- assertz(condition(yard, 'rain has soaked the timbers')).
      :- assertz(event_log(3, 'You enter the crypt.')).
    `;
    expect(validateStateSet(code).ok).toBe(true);
  });

  it("rejects a bare clause (must be a directive)", () => {
    const r = validateStateSet("player_at(crypt).");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/directive/);
  });

  it("rejects directives that touch lore predicates", () => {
    const r = validateStateSet(":- assertz(location(x, 'X', 'X')).");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not mutable/);
  });

  it("rejects assertz of a wholly-unknown predicate", () => {
    const r = validateStateSet(":- assertz(magic(yes)).");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not mutable/);
  });

  it("rejects asserta / assert (forces assertz)", () => {
    expect(validateStateSet(":- assert(visited(x)).").ok).toBe(false);
    expect(validateStateSet(":- asserta(visited(x)).").ok).toBe(false);
  });

  it("rejects a directive with no wrapped predicate (e.g. side-effect call)", () => {
    const r = validateStateSet(":- write(hello).");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/assertz|retract/);
  });

  it("rejects a chain that mixes assertz with arithmetic via is/2", () => {
    // Real failure mode observed from DeepSeek: silently fails mid-chain
    // and leaves the KB partially mutated. The validator must reject this.
    const r = validateStateSet(
      ":- retractall(turn_count(_)), turn_count is 1, X is turn_count+1, assertz(turn_count(X)).",
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/world_query|literal new value/);
  });

  it("rejects a chain with format/2 sneaking in", () => {
    const r = validateStateSet(":- assertz(visited(crypt)), format(\"hi\").");
    expect(r.ok).toBe(false);
  });
});
