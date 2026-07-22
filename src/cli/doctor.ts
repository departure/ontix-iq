import { createApplication } from "../app.js";
import { missingRequiredServices } from "../config.js";

const app = createApplication();
const missing = missingRequiredServices(app.config);
if (missing.length > 0) {
  process.stdout.write(`Configuration: missing ${missing.join(", ")}\n`);
}

const [llm, skills] = await Promise.all([app.llm.doctor(), app.skills.doctors()]);
const results = [
  { service: "OpenAI", ...llm },
  ...skills,
];
for (const result of results) {
  process.stdout.write(`${result.status.toUpperCase().padEnd(7)} ${result.service}: ${result.message}\n`);
}
await app.skills.close();
if (results.some((result) => result.status === "error")) process.exitCode = 1;
