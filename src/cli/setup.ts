import { access, copyFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";

try {
  await access(".env", constants.F_OK);
  process.stdout.write(".env already exists; no changes made.\n");
} catch {
  await copyFile(".env-template", ".env");
  process.stdout.write("Created .env from .env-template. Add credentials before continuing.\n");
}
await mkdir(".data", { recursive: true, mode: 0o700 });
process.stdout.write("Next: npm run auth:asana, then npm run doctor, then npm run dev.\n");
