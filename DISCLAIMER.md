# Disclaimer

The main source code is under MIT License — see [`LICENSE.txt`](LICENSE.txt),

## Scope

This project is an experimental, unaudited hobby project, not a supported product.

## API costs are optional and entirely your responsibility

- An API key is **optional**. The app runs with no API key and no cost via `MOCK=true` (see
  the [README](README.md#mock--debug-mode)).
- If you choose to configure a real API key, you are solely responsible for: any charges
  incurred, capping your own spend with a provider-side spend limit on that key, and
  monitoring the running process.
- This codebase has not been audited or certified against bugs that could cause unintended,
  excessive, or looping API calls. Use of a real API key is at your own risk.
- The LLM and TTS models are configurable (`OPENROUTER_LLM_MODEL`, `OPENROUTER_TTS_MODEL`)
  and have independently varying prices that can change over time. Check OpenRouter's
  current pricing for whichever model you use — including the defaults — before running
  this against a real API key.
