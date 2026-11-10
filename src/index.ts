import { Plugin } from "@opencode/plugin";
import { parseOptions } from "./options.js";
import { createRuntime } from "./runtime.js";
import { registerCommands } from "./catalog/command-registration.js";
import { registerSkills } from "./catalog/skill-registration.js";
import { registerTools } from "./tools/index.js";
import { registerHooks } from "./hooks/index.js";
import { reconcileRunning, registerOrchestrator } from "./orchestrator/launch.js";

export default Plugin.define({
  id: "lindoelio.agent-team",
  async setup(ctx) {
    const options = parseOptions(ctx.options);
    const runtime = createRuntime(ctx, options);

    const registrations = await Promise.all([
      registerCommands(runtime),
      registerSkills(runtime),
      registerTools(runtime),
      registerHooks(runtime),
      registerOrchestrator(runtime),
    ]);
    await reconcileRunning(runtime).catch(() => {});

    return async () => {
      await Promise.all(registrations.map((registration) => registration.dispose()));
    };
  },
});
