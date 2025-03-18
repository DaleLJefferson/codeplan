# RepoQuery

A tool to query your codebase using Anthropic's Claude with full file tree context and specified files.

## Quick Start

```
# Add a .env file with your Anthropic API key or in your environment
ANTHROPIC_API_KEY=your_api_key_here

# Create a prompt.md file in your project
echo "Tell me about the codebase" > prompt.md

# Run repoquery
bunx repoquery
```

## Installation

```bash
bun install -g repoquery
```

**Note:** This tool requires [Bun](https://bun.sh) and does not support Node.js.

## Usage

1. Create a `prompt.md` file in your project:

```markdown
---
include:
  - "src/**/*.ts" # Include TypeScript files in src
  - "package.json" # Include package.json
ignore:
  - "src/tests/**" # Ignore test files
---

Tell me about the codebase
```

2. Run in your project directory:

```bash
repoquery

# or with thinking
repoquery --think
```

3. Your response will be in `response.md`

### Options

- `--think`: Show Claude's thinking process
- `--help`: Display help information

## Features

- Full file tree context for better comprehension of your codebase
- Select files to include using glob patterns
- Gitignore support works automatically (excluded files won't be included)
- Smart token caching

## Requirements

- An Anthropic API key (Claude 3.7 Sonnet)
- Create a `.env` file with:

```
ANTHROPIC_API_KEY=your_api_key_here
```

## Cost Considerations

This tool uses Claude 3.7 Sonnet with a large context window, which can be expensive to run. The tool optimizes token usage by:

- Using prompt caching where possible
- Prioritizing recently modified files
- Calculating and displaying token usage and costs

The tool will show you token counts before making API calls and requires confirmation to proceed.
