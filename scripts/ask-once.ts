import { randomUUID } from "node:crypto";
import { appendFile, writeFile } from "node:fs/promises";
import { createApplication } from "../src/app.js";

const app = createApplication();
const ctx = {
  organizationId: app.config.runtime.organizationId,
  userId: app.config.runtime.userId,
  conversationId: randomUUID(),
};
const q =
  "Which active projects are underwater against their budget right now? Use simulated QuickBooks if job-level costs exist; if projects are not individually costed, say that gap plainly and label any figures as synthetic.";

const answer = await app.agent.ask(q, ctx, (p) => {
  process.stdout.write(`\r${p.stage}: ${p.message}`.padEnd(70));
});
process.stdout.write("\n");
console.log(answer.text);
await writeFile(
  "grind-results/grind-retry-q5-clean.txt",
  `${q}\n\n${answer.text}\n\nevidence=${answer.evidence.length} tools=${answer.executions.length}\n`,
);
await app.skills.close();
