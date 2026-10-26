import { Command } from "commander";
const program = new Command();
program
  .name("facode")
  .enablePositionalOptions()
  .option("--model <name>", "Override model")
  .argument("[prompt]")
  .action((prompt, opts) => console.log("ROOT action:", prompt, opts));
const pc = program.command("provider").description("p").action(() => pc.help());
pc.command("add [name]")
  .option("--base-url <url>")
  .option("--api-key <key>")
  .option("--model <model>")
  .option("--scope <scope>")
  .action((name, opts) => console.log("ADD action:", JSON.stringify({ name, opts })));
program.parseAsync(process.argv.slice(2) ? ["node", "facode", ...process.argv.slice(2)] : ["node", "facode", "provider", "add", "x", "--base-url", "https://x/v1", "--api-key", "k", "--model", "m1", "--scope", "project"]);
