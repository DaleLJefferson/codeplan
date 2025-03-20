#!/usr/bin/env bun

import Anthropic from "@anthropic-ai/sdk";
import { existsSync } from "fs";
import type {
  MessageParam,
  TextBlockParam,
  Usage,
} from "@anthropic-ai/sdk/resources/index.mjs";
import { promises as fs } from "fs";
import { globby } from "globby";
import matter from "gray-matter";
import { parseArgs } from "util";
import { get_encoding } from "tiktoken";
import { performance } from "node:perf_hooks";
import util from "util";

const DEBUG = false;
const PROMPT_FILES = ["query.md", "prompt.md"];
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
    out: {
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
  console.log("  --out       Write response to response.md file");
  console.log("  --help      Show this help message");
  process.exit(0);
}

// Default to not showing thinking output
const think = values.think || false;
const writeOutput = values.out || false;

const THINK_BUDGET = 32_000;
const MAX_TOKENS = 64_000;

// Pricing constants per million tokens
const INPUT_PRICE_PER_M = 3.0;
const CACHE_WRITE_PRICE_PER_M = 3.75;
const CACHE_READ_PRICE_PER_M = 0.3;
const OUTPUT_PRICE_PER_M = 15.0;

const encoding = get_encoding("cl100k_base");

// Create a wrapped version that adds padding to account for discrepancies
function countTokens(text: string): number {
  return encoding.encode(text).length * 1.3;
}

const systemPrompt = `You are an AI assistant specialized in software architecture.
You have a complete file tree, and the contents of relevant files (other files exist as per the file tree) to aid you in your response.

- Don't make assumptions based on file names alone, having the actual file content is imperative.
- Don't mention the modes but use them to guide your response.
- Always include a confidence percentage at the beginning of your response.

You will respond using one of the following modes:
1. Ask: You will respond to the users request using your knowledge of the codebase to answer the users question.
2. Context: You will tell the user you do not have enough information to answer their request, and they must repeat their request with more context.
3. Plan: You will output an implementation plan to implement the users request.

You will be given a user request, and you will need to determine which mode to operate in.

- If the user request is a question, you will respond using ask mode.
- If you need information to answer the users request, you will respond using context mode.
- If the users request is not clear or you need to clarify the requirements you must respond using context mode.
- If you need additional file content to answer the users request you must respond using context mode.
- If the plan involves updating a file, ensure you have the file content, if not respond using context mode.
- If the user request is to implement something, and you are absolutely certain (>95% confident) you have enought information you must respond using plan mode.

<modes>
<ask>
You are responding directly to the user, you will repeat the users question in your own words and then respond with your answer.
</ask>

<context>
You will respond telling the user what information they need to include the next time they make a request, when the user does make a new request it will be answered by another AI assistant who will not have the information you have from the first request.

When asking for file content, use the following syntax, mention "here is the new complete include list you should use". 

\`\`\`yaml
include:
  - file1.sql
  - folder/file2.sql
  - "folder/**"
  - "**/*.ts"
\`\`\`

- Ensure you include all file paths not just the additional ones.
- Try to consolidate the include list, using wildcard globbing to fetch whole directories or filetypes.
- Never ask for files that don't exist in the file tree.
- Aim to have a complete understanding of the codebase, overfetching is better than underfetching.
- Don't waste the users time by being conservative with the file content, more is better attempt to request everything you need in one go.
</context>

<plan>
- You will respond with a detailed implementation plan not for the user but for another AI assistant who will implement the plan.
- The AI assistant is a specialist software developer, their coding skills are superiour to yours, but they and will have no knowledge of the codebase or requirements other than what you provide, and lack the software architecture skills you have.
- Start the plan with a comprehensive and detailed overview "Goal" of what needs to be done and how the AI assistant will know when it is complete (Acceptance Criteria).
- Always include a file tree with a description of each file.
- Then provide all the context they need to successfully complete the plan. Include requirements details, key rules, design decisions, and any other information you have that will help them complete the plan.
- Break the plan into named steps with descriptions of what needs to be done, provide all the information needed to complete the step, restrict code snippets to providing examples especially where the AI assistant (without it's full codebase knowledge) would likely make mistakes.
</plan>
</modes>
`;

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
      result += `${indent}${key}\n`;
      result += printTree(tree[key] ?? {}, indent + "  ");
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
      result += `${indent}${key}${tokenDisplay}\n`;
      result += printTreeWithTokens(
        tree[key] ?? {},
        filesWithTokens,
        fullPath,
        indent + "  "
      );
    });
  return result;
}

