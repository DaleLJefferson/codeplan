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

const encoding = get_encoding("cl100k_base");

// Create a wrapped version that adds padding to account for discrepancies
function countTokens(text: string): number {
  return encoding.encode(text).length * 1.3;
}

const systemPrompt = `You are software architect, respond to the users request in a single interaction (don't ask follow up questions). 
You have a complete file tree, and the contents of relevant files (other files exist as per the file tree) to aid you in your response.
Always include a comprehensive and detailed overview "Goal" of the users request at the beginning of your response.
Always include the file paths when you reference a file.
If changes to the codebase are required your role is to provide a comprehensive and detailed plan which another developer (or AI assistant) can follow, ensure they have all the information they need assume they know nothing about the codebase.
Provide a list of files that need to be read to understand your response with comments explaining why each file needs to be read or modified.
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
  if (existsSync(RESPONSE_FILE)) {
    await fs.unlink(RESPONSE_FILE);
  }

  if (!existsSync(PROMPT_FILE)) {
    console.error(`\x1b[31mError: No ${PROMPT_FILE} file found\x1b[0m`);
    console.error(
      `Please create a ${PROMPT_FILE} file with your query and any file include/ignore patterns.`
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

  const promptFile = await Bun.file(PROMPT_FILE).text();
  const {
    data: { include = [], ignore = [] },
    content: prompt,
  } = matter(promptFile);

  // Check if include patterns are provided
  if (include.length === 0) {
    console.error("\x1b[31mError: No files have been included\x1b[0m");
    console.error(
      "Please specify files to include in your prompt.md file using the frontmatter format:"
    );
    console.error(`
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
        max_tokens: 128_000,
        temperature: 0,
        thinking: think
          ? {
              type: "enabled",
              budget_tokens: 32_000,
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
