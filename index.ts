#!/usr/bin/env bun

import Anthropic from "@anthropic-ai/sdk";
import { existsSync } from "fs";
import type { Usage } from "@anthropic-ai/sdk/resources/index.mjs";
import { promises as fs } from "fs";
import { globby } from "globby";
import matter from "gray-matter";
import { countTokens as originalCountTokens } from "@anthropic-ai/tokenizer";
import { parseArgs } from "util";

const DEBUG = false;
const PROMPT_FILE = "prompt.md";
const RESPONSE_FILE = "response.md";

// Parse command line arguments
const { values } = parseArgs({
  args: Bun.argv,
  options: {
    think: {
      type: "boolean",
    },
    help: {
      type: "boolean",
    },
  },
  strict: false,
});

// Show help if requested
if (values.help) {
  console.log("Usage: codeplan [options]");
  console.log("");
  console.log("Options:");
  console.log("  --think     Show Claude's thinking process");
  console.log("  --help      Show this help message");
  process.exit(0);
}

// Default to not showing thinking output
const think = values.think || false;

// Pricing constants per million tokens
const INPUT_PRICE_PER_M = 3.0;
const CACHE_WRITE_PRICE_PER_M = 3.75;
const CACHE_READ_PRICE_PER_M = 0.3;
const OUTPUT_PRICE_PER_M = 15.0;

// Create a wrapped version that adds padding to account for discrepancies
function countTokens(text: string): number {
  const tokenCount = originalCountTokens(text);
  // Add padding based on observed discrepancy
  return Math.ceil(tokenCount * 1.15);
}

const systemPrompt = `You are software architect, respond to the users request in a single interaction (don't ask follow up questions). 
You have a complete file tree, and the contents of relevant files (other files exist as per the file tree) to aid you in your response.
Always include a comprehensive and detailed overview "Goal" of the users request at the beginning of your response.
Always include the file paths when you reference a file.
If changes to the codebase are required your role is to provide a comprehensive and detailed plan which another developer (or AI assistant) can follow, ensure they have all the information they need assume they know nothing about the codebase.
Provide a list of files that need to be read to understand your response with comments explaining why each file needs to be read or modified.
`;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

type Tree = {
  [key: string]: Tree;
};

function formatFilesContent(path: string, content: string): string {
  return `<file path="${path}">\n${content}\n</file>`;
}

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

function printTreeWithTokens(
  tree: Tree,
  filesWithTokens: Map<string, number>,
  path: string = "",
  indent: string = ""
): string {
  if (Object.keys(tree).length === 0) {
    return "";
  }
  let result = "";
  Object.keys(tree)
    // Sort by descending token count
    .sort((a, b) => {
      const fullPathA = path ? `${path}/${a}` : a;
      const fullPathB = path ? `${path}/${b}` : b;
      const tokensA = filesWithTokens.get(fullPathA) || 0;
      const tokensB = filesWithTokens.get(fullPathB) || 0;
      return tokensB - tokensA;
    })
    .forEach((key) => {
      const fullPath = path ? `${path}/${key}` : key;
      const tokens = filesWithTokens.get(fullPath);
      const tokenDisplay = tokens ? ` (${(tokens / 1000).toFixed(2)}k)` : "";
      result += `${indent}- ${key}${tokenDisplay}\n`;
      result += printTreeWithTokens(
        tree[key] ?? {},
        filesWithTokens,
        fullPath,
        indent + " "
      );
    });
  return result;
}

async function getFilesPaths(
  include: Array<string>,
  ignore: Array<string> = []
): Promise<Array<string>> {
  return await globby(include, {
    gitignore: true,
    ignore,
  }).then((files) => files.sort());
}

type FileData = {
  path: string;
  lastModified: number;
  content: string;
  tokens: number;
};

async function getFilesWithContent(
  include: Array<string>,
  ignore: Array<string>
): Promise<Array<FileData>> {
  const files = await getFilesPaths(include, ignore);

  const fileData = await Promise.all(
    files.map(async (path: string) => {
      const file = Bun.file(path);
      const [{ content, tokens }, lastModified] = await Promise.all([
        file
          .text()
          .then((content) => formatFilesContent(path, content))
          .then((content) => ({ content, tokens: countTokens(content) })),
        file.lastModified,
      ]);
      return {
        path,
        lastModified,
        content,
        tokens,
      };
    })
  );

  return fileData;
}

