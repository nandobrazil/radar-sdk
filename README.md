# @oconde/radar

SDK do [Radar](https://radar.oconde.dev) para Node.js e NestJS: logs, erros com trecho de código e contexto de requisição. Sem dependências em runtime.

**Documentação completa: https://radar.oconde.dev/docs/**

## Instalação

```bash
npm install @oconde/radar
```

Node 20 ou mais novo. Funciona em ESM e CommonJS, do NestJS 10 em diante. Gere a chave do projeto no painel do Radar e ponha em `RADAR_KEY`.

## NestJS

```ts
import { Module } from '@nestjs/common';
import { RadarModule } from '@oconde/radar/nest';

@Module({
  imports: [RadarModule.forRoot({ key: process.env.RADAR_KEY, release: process.env.GIT_SHA })],
})
export class AppModule {}
```

O módulo registra o contexto por requisição, um log `http.request` por requisição e a captura dos erros 5xx. Nos services:

```ts
import { radar } from '@oconde/radar';

radar.info('webhook.olx.lead', { leadId });
```

## Express

```ts
import { radar } from '@oconde/radar';

radar.init({ key: process.env.RADAR_KEY });
app.use(radar.middleware());
```

Depois das rotas, para os erros dos handlers chegarem ao Radar:

```ts
import type { ErrorRequestHandler } from 'express';

const reportErrors: ErrorRequestHandler = (error, req, res, next) => {
  radar.captureError(error);
  next(error);
};

app.use(reportErrors);
```

Exemplo completo em [Express e Node](https://radar.oconde.dev/docs/sdk/express/).

## Erros com o seu código

Ligue no `tsconfig` para os erros mostrarem as linhas do TypeScript:

```json
{ "compilerOptions": { "sourceMap": true, "inlineSources": true } }
```

## Na documentação

- [Começar em 5 minutos](https://radar.oconde.dev/docs/start/getting-started/)
- [Todas as opções](https://radar.oconde.dev/docs/sdk/options/)
- [Dados sensíveis e `requestDetail: 'route'`](https://radar.oconde.dev/docs/sdk/sensitive-data/)
- [Garantias: fila, lotes e o que acontece quando o Radar cai](https://radar.oconde.dev/docs/sdk/guarantees/)
- [Referência da API](https://radar.oconde.dev/docs/reference/sdk-api/)
- [Protocolo de envio](https://radar.oconde.dev/docs/reference/protocol/) (também em [PROTOCOL.md](PROTOCOL.md), para quem escreve um SDK em outra linguagem)

## Licença

MIT
