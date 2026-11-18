# Optional Bifrost API gateway

Bifrost can sit behind PugPort's existing **Custom API** connection. It is optional and is not an additional executor. PugPort continues to own task routing, permissions, project context, local budgets and run history; Pi executes the API run; Bifrost forwards model requests to the configured provider.

Use it when several API keys for the **same model** need a common endpoint and pre-output failure recovery. Keep a direct API connection when a gateway adds no benefit. It does not remove native Claude/Codex process startup or session restoration.

## Connect through the existing form

Start a separately installed Bifrost gateway on loopback. Configure its upstream provider and virtual key before adding it in PugPort. Do not expose its management interface to the network as part of this recipe.

Open **Usage & connections → Connections → Add → API → Custom API**:

| Field | Value |
| --- | --- |
| Name | A recognizable gateway/account name |
| Protocol | OpenAI Chat Completions |
| Endpoint | `http://127.0.0.1:<gateway-port>/openai/v1` |
| Key | The gateway's model-scoped virtual key |
| Model | The exact upstream model ID configured in Bifrost |
| Input/output prices | Your provider's USD-per-million-token estimates, if using a local spending limit |

The endpoint above is **client-facing**. For the tested Bifrost OpenAI provider, its upstream `network_config.base_url` is the provider origin: the gateway appends `/v1` itself. Do not accidentally append `/v1` twice. This recipe does not establish compatibility with arbitrary provider-specific path prefixes or Azure deployments.

Keep provider keys in Bifrost's private environment or secret storage. Only the virtual key goes into PugPort. PugPort's existing isolated key storage applies; never put either key in an endpoint URL, checked-in JSON or chat message.

## Keep one owner for each decision

- **Model selection:** keep gateway cross-model fallbacks, adaptive model routing and aliases that change models off. Allow only the selected model in both the provider key and virtual-key configuration. PugPort confirms its configured model; it cannot independently verify an upstream model hidden behind a gateway alias.
- **Retries:** start with Bifrost `max_retries: 0`. Pi currently enables up to three agent-turn retries by default, so a gateway retry count is not a total run-attempt limit. Same-model key rotation can still occur for some provider errors. Bound the configured key pool and account for failed attempts when reviewing provider bills.
- **Tools:** do not configure gateway-side agents or tool execution. PugPort/Pi retains tool permissions and execution. Do not replay tool results from a similarity cache.
- **Logs and caches:** disable Bifrost content/request logging, external logging connectors and caching for this connection. Gateway-local metrics can still exist. The gateway is another process that handles prompts; keep it local and scoped to the intended user.
- **Costs:** enter accurate prices if using PugPort's local budget. Unknown prices remain unknown. Returned usage and local estimates do not independently account for hidden gateway attempts or replace the provider invoice.

## Verified scope

The Windows pilot used pinned Bifrost transport **v2.3.2**, synthetic keys and a strict localhost upstream. Nine checks passed: Chat Completions, Chat SSE, non-streaming Responses, injected 500 recovery, 429 key rotation, model-access key failover, retry bounds, tool-call preservation and stream cancellation. The synthetic recovery fixture used `max_retries: 1`; the optional connection recipe above deliberately starts with zero additional gateway retries.

A separate authenticated, single-key profile passed **11 checks with one intentional key-failover skip**. It verified that the gateway accepts PugPort's `Authorization: Bearer <virtual-key>` format without an extra header, rejects missing/wrong keys and disallowed models before the upstream, and makes one attempt for the tested 429/500 failures with zero configured retries. It also retained the text, streaming, usage, tool-call and cancellation checks.

Thirty alternating warm samples per route measured complete-response HTTP latency: direct p50 **2.144 ms**, gateway p50 **3.877 ms**; p95 **3.210 ms** and **6.739 ms**. This demonstrates gateway overhead and synthetic failure recovery, not faster model generation.

`tests/custom-api.test.ts` separately verifies PugPort's production configuration and Pi provider chain with an injected Bifrost-shaped transport: endpoint, isolated Bearer virtual key, exact requested model, streaming text and token usage. It does not launch Bifrost or call a real provider. The binary pilot and this compatibility test are separate checks, not an end-to-end production certification.

An additional three-check pilot connected the actual PugPort `apiEnvironment`/`apiTarget` configuration through the installed Pi `ModelConfig`/`composeModelProvider` and `streamSimple` to the running authenticated Bifrost and strict localhost mock, without an injected fetch. The valid-key request retained text and 7 input / 3 output tokens with one upstream inference request; a wrong key returned the gateway's 401 with zero upstream inference requests; missing credentials were rejected before upstream. This verifies the synthetic SDK seam, not the full Controller/Pi RPC or a real model service.

Not validated here: actual provider credentials, subscription passthrough, Responses SSE/continuation, monetary enforcement inside Bifrost, concurrent load or automatic gateway startup/recovery. Custom API cards currently use conservative text-only metadata, effort off, a 32,768-token context window and 4,096-token output limit. On macOS both limits can be set when the connection is added; other systems keep these values.

## Rollback

Stop or remove the optional gateway connection and use the original direct API or native CLI connection. No PugPort migration, new adapter, package dependency or global CLI configuration change is needed.

References: [Bifrost source](https://github.com/maximhq/bifrost), [gateway setup](https://docs.getbifrost.ai/quickstart/gateway/setting-up), [retry behavior](https://docs.getbifrost.ai/features/retries-and-fallbacks).
