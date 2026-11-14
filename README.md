# Free Model Aggregator

One server that serves the OpenAI Chat Completions API and the Anthropic Messages API
(JSON and server-sent events) over ten simulated free-tier model providers, routing each
request to the best-rated free model that can serve it, and failing over when a provider
refuses.

## Run

```sh
node main.ts            # serve a trial (needs MAKEFUN_ENV_URL + MAKEFUN_PROMPT_FILE)
node main.ts --list     # print the catalog document and exit 0
```

Node 22 standard library only; nothing is installed. The entrypoint is `main.ts`.

## How it works

1. **Brief.** The trial's brief (`MAKEFUN_PROMPT_FILE`) carries the provider directory
   (ids, wires, auth schemes, base paths, keys), the quality table (each free model's
   rating, context length, and tools/vision/JSON capabilities), and the workload
   manifest (the 20 requests, in order, with their requirements).
2. **Catalog.** Each provider's catalog route is probed in its own wire (OpenAI,
   Anthropic, or Gemini) and the answers are merged with the quality table into the one
   catalog document this server registers with the env and prints with `--list`. A
   provider whose probe fails still appears, with the quality table's free models.
3. **Routing.** For each request, the candidates are the free models meeting its
   requirements, on wires that can carry the request without losing a field (see
   below), ranked by rating. The best is tried first; a refusal (402/429/5xx) fails
   over at once. The first candidate gets one same-provider retry, because providers
   refuse one-off calls on a schedule — unless the refusal's own message says the provider
   is done for the trial ("budget is spent" or "is out"), in which case it is marked dead
   at once and never retried. Any other provider is only demoted after three failures
   in a row — at most two refusals per provider are ever scheduled, so three in a row
   means its budget is spent or its outage has begun. Equal ratings spread toward the
   least-used provider.
4. **Echo-safe translation.** Every provider echoes what it parsed (system/user text,
   tools, max_tokens, stop sequences, image, JSON mode) and the client compares that
   echo with what it sent. Before a request is sent on a foreign wire, it is rendered
   to that wire, parsed back with the wire's own rules, and the echo must match the
   client's exactly. A wire that cannot carry a field — Anthropic cannot carry JSON
   mode — is never picked for a request that needs it. Same-wire requests pass the
   client's body through untouched.
5. **Answers.** The one successful provider call's text, usage, and stop reason are
   returned in the client's wire, streamed or not as asked, with the stop reason
   mapped across the wires' spellings. Usage comes from the provider's own numbers
   when it reports them, else from the same deterministic formula the provider uses.
6. **Exit.** The server polls the env's `/work` route and exits 0 when the workload
   is done. Everything is deterministic — fixed ids and timestamps, no clock, no
   randomness — so a replay leaves the same state export byte for byte.

## Layout

- `main.ts` — the whole server: brief, catalog, translation, routing, wires.
- `LICENSE` — MIT.
