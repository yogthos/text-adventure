import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chdir, cwd } from "node:process";
import { createSession } from "../src/prolog.js";
import {
  describeCurrent,
  getInventory,
  getPlayerLoc,
  movePlayer,
  takeItem,
} from "../src/world.js";
import { loadGame, newGame, saveGame, slotExists } from "../src/persist.js";

const PROJECT = resolve(__dirname, "..");
const SEED = resolve(PROJECT, "seeds/cottage.pl");

/**
 * Each test runs in its own tmp cwd so the saves/ directory the
 * persist module writes is sandboxed and doesn't pollute the repo.
 */
function inTmpCwd<T>(fn: () => Promise<T>): Promise<T> {
  const orig = cwd();
  const dir = mkdtempSync(`${tmpdir()}/adv-test-`);
  chdir(dir);
  return fn().finally(() => {
    chdir(orig);
    rmSync(dir, { recursive: true, force: true });
  });
}

describe("persist", () => {
  it("round-trips player state through save+load", async () => {
    await inTmpCwd(async () => {
      // Session 1: new game, mutate, save.
      const s1 = await createSession();
      try {
        await newGame(s1, SEED);
        expect(await getPlayerLoc(s1)).toBe("yard");
        await movePlayer(s1, "cottage_cellar");
        const r = await takeItem(s1, "rusty_key");
        expect(r.ok).toBe(true);
        await movePlayer(s1, "cottage_main");
        await saveGame(s1, "trip");
        expect(slotExists("trip")).toBe(true);
      } finally {
        await s1.dispose();
      }

      // Session 2: fresh, load, verify state matches.
      const s2 = await createSession();
      try {
        await loadGame(s2, "trip");
        expect(await getPlayerLoc(s2)).toBe("cottage_main");
        const inv = await getInventory(s2);
        expect(inv.map((i) => i.id)).toContain("rusty_key");
        const view = await describeCurrent(s2);
        // Cellar should still be on the exit list, but the key
        // shouldn't be there anymore (we took it before saving).
        expect(view?.id).toBe("cottage_main");
        expect(view?.items.map((i) => i.id)).not.toContain("rusty_key");
      } finally {
        await s2.dispose();
      }
    });
  });
});
