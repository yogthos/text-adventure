import { renderMarkdown, openingBanner, endingBanner, style } from "../src/render.js";

console.log("--- USER'S EXAMPLE ---\n");
console.log(renderMarkdown(
  "Would you like to **search Father Murphy's body**, **investigate the sacristy** (the room behind the altar), or **climb the bell tower**?",
));
console.log("\n--- WIDER PALETTE TEST ---\n");
console.log(renderMarkdown(`The lantern flickers. *Something moves at the edge of your vision* — but when you turn, there's only the **rusted altar rail** and the dust.

You could:

- **search the body** of Father Murphy
- **examine the sacristy** door
- *step back* into the nave

The sound was probably nothing. \`probably\``));
console.log("\n--- BANNER + STATUS + ENDING ---\n");
console.log(openingBanner({
  theme: "an exorcist arriving at a frontier mining town the day after the saints' feast",
  setting: "saintsfeast_aftermath",
  premise: "Father Murphy is dead. The town is quiet — too quiet. The saints' feast was last night, and something has been wrong since dawn.",
  goal: "Find what killed Father Murphy and end it before sundown.",
  turnLimit: 25,
}));
console.log("\n" + style.status("[turn 3/25 · health=8 · sanity=6]"));
console.log("\n" + endingBanner("won"));
console.log("\n" + endingBanner({ lost: "possessed" }));
