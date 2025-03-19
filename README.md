# RepoQuery

A tool to query your codebase using Anthropic's Claude with full file tree context and your whole repository as context.

**Use the whole 200k token context window and full power of Claude 3.7 Extended Thinking.**

- Ask questions about the whole codebase
- Create a detailed implementation plan to hand to Cursor/Windsurf or another AI code editor

![Overview](https://github.com/DaleLJefferson/repoquery/blob/main/img/overview.png)

## Why?

AI Code Editors are great, but to offer a $20 a month subscription they have to severely limit the context window. They load a few lines from a few files and that's it.
The chat interface for ChatGPT, Claude, Grok are limited to ~20k tokens and start to summarise, truncate or refuse to answer.

This tool (at a cost [API usage fees]) give you access to the full context window 200K without restrictions, to answer full codebase questions or generate complex plans spanning multiple files.

## Warning

This tool is experimental, it will have bugs, ensure you update to the latest version and post an issue on [GitHub](https://github.com/DaleLJefferson/repoquery/issues).

## Installation

```bash
bun install -g repoquery
```

**Note:** This tool requires [Bun](https://bun.sh) and does not support Node.js.

## Usage

1. Create a `query.md` file in your project:

```markdown
---
include:
  - "src/**/*.ts"
  - "package.json"
ignore:
  - "src/tests/**"
---

Tell me about the codebase
```

2. Run repoquery in your project directory:

```bash
repoquery

# or with thinking
repoquery --think
```

### Options

- `--think`: Show Claude's thinking process
- `--help`: Display help information
- `--out`: Write response to response.md file

## Features

- Full file tree context for better comprehension of your codebase
- Include using glob patterns
- Gitignore support works automatically (excluded files won't be included)
- Cursor rules automatically added to prompt
- Smart token caching

## Requirements

- An Anthropic API key (Claude 3.7 Sonnet)
- Create a `.env` file with:

```bash
ANTHROPIC_API_KEY=your_api_key_here
```

## Cost Considerations

This tool uses Claude 3.7 Sonnet with a large context window, which can be expensive to run. The tool optimizes token usage by:

- Using prompt caching where possible
- Prioritizing recently modified files
- Calculating and displaying token usage and costs

The tool will show you token counts before making API calls and requires confirmation to proceed.
