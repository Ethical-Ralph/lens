# lens

Code for [*Agents in Production*](https://loopandtools.dev/agents-in-production/), a free online book from [Loop & Tools](https://loopandtools.dev), and for articles by [EthicalRalph](https://blog.ethicalralph.me): building and deploying AI agents that hold up in production.

## Layout

```
agents-in-production/      # the book: one folder per chapter, named like the chapter URL
  testbed/                 # the shared system every chapter's code runs against (its README is the spec)
  NN-<slug>/               # one folder per chapter: implementations, checks, experiments, raw results
standalone/<post-slug>/    # code for one-off articles
```

Each folder is **self-contained**: its own `README.md`, dependencies, and run instructions. Book folders hold each chapter's experiment scripts, pinned versions and raw results, so any experiment can be re-run.

## Running

Every folder's README lists its requirements. API keys always come from environment variables. Copy `.env.example` to `.env` and fill it in. Never commit `.env`.

## License

MIT
