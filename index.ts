import Anthropic from "@anthropic-ai/sdk";
import { parseArgs } from "util";
import { existsSync } from "fs";
import type { Usage } from "@anthropic-ai/sdk/resources/index.mjs";
import { promises as fs } from "fs";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Pricing constants per million tokens
const INPUT_PRICE_PER_M = 3.0;
const CACHE_WRITE_PRICE_PER_M = 3.75;
const CACHE_READ_PRICE_PER_M = 0.3;
const OUTPUT_PRICE_PER_M = 15.0;

type Tree = {
  [key: string]: Tree;
};

function createTree(paths: string[]): Tree {
  const tree: Tree = {};
  paths.forEach((path) => {
    const parts = path.split("/").filter((part) => part !== "");
    let current = tree;
    parts.forEach((part) => {
      // Ensure current[part] is defined before proceeding
      current[part] = current[part] || {};
      current = current[part];
    });
  });
  return tree;
}

function printTree(tree: Tree, indent: string = ""): string {
  if (Object.keys(tree).length === 0) {
    return "";
  }
  let result = "";
  Object.keys(tree)
    .sort()
    .forEach((key) => {
      result += `${indent}- ${key}\n`;
      result += printTree(tree[key] ?? {}, indent + " ");
    });
  return result;
}

function getGitIndexFiles(patterns: Array<string>): Array<string> {
  const result = Bun.spawnSync(["git", "ls-files", "-z", "--", ...patterns], {
    cwd: process.cwd(),
  });

  if (!result.success) {
    throw new Error(`Git command failed: ${result.stderr.toString()}`);
  }

  const output = result.stdout.toString();
  return output.split("\0").filter((file) => file !== "");
}

async function getFilesWithContent(patterns: Array<string>): Promise<{
  today: Array<{ path: string; lastModified: number; content: string }>;
  lastWeek: Array<{ path: string; lastModified: number; content: string }>;
  before: Array<{ path: string; lastModified: number; content: string }>;
}> {
  const files = await Bun.readableStreamToText(
    await Bun.spawn(["git", "ls-files", ...patterns]).stdout
  ).then((text) => text.split("\n").filter(Boolean));

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  const fileData = await Promise.all(
    files.map(async (path) => {
      const file = Bun.file(path);
      const [content, lastModified] = await Promise.all([
        file.text(),
        file.lastModified,
      ]);
      return {
        path,
        lastModified,
        content,
      };
    })
  );

  const today = fileData.filter((file) => now - file.lastModified < dayMs);
  const lastWeek = fileData.filter(
    (file) =>
      now - file.lastModified >= dayMs && now - file.lastModified < 7 * dayMs
  );
  const before = fileData.filter(
    (file) => now - file.lastModified >= 7 * dayMs
  );

  return { today, lastWeek, before };
}

