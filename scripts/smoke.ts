import { resolve } from "node:path";
import { createSession } from "../src/prolog.js";
import {
  consultFile, describeCurrent, describeLocation, formatLocation,
  getPlayerLoc, loadSchema, markVisited, movePlayer
} from "../src/world.js";

async function main() {
  const session = await createSession();
  await loadSchema(session);
  await consultFile(session, resolve("seeds/cottage.pl"));
  console.log("LOC1:", await getPlayerLoc(session));
  const v1 = await describeCurrent(session);
  console.log("VIEW1 exits:", v1?.exits);
  await movePlayer(session, "cottage_door");
  console.log("LOC2:", await getPlayerLoc(session));
  const v2 = await describeCurrent(session);
  console.log("VIEW2:", v2?.shortName, "exits:", v2?.exits);
  await session.dispose();
}
main().catch(e => { console.error(e); process.exit(1); });
