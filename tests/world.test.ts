import { describe, expect, it } from "vitest";
import { createSession } from "../src/prolog.js";
import { loadSchema } from "../src/world.js";

describe("incremental lore accumulation", () => {
  it("adding a second location/3 in a separate assert call does NOT wipe the first", async () => {
    const s = await createSession();
    try {
      await loadSchema(s);
      const r1 = await s.assert("location(a, 'A', 'first place').");
      expect(r1.status).toBe("ok");
      const r2 = await s.assert("location(b, 'B', 'second place').");
      expect(r2.status).toBe("ok");

      const q = await s.query("location(L, _, _)");
      expect(q.status).toBe("success");
      if (q.status === "success") {
        const ids = q.answers.map((a) => a.bindings.L);
        expect(ids).toEqual(expect.arrayContaining(["a", "b"]));
      }
    } finally {
      await s.dispose();
    }
  });

  it("adding exits across multiple asserts accumulates", async () => {
    const s = await createSession();
    try {
      await loadSchema(s);
      await s.assert("exit(a, north, b).");
      await s.assert("exit(b, south, a).");
      await s.assert("exit(b, east, c).");
      const q = await s.query("exit(_, _, _)");
      expect(q.status).toBe("success");
      if (q.status === "success") {
        expect(q.answers).toHaveLength(3);
      }
    } finally {
      await s.dispose();
    }
  });
});