function calculateTokenUsageAndCost({
  input_tokens,
  cache_creation_input_tokens,
  cache_read_input_tokens,
  output_tokens,
}: Usage) {
  const inputTokens = input_tokens;
  const cacheCreationTokens = cache_creation_input_tokens ?? 0;
  const cacheReadTokens = cache_read_input_tokens ?? 0;
  const outputTokens = output_tokens;

  // Calculate costs
  const inputCost = (inputTokens / 1000000) * INPUT_PRICE_PER_M;
  const cacheWriteCost =
    ((cacheCreationTokens ?? 0) / 1000000) * CACHE_WRITE_PRICE_PER_M;
  const cacheReadCost =
    ((cacheReadTokens ?? 0) / 1000000) * CACHE_READ_PRICE_PER_M;
  const outputCost = (outputTokens / 1000000) * OUTPUT_PRICE_PER_M;
  const totalCost = inputCost + cacheWriteCost + cacheReadCost + outputCost;

  return {
    totalInputTokens: inputTokens + cacheCreationTokens + cacheReadTokens,
    inputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    outputTokens,
    inputCost,
    cacheWriteCost,
    cacheReadCost,
    outputCost,
    totalCost,
  };
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      include: {
        type: "string",
        multiple: true,
      },
    },
    strict: false,
    allowPositionals: true,
  });

  // Delete plan.md if it exists
  if (existsSync("plan.md")) {
    await fs.unlink("plan.md");
  }

  const patterns = (values.include as Array<string>) || [];

  if (patterns.length === 0) {
    console.log(
      "Usage: bun run index.ts --include <glob1> [--include <glob2>] ..."
    );
    process.exit(1);
  }

  const allFiles = getGitIndexFiles([]);

  const tree = createTree(allFiles);

  const { today, lastWeek, before } = await getFilesWithContent(patterns);

  const todayContents = today
    .map((file) => `<file path="${file.path}">\n${file.content}\n</file>`)
    .join("\n");

  const lastWeekContents = lastWeek
    .map((file) => `<file path="${file.path}">\n${file.content}\n</file>`)
    .join("\n");

  const beforeContents = before
    .map((file) => `<file path="${file.path}">\n${file.content}\n</file>`)
    .join("\n");

  const promptFilePath = "prompt.md";

  if (!existsSync(promptFilePath)) {
    console.log(`No ${promptFilePath} file found`);
    return;
  }

  const promptText = await Bun.file(promptFilePath).text();

  //   console.log(promptText);
  //   console.log(printTree(tree));
  //   console.log(todayContents, lastWeekContents, beforeContents);

  let state: "thinking" | "text" | null = null;

  const message = await anthropic.messages
    .stream(
      {
        system:
          "You are software architect, respond to the users request in a single interaction (don't ask follow up questions). You have a complete file tree, and the contents of relevant files (other files exist as per the file tree) to aid you in your response.",
        max_tokens: 128000,
        thinking: {
          type: "enabled",
          budget_tokens: 32000,
        },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: promptText,
              },
              {
                type: "text",
                text: `<file_tree>\n${printTree(tree)}\n</file_tree>`,
                cache_control: { type: "ephemeral" as const },
              },
              ...[todayContents, lastWeekContents, beforeContents]
                .filter(Boolean)
                .map((content: string) => ({
                  type: "text" as const,
                  text: content,
                  cache_control: { type: "ephemeral" as const },
                })),
            ],
          },
        ],
        model: "claude-3-7-sonnet-20250219",
      },
      {
        headers: {
          "anthropic-beta": "prompt-caching-2024-07-31,output-128k-2025-02-19",
        },
      }
    )
    .on("thinking", async (thinkingDelta) => {
      if (!state) {
        await Bun.write(Bun.stdout, "<THINKING>\n\n");
        state = "thinking";
      }

      await Bun.write(Bun.stdout, thinkingDelta);
    })
    .on("text", async (textDelta) => {
      if (state === "thinking") {
        await Bun.write(Bun.stdout, "\n\n</THINKING>\n\n");
        state = "text";
      }

      await Bun.write(Bun.stdout, textDelta);
    })
    .finalMessage();

  const usage = calculateTokenUsageAndCost(message.usage);

  const outputText = `
-------------------------------
Tokens: ↑ ${(usage.inputTokens / 1000).toFixed(2)}k ↓ ${(
    usage.outputTokens / 1000
  ).toFixed(2)}k
Cache: ⊕ +${(usage.cacheCreationTokens / 1000).toFixed(2)}k → ${(
    usage.cacheReadTokens / 1000
  ).toFixed(2)}k
Context: ${(usage.totalInputTokens / 1000).toFixed(1)}k of 200.0k
Cost: $${usage.totalCost.toFixed(4)}
-------------------------------

`;

  await Bun.write(Bun.stdout, outputText);

  // Write the message content to plan.md
  const contentText = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");

  await Bun.write("plan.md", contentText);

  console.log("Plan written to plan.md");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
