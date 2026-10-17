# xKiro

xKiro is a first-class provider using documented endpoints:

- Base URL and OpenAI-compatible chat completions
- Bearer token + `x-api-key` header
- Public model catalog
- `count_tokens` endpoint
- Usage: `GET /v1/usage`

xKiro is **not** marked verified unless an actual successful test against the
live service has been performed. mediaXG parses `/v1/usage` conservatively:
unrecognized shapes return `available: false` with no values rather than
inventing numbers.

`/budget balance` queries only this documented interface.