async function getFilesPaths(
  include: Array<string>,
  ignore: Array<string> = []
): Promise<Array<string>> {
  if (include.length === 0) {
    return [];
  }

  return await globby(include, {
    gitignore: true,
    ignore,
    followSymbolicLinks: false,
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

  return await Promise.all(
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

function printLargestFiles(files: Array<FileData>, count: number = 5): string {
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

async function main() {
  performance.mark("start");

  // Check if ANTHROPIC_API_KEY is set Anthropic() automatically reads it
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("\x1b[31mError: ANTHROPIC_API_KEY is not set\x1b[0m");
    console.error(
      "Please set your Anthropic API key in one of the following ways:"
    );
    console.error(
      "  1. Create a .env file with ANTHROPIC_API_KEY=your_api_key_here"
    );
    console.error(
      "  2. Export it in your shell: export ANTHROPIC_API_KEY=your_api_key_here"
    );
    process.exit(1);
  }

  const anthropic = new Anthropic();

  // Delete plan.md if it exists
  if (existsSync(RESPONSE_FILE) && writeOutput) {
    await fs.unlink(RESPONSE_FILE);
  }

  // Find the first existing prompt file
  const existingPromptFile = PROMPT_FILES.find((file) => existsSync(file));

  if (!existingPromptFile) {
    console.error(`\x1b[31mError: No query file found\x1b[0m`);
    console.error(
      `Please create a query.md file with your query and any file include/ignore patterns.`
    );
    console.error(`Example:
---
include:
  - "src/**/*.ts"
  - "package.json"
ignore:
  - "src/tests/**"
---

Tell me about the codebase
`);
    process.exit(1);
  }

  const promptFile = await Bun.file(existingPromptFile).text();
  const { data, content: prompt } = matter(promptFile);

  const include = data.include || [];
  const ignore = data.ignore || [];

  await Bun.write(Bun.stdout, `\nThinking: ${think ? "on" : "off"}\n`);
  await Bun.write(Bun.stdout, `Include: ${include.join(", ")}\n`);
  await Bun.write(Bun.stdout, `Ignore: ${ignore.join(", ")}\n\n`);
  await Bun.write(Bun.stdout, `Reading Files...\n\n`);

  // We want to include all files in the file tree
  const [tree, filesWithContent, rulesWithContent] = await Promise.all([
    getFilesPaths(["**"]).then(createTree),
    getFilesWithContent(include, ignore),
    getFilesWithContent([".cursor/rules/**/*.mdc"], []),
  ]);

  // Create a map of file paths to token counts
  const filesTokenMap = new Map<string, number>();

  filesWithContent.forEach((file) => {
    filesTokenMap.set(file.path, file.tokens);
  });

  const selectedFiles = printTreeWithTokens(
    createTree(filesWithContent.map((file) => file.path)),
    filesTokenMap
  );

  const rulesTokenMap = new Map<string, number>();

  rulesWithContent.forEach((file) => {
    rulesTokenMap.set(file.path, file.tokens);
  });

  const selectedRules = printTreeWithTokens(
    createTree(rulesWithContent.map((file) => file.path)),
    rulesTokenMap
  );

  await Bun.write(Bun.stdout, `Rules:\n\n${selectedRules}\n`);
  await Bun.write(Bun.stdout, `Files:\n\n${selectedFiles}\n`);

  // Output the largest 5 files
  await Bun.write(
    Bun.stdout,
    `${printLargestFiles([...filesWithContent, ...rulesWithContent])}\n`
  );

  const rulesText = `<rules>${rulesWithContent
    .map(({ content }) => content)
    .join("\n")}\n}</rules>`;
  const fileTreeText = `<file_tree>\n${printTree(tree)}\n</file_tree>`;
  const filesText = `<files>\n${filesWithContent
    .map(({ content }) => content)
    .join("\n")}\n</files>`;
  const promptText = `<user_prompt>${prompt}</user_prompt>`;

  const system: Array<TextBlockParam> = [
    {
      type: "text",
      text: systemPrompt,
      cache_control: { type: "ephemeral" },
    },
  ];

  const messages: Array<MessageParam> = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: rulesText,
          cache_control: { type: "ephemeral" },
        },
        {
          type: "text",
          text: fileTreeText,
          cache_control: { type: "ephemeral" },
        },
        {
          type: "text",
          text: filesText,
          cache_control: { type: "ephemeral" },
        },
        {
          type: "text",
          text: promptText,
        },
      ],
    },
  ];

  const totalTokens = await anthropic.messages
    .countTokens({
      system,
      messages,
      model: "claude-3-7-sonnet-20250219",
    })
    .then(({ input_tokens }) => input_tokens);

  await Bun.write(
    Bun.stdout,
    `Tokens: ${(totalTokens / 1000).toFixed(2)}k of 200.0k\n\n`
  );

  if (DEBUG) {
    console.log(
      util.inspect(system, { showHidden: false, depth: null, colors: true })
    );
    console.log(
      util.inspect(messages, { showHidden: false, depth: null, colors: true })
    );
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
        system,
        max_tokens: MAX_TOKENS,
        temperature: think ? 1 : 0,
        thinking: think
          ? {
              type: "enabled",
              budget_tokens: THINK_BUDGET,
            }
          : undefined,
        messages,
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

  // Write the message content to response.md if output flag is set
  const contentText = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");

  if (writeOutput) {
    await Bun.write(RESPONSE_FILE, contentText);
    console.log(`Result written to ${RESPONSE_FILE}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
