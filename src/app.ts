import { AgentRuntime } from "./agent/runtime.js";
import { readConfig, type AppConfig } from "./config.js";
import { SkillRegistry } from "./core/skills.js";
import { OpenAILLMProvider } from "./providers/llm/openai.js";
import { LocalStore } from "./storage/local.js";
import { AsanaSkill } from "../skills/asana/index.js";
import { AwsSkill } from "../skills/aws/index.js";
import { NotionSkill } from "../skills/notion/index.js";

export type Application = ReturnType<typeof createApplication>;

export function createApplication(config: AppConfig = readConfig()) {
  const store = new LocalStore(config.runtime.dataDir);
  const llm = new OpenAILLMProvider(config);
  const skills = new SkillRegistry(
    [new AsanaSkill(config), new AwsSkill(config), new NotionSkill(config)],
    store,
    config.runtime.toolTimeoutMs,
  );
  const agent = new AgentRuntime(config, llm, skills, store, store, store);
  return { config, store, llm, skills, agent };
}
