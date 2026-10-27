# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`,
`ROLLBACK`) vindas de provedores de jogos por **HTTP** e por **SQS**, aplicando cada
operação **exatamente uma vez** — mesmo com mensagens duplicadas, fora de ordem,
processadas em várias instâncias ao mesmo tempo ou com o processo morrendo no meio.

- Enunciado do desafio: [`CHALLENGE.md`](CHALLENGE.md)
- Decisões, trade-offs e limitações: [`ARCHITECTURE.md`](ARCHITECTURE.md)

**Stack:** Bun · TypeScript estrito · NestJS · MikroORM · PostgreSQL · AWS SQS (LocalStack) · Docker Compose

---

## Requisitos

| Ferramenta | Versão | Verificar |
|---|---|---|
| [Bun](https://bun.sh) | 1.x | `bun --version` |
| Docker + Docker Compose | 24+ / v2+ | `docker info` |

Portas usadas: `3000` (API), `5432` (PostgreSQL), `4566` (LocalStack).

## Subindo do zero

```bash
bun install                 # dependências
cp .env.example .env        # configuração local (Bun carrega o .env sozinho)
bun run infra:up            # PostgreSQL + LocalStack; espera os dois ficarem saudáveis
bun run migration:up        # cria o schema
bun run start               # API em http://localhost:3000
```

O `infra:up` já cria as filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo`
(DLQ, após 5 recebimentos) e `wagering-events.fifo` (eventos publicados pela outbox) —
script em [`docker/localstack/01-create-queues.sh`](docker/localstack/01-create-queues.sh).

Uma instância roda tudo: API HTTP, consumer SQS, relay da outbox e worker de
referências pendentes. Para várias instâncias, suba mais processos com `PORT`
diferente — elas se coordenam pelo banco, sem líder.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` | Sobe a aplicação |
| `bun run dev` | Sobe com reload a cada alteração |
| `bun run typecheck` | Checagem de tipos (`tsc --noEmit`) |
| `bun test` | **Todos** os testes (precisa de `infra:up`; ~70 s) |
| `bun run test:unit` | Só domínio e logger — sem Docker, < 1 s |
| `bun run test:integration` | PostgreSQL + LocalStack reais |
| `bun run test:multi` | 3+ **processos** reais da aplicação, quedas e reinício |
| `bun run migration:up` / `migration:down` / `migration:status` | Migrations (reversíveis) |
| `bun run infra:up` / `infra:down` | Sobe / derruba e **apaga** os volumes |

Os testes de integração usam um banco próprio (`wagering_test`), recriado a cada
execução, e filas com nomes aleatórios — não tocam nos dados de desenvolvimento.

## Usando a API

```bash
# 1. Criar wallet (saldo inicial gera a transação interna OPENING + lançamento no ledger)
curl -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
# → 201 {"id":"<walletId>","playerId":"player-1","balance":{"amount":"100.00","currency":"BRL"},"version":1}

# 2. Apostar (Idempotency-Key obrigatório; X-Correlation-Id opcional)
curl -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' -H 'X-Correlation-Id: trace-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"tx-1","playerId":"player-1",
       "walletId":"<walletId>","roundId":"round-1","gameId":"fortune-chimp",
       "kind":"BET","money":{"amount":"80.00","currency":"BRL"}}'
# → 200 {"transactionId":"…","status":"PROCESSED","balance":{"amount":"20.00","currency":"BRL"},"idempotentReplay":false}
# Repetir o mesmo comando → mesmo corpo com "idempotentReplay":true (nada é debitado de novo)
```

| Endpoint | |
|---|---|
| `POST /wallets` | Cria wallet (409 se já existe para player + moeda) |
| `GET /wallets/:walletId` | Saldo e version |
| `GET /wallets/:walletId/ledger?cursor=…&limit=50` | Lançamentos em ordem, cursor opaco (`nextCursor`) |
| `POST /wallets/:walletId/reconciliation` | Saldo gravado × saldo reconstruído do ledger |
| `POST /wagering/transactions` | Submete uma operação |
| `GET /wagering/transactions/:transactionId` | Consulta por id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pelo id do provedor |
| `GET /health/live` · `GET /health/ready` | Processo vivo · PostgreSQL e SQS alcançáveis (503 se não) |
| `GET /metrics` | Métricas no formato Prometheus |

**Status HTTP** (iguais em todos os endpoints; erros sempre `{"error":{"code","message"}}`):

| Status | Significado | O provedor deve |
|---|---|---|
| 200 | `PROCESSED` | — |
| 202 | `PENDING_REFERENCE` (referência ainda não chegou) | aguardar |
| 400 | payload inválido (`INVALID_AMOUNT`, `MISSING_IDEMPOTENCY_KEY`, …) | corrigir |
| 404 | wallet / transação inexistente | corrigir |
| 409 | `IDEMPOTENCY_CONFLICT` (key já usada com outro payload), `WALLET_ALREADY_EXISTS` | não reenviar igual |
| 422 | `REJECTED` por regra (`INSUFFICIENT_FUNDS`, `ALREADY_REVERSED`, …) — fica gravada | desistir |
| 503 | falha transitória (`Retry-After`) | reenviar com a **mesma** key |

Dinheiro é sempre string decimal com 2 casas (`"25.00"`). `25` como número é rejeitado.

## Enviando pela fila

O consumer lê `wager-transactions.fifo` com o mesmo use case da API:

```bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> --message-deduplication-id msg-1 \
  --message-body '{"messageId":"msg-1","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z",
    "data":{"providerId":"provider-a","externalTransactionId":"tx-2","idempotencyKey":"provider-a:tx-2",
    "playerId":"player-1","walletId":"<walletId>","roundId":"round-1","gameId":"fortune-chimp",
    "kind":"BET","money":{"amount":"10.00","currency":"BRL"}}}'
```

Os eventos de integração (`WagerTransactionProcessed`, `WalletBalanceChanged`, …) saem
em `wagering-events.fifo`.

## Configuração

| Variável | Padrão | |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `LOG_LEVEL` | `info` | `error` · `warn` · `info` · `debug` |
| `DATABASE_URL` | — (obrigatória) | PostgreSQL |
| `AWS_REGION` / `AWS_ENDPOINT` | `us-east-1` / — | `AWS_ENDPOINT` aponta para o LocalStack; vazio = AWS real |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | — | `test` / `test` no LocalStack |
| `SQS_WAGER_QUEUE` / `SQS_WAGER_DLQ` / `SQS_EVENTS_QUEUE` | nomes acima | Filas |
| `SQS_CONSUMER_ENABLED` | `true` | Liga o consumer nesta instância |
| `WORKERS_ENABLED` | `true` | Liga o relay da outbox e o worker de pendências |

## Estrutura

```
src/
  domain/          regras puras: Money, Wallet, WagerTransaction, ledger, eventos, inbox/outbox
  application/     use cases e portas (interfaces) — sem NestJS, sem ORM
  infrastructure/  MikroORM (records, repositórios, migrations), SQS, logs e métricas
  interface/       entradas: controllers HTTP, consumer SQS, workers periódicos
test/
  unit/            domínio e logger (sem I/O)
  integration/     PostgreSQL + LocalStack reais
  multi-instance/  processos reais da aplicação, SIGKILL e reinício
```

Observações:
- Autenticação **não implementada** (decisão de escopo): ponto de extensão em
  [`ProviderAuthGuard`](src/interface/http/auth.guard.ts); desenho em `ARCHITECTURE.md`.
- O LocalStack está fixado na versão `4.4`: imagens mais novas exigem auth token.

## Sobre o desenvolvimento

Este projeto foi desenvolvido com apoio de IA (Claude) como par de programação. As decisões
de arquitetura foram discutidas, revisadas e validadas por testes automatizados — inclusive
removendo proteções de propósito para confirmar que os testes falham sem elas — e estão
justificadas no [`ARCHITECTURE.md`](ARCHITECTURE.md).