function splitFilesByDate(files: Array<FileData>): {
  today: Array<FileData>;
  lastWeek: Array<FileData>;
  before: Array<FileData>;
} {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  const today = files.filter(
    (file: { lastModified: number }) => now - file.lastModified < dayMs
  );
  const lastWeek = files.filter(
    (file: { lastModified: number }) =>
      now - file.lastModified >= dayMs && now - file.lastModified < 7 * dayMs
  );
  const before = files.filter(
    (file: { lastModified: number }) => now - file.lastModified >= 7 * dayMs
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
  // Delete plan.md if it exists
  if (existsSync(RESPONSE_FILE)) {
    await fs.unlink(RESPONSE_FILE);
  }

  function printLargestFiles(
    files: Array<FileData>,
    count: number = 5
  ): string {
    const sortedFiles = [...files].sort((a, b) => b.tokens - a.tokens);
    const top = sortedFiles.slice(0, count);

    let result = `\nTop ${count} largest files by token count:\n\n`;
    top.forEach((file, index) => {
      result += `${index + 1}. ${file.path}: ${(file.tokens / 1000).toFixed(
        2
      )}k tokens\n`;
    });

    return result;
  }

  if (!existsSync(PROMPT_FILE)) {
    console.log(`No ${PROMPT_FILE} file found`);

    process.exit(1);
  }

  const promptFile = await Bun.file(PROMPT_FILE).text();
  const {
    data: { include = [], ignore = [] },
    content: prompt,
  } = matter(promptFile);

  await Bun.write(Bun.stdout, `\nThinking: ${think ? "on" : "off"}\n`);
  await Bun.write(Bun.stdout, `Include: ${include.join(", ")}\n`);
  await Bun.write(Bun.stdout, `Ignore: ${ignore.join(", ")}\n\n`);

  // We want to include all files in the file tree
  const allFiles = await getFilesPaths(["**"]);

  const tree = createTree(allFiles);

  const filesWithContent = await getFilesWithContent(include, ignore);

  // Create a map of file paths to token counts
  const tokenMap = new Map<string, number>();
  filesWithContent.forEach((file) => {
    tokenMap.set(file.path, file.tokens);
  });

  const selectedFiles = printTreeWithTokens(
    createTree(filesWithContent.map((file) => file.path)),
    tokenMap
  );

  const { today, lastWeek, before } = await splitFilesByDate(filesWithContent);

  await Bun.write(Bun.stdout, `Selected files:\n\n${selectedFiles}`);

  // Output the largest 5 files
  await Bun.write(Bun.stdout, `${printLargestFiles(filesWithContent)}\n`);

  // Calculate total tokens from all files
  const totalTokens = filesWithContent.reduce(
    (sum, { tokens }) => sum + tokens,
    0
  );

  const promptText = `<user_prompt>${prompt}</user_prompt>`;
  const fileTreeText = `<file_tree>\n${printTree(tree)}\n</file_tree>`;
  const todayText = today.map(({ content }) => content).join("\n");
  const lastWeekText = lastWeek.map(({ content }) => content).join("\n");
  const beforeText = before.map(({ content }) => content).join("\n");

  // Calculate tokens in the tree representation
  const treeTokens = countTokens(fileTreeText);
  const promptTokens = countTokens(promptText);

  await Bun.write(
    Bun.stdout,
    `File content tokens: ${(totalTokens / 1000).toFixed(2)}k\n` +
      `Tree tokens: ${(treeTokens / 1000).toFixed(2)}k\n` +
      `Total tokens: ${(
        (totalTokens + treeTokens + promptTokens) /
        1000
      ).toFixed(2)}k of 200.0k\n\n`
  );

  if (DEBUG) {
    await Bun.write(Bun.stdout, `${promptText}\n`);
    await Bun.write(Bun.stdout, `${fileTreeText}\n`);
    await Bun.write(Bun.stdout, `${todayText}\n`);
    await Bun.write(Bun.stdout, `${lastWeekText}\n`);
    await Bun.write(Bun.stdout, `${beforeText}\n`);
  }

  // Ask for user confirmation before proceeding
  await Bun.write(Bun.stdout, "Continue? (y/n): ");

  for await (const chunk of Bun.stdin.stream()) {
    const response = Buffer.from(chunk).toString().trim().toLowerCase();

    if (response === "y") {
      await Bun.write(Bun.stdout, "Making request...\n");
      break;
    } else if (response === "n") {
      await Bun.write(Bun.stdout, "Stopping...\n");
      process.exit(0);
    } else {
      await Bun.write(Bun.stdout, "Invalid input, please use y or n\n");
      continue;
    }
  }

  let state: "thinking" | "text" | null = null;

  const message = await anthropic.messages
    .stream(
      {
        system: systemPrompt,
        max_tokens: 128_000,
        thinking: think
          ? {
              type: "enabled",
              budget_tokens: 32_000,
            }
          : undefined,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text" as const,
                text: beforeText,
                cache_control: { type: "ephemeral" as const },
              },
              {
                type: "text" as const,
                text: lastWeekText,
                cache_control: { type: "ephemeral" as const },
              },
              {
                type: "text" as const,
                text: todayText,
                cache_control: { type: "ephemeral" as const },
              },
              {
                type: "text" as const,
                text: fileTreeText,
                cache_control: { type: "ephemeral" as const },
              },
              {
                type: "text" as const,
                text: promptText,
              },
            ].filter((block) => block.text.length > 0),
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
      } else if (!state) {
        state = "text";
      }

      await Bun.write(Bun.stdout, textDelta);
    })
    .finalMessage();

  const usage = calculateTokenUsageAndCost(message.usage);

  const outputText = `\n\n
---------------------------
Tokens: ↑ ${(usage.inputTokens / 1000).toFixed(2)}k ↓ ${(
    usage.outputTokens / 1000
  ).toFixed(2)}k
Cache: ⊕ +${(usage.cacheCreationTokens / 1000).toFixed(2)}k → ${(
    usage.cacheReadTokens / 1000
  ).toFixed(2)}k
Context: ${(usage.totalInputTokens / 1000).toFixed(1)}k of 200.0k
Cost: $${usage.totalCost.toFixed(4)}
---------------------------
\n
`;

  await Bun.write(Bun.stdout, outputText);

  // Write the message content to plan.md
  const contentText = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");

  await Bun.write("response.md", contentText);

  console.log("Result written to response.md");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
