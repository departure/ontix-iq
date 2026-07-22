import { createApplication } from "./app.js";
import { missingRequiredServices } from "./config.js";
import { runChat } from "./tui/chat.js";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error("Ontix IQ terminal mode requires an interactive TTY");
}

const app = createApplication();
const missing = missingRequiredServices(app.config);
if (missing.length > 0) {
  process.stderr.write(
    `Warning: some connections are not configured (${missing.join(", ")}). Use /status for details.\n`,
  );
}

await runChat(app);
