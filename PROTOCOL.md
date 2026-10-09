# Protocolo Radar v1

Este documento descreve o envio de eventos ao Radar para quem escreve um SDK em outra linguagem. A fonte da verdade dos tipos é `src/protocol/index.ts`.

## Envio

```
POST https://radar-ingest.oconde.dev/api/v1/events
Authorization: Bearer rk_<40 caracteres>
Content-Type: application/json
Content-Encoding: gzip            (opcional)
```

Limites: até 500 eventos por lote e 1 MB de corpo, tanto nos bytes recebidos quanto no JSON depois de descompactado. `Content-Encoding` aceita só `gzip` ou nenhum.

## Tipos

```ts
export const PROTOCOL_VERSION = 1;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type EventBatch = {
  v: 1;
  sdk: { name: string; version: string };
  environment?: string;
  release?: string;
  dropped?: number;
  events: RadarEvent[];
};

export type RadarEvent = LogEvent | ErrorEvent;

export type LogEvent = {
  type: 'log';
  ts: number;
  level: LogLevel;
  message: string;
  requestId?: string;
  attrs?: Record<string, unknown>;
  request?: RequestInfo;
  user?: UserInfo;
};

export type ErrorEvent = {
  type: 'error';
  ts: number;
  level: 'error' | 'fatal';
  handled: boolean;
  requestId?: string;
  exception: ExceptionInfo;
  request?: RequestInfo;
  user?: UserInfo;
  runtime?: RuntimeInfo;
  attrs?: Record<string, unknown>;
};

export type ExceptionInfo = {
  type: string;
  message: string;
  frames: StackFrame[];
  cause?: ExceptionInfo;
};

export type StackFrame = {
  fn?: string;
  file: string;
  line?: number;
  col?: number;
  inApp: boolean;
  context?: { pre: string[]; line: string; post: string[] };
};

export type RequestInfo = {
  method: string;
  url: string;
  route?: string;
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
  ip?: string;
  userAgent?: string;
  status?: number;
  durationMs?: number;
};

export type UserInfo = { id?: string; email?: string; name?: string };

export type RuntimeInfo = {
  name: 'node';
  version: string;
  host?: string;
  pid?: number;
  memoryMb?: number;
  uptimeS?: number;
};

export type IngestResponse = { accepted: number; dropped: number };

export type IngestErrorCode =
  | 'invalid_key'
  | 'account_disabled'
  | 'payload_too_large'
  | 'invalid_batch'
  | 'quota_exceeded'
  | 'rate_limited';

export type IngestError = { error: { code: IngestErrorCode; message: string } };
```

- `ts` em milissegundos desde a época. Se estiver mais de 24 h longe do relógio do servidor, vale a hora de recebimento.
- `message` do log é a chave do evento. Convenção: mensagem estável (`webhook.olx.lead`, `http.request`, `api listening`) e o que varia vai em `attrs`. A regra de ausência compara a `message` exata.
- `dropped` é quantos eventos o SDK descartou desde o último lote aceito (fila cheia); o servidor soma em `usage_daily.dropped` e a tela do projeto mostra.

## Respostas

| Status | Corpo | Quando | O SDK faz |
|---|---|---|---|
| 202 | `IngestResponse` | lote aceito, mesmo que parcialmente: eventos inválidos, de `type` desconhecido ou acima da cota do dia entram em `dropped` | segue |
| 400 | `invalid_batch` | JSON inválido, `Content-Encoding` diferente de `gzip`, ou o envelope não é um `EventBatch` (sem `v: 1`, sem `sdk`, sem `events`) | descarta o lote, avisa uma vez |
| 401 | `invalid_key` | chave ausente, inexistente ou revogada | pausa os envios por 10 min, descarta a fila, avisa uma vez |
| 403 | `account_disabled` | conta desativada ou projeto apagado | igual ao 401 |
| 413 | `payload_too_large` | acima de 1 MB ou de 500 eventos | descarta o lote |
| 429 | `rate_limited`, com `Retry-After: 1` | excesso de requisições da mesma chave | devolve o lote à fila e espera o `Retry-After` |
| 429 | `quota_exceeded`, com `Retry-After` até a virada do dia | a cota do dia acabou e nenhum evento do lote coube | devolve o lote à fila e espera o `Retry-After` |
| 5xx / rede | — | servidor fora | devolve o lote à fila e tenta com espera crescente |

Quando a cota do dia acaba, o Radar avisa uma vez por dia em todos os canais ativos da conta.

## Check-in de tarefa agendada

```
POST https://radar-ingest.oconde.dev/api/v1/checkins/<slug>
Authorization: Bearer rk_<40 caracteres>
Content-Type: application/json

{ "status": "in_progress" | "ok" | "error", "checkInId"?: string, "durationMs"?: number, "environment"?: string, "release"?: string }
```

- `slug`: `^[a-z0-9][a-z0-9-]{0,63}$`, o mesmo do monitor criado no Radar, no projeto da chave.
- `checkInId` (até 64 caracteres) liga o `in_progress` ao `ok` ou `error` da mesma execução. Sem ele, `ok` e `error` fecham a execução aberta mais recente.
- `202 { "accepted": true }`. `404 unknown_monitor` quando o slug não existe no projeto da chave, `400 invalid_checkin` para corpo fora do formato, e `401`, `403` e `429` como no envio de eventos.
- O SDK manda na hora, sem fila, e nunca lança: `radar.checkIn(slug, status, { checkInId, durationMs })` ou `radar.cron(slug, fn)`.

Exemplo para um script sem o SDK:

```bash
curl -fsS -X POST -H "Authorization: Bearer $RADAR_KEY" -H 'content-type: application/json' \
  -d '{"status":"ok"}' https://radar-ingest.oconde.dev/api/v1/checkins/walg-archive-check
```

## Resumo de release

```
GET https://radar-ingest.oconde.dev/api/v1/releases/<release>
Authorization: Bearer rk_<40 caracteres>
```

`200 { "release", "firstSeen": iso | null, "newIssues": n, "events": n, "issues": [{ "title", "culprit", "count", "url" }] }`, com até 5 erros (mais ocorrências primeiro), só do projeto da chave. Serve para o pipeline de deploy olhar a release logo depois de publicar.

## Compatibilidade

O v1 só cresce: campo opcional novo pode; mudar o significado, tornar obrigatório ou remover não pode. O servidor ignora campos desconhecidos. Mudança que quebra vira `/api/v2/events`, com o v1 mantido.


## Limites recomendados no SDK

O servidor também corta, com regras um pouco diferentes: a `message` do log em 2000 bytes (UTF-8), a mensagem da exceção em 2000 caracteres, `attrs`, `query` e headers em 16 KB, `params` em 4 KB e `body` em 16 KB. Um campo JSON acima do limite vira `{ "_truncated": "<começo do JSON>" }`. Abaixo de 64 níveis de profundidade o servidor troca o valor por `null`; o SDK corta em 6.

O SDK deve cortar antes de enviar:

| Item | Limite |
|---|---|
| `message` | 2000 caracteres |
| strings em `attrs`, `query`, `body` | 2000 caracteres |
| `attrs` serializado | 16 KB |
| `body` serializado | 16 KB |
| headers | 50 |
| frames por exceção | 50 |
| frames com `context` | 10 do próprio app, 5 linhas antes e depois, 300 caracteres por linha |
| cadeia de `cause` | 5 níveis |
| profundidade de objetos | 6 |
| itens por array | 50 |
| `requestId` | 128 caracteres |
