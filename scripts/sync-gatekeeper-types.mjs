import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const source = await readFile(join(process.cwd(), "src/types.d.ts"), "utf8");
await writeFile(join(process.cwd(), "src/types-code.ts"), `const TYPES_CODE = ${JSON.stringify(source)};\nexport default TYPES_CODE;\n`);
