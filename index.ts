#!/usr/bin/env bun

import Anthropic from "@anthropic-ai/sdk";
import { parseArgs } from "util";
import { existsSync } from "fs";
import type { Usage } from "@anthropic-ai/sdk/resources/index.mjs";
import { promises as fs } from "fs";
import { globby } from "globby";

const systemPrompt = `
# You

You are a senior software architect specializing in code design and implementation planning.
You have been provided with a full file list, and the contents of the most pertinent files (many other files exist in the project).
You are an advocate of Clean Code and SOLID principles.

# Your team

You lead a team of specialist software developers who are experts in their respective fields.
They have little knowledge of the overall project, only you have full access to the complete codebase, knowledge of the project's architecture and the business requirements.
Your team will need detailed instructions on what needs to be done to achieve the desired outcome and how to ensure good software design.

# Goal

Create a detailed implementation plan that includes:
  - Files that need to be read to understand the changes
  - Files that need to be modified
  - Specific code sections requiring changes
  - New functions, methods, or classes to be added
  - Dependencies or imports to be updated
  - Data structure modifications
  - Interface changes
  - Configuration updates
  - Commands that should be invoked

# Output

- Your response should be aimed at your team of developers not at the user, don't ask follow up questions.
- Use the plan template below to structure your response.

# Plan Template

## Overview

What we are trying to achieve, the goal of the changes.
High level overview of the changes that need to be made and why they are needed.

## File Tree

- folder
  - other.rs // Comment explaining why this file needs to be read
  - file.rs // Comment explaining the changes that need to be made

## Steps

### Step 1

- Describe the exact location in the code where changes are needed
- Explain the logic and reasoning behind each modification
- Note any potential side effects or impacts on other parts of the codebase
- Highlight critical architectural decisions that have been made and need to be validated during implementation.

#### folder/file.rs

// Code snippet, explaining the changes that need to be made

## Validation

// Commands to run to validate the changes

## Gotchas

- Any potential pitfalls or issues that you can foresee that the developers should be aware of.
- Any external validation/testing that needs to be done.
`;

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

async function getFilesPaths(patterns: Array<string>): Promise<Array<string>> {
  return await globby(patterns, {
    gitignore: true,
  });
}

type FileData = {
  path: string;
  lastModified: number;
  content: string;
};

async function getFilesWithContent(
  patterns: Array<string>
): Promise<Array<FileData>> {
  const files = await getFilesPaths(patterns);

  const fileData = await Promise.all(
    files.map(async (path: string) => {
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

function formatFilesContent(files: FileData[]): string {
  return files
    .map((file) => `<file path="${file.path}">\n${file.content}\n</file>`)
    .join("\n");
}

async function main() {
  const args = Bun.argv.slice(2);

  console.log(args);

  const { values } = parseArgs({
    args,
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

  console.log(patterns);

  if (patterns.length === 0) {
    console.log(
      "Usage: bun run index.ts --include <glob1> [--include <glob2>] ..."
    );
    process.exit(1);
  }

  // We want to include all files in the file tree
  const allFiles = await getFilesPaths(["**"]);

  const tree = createTree(allFiles);

  const filesWithContent = await getFilesWithContent(patterns);

  const selectedFiles = printTree(
    createTree(filesWithContent.map((file) => file.path))
  );

  const { today, lastWeek, before } = await splitFilesByDate(filesWithContent);

  const todayContents = formatFilesContent(today);
  const lastWeekContents = formatFilesContent(lastWeek);
  const beforeContents = formatFilesContent(before);

  const promptFilePath = "prompt.md";

  if (!existsSync(promptFilePath)) {
    console.log(`No ${promptFilePath} file found`);
    return;
  }

  const promptText = await Bun.file(promptFilePath).text();

  await Bun.write(Bun.stdout, `Selected files:\n\n${selectedFiles}\n\n`);

  // console.log(promptText);
  // console.log(printTree(tree));
  // console.log(todayContents, lastWeekContents, beforeContents);

  let state: "thinking" | "text" | null = null;

  const maxTokens = 128000;

  const message = await anthropic.messages
    .stream(
      {
        system: systemPrompt,
        max_tokens: maxTokens,
        thinking: {
          type: "enabled",
          budget_tokens: maxTokens - 1024,
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
