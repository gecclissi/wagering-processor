# Design — Distributed Wagering Processor

> Caderno de construção: o mapa usado durante o desenvolvimento, na ordem em que as
> peças foram feitas. **A referência final é o [`ARCHITECTURE.md`](ARCHITECTURE.md)**
> (decisões, trade-offs e limitações) — onde os dois divergirem, vale o ARCHITECTURE.

---

## 1. O problema em uma frase

Provedores de jogos mandam operações (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`)
que mexem no saldo de uma wallet. A entrega é **at-least-once**: a mesma mensagem
pode chegar repetida, fora de ordem e em várias instâncias ao mesmo tempo.
O sistema precisa aplicar cada operação **exatamente uma vez** e nunca deixar
o saldo negativo.

---

## 2. Visão geral do fluxo

```
            HTTP POST /wagering/transactions          SQS wager-transactions.fifo
                         │                                        │
                         ▼                                        ▼
                  WagerController                          SqsConsumer
                         │                                        │
                         └──────────────┬─────────────────────────┘
                                        ▼
                      ProcessWagerTransactionUseCase   ← o MESMO para os dois
                                        │
              ┌─────────────── UMA transação SQL ───────────────┐
              │ 1. inbox (só SQS): já vi esta messageId?        │
              │ 2. idempotência: já existe esta key?            │
              │ 3. SELECT wallet ... FOR UPDATE   (lock da wallet)│
              │ 4. regras de domínio (Wallet / WagerTransaction) │
              │ 5. UPDATE wallet  (saldo + version)              │
              │ 6. INSERT ledger entry                           │
              │ 7. INSERT outbox (eventos)                       │
              └──────────────────────── COMMIT ─────────────────┘
                                        │
                     só depois: HTTP responde / SQS faz ack
                                        │
                     OutboxPublisher (worker) ──► SNS/SQS de eventos
                     PendingReferenceWorker   ──► reprocessa PENDING_REFERENCE
```

A ideia central: **tudo o que muda dinheiro acontece numa única transação do
PostgreSQL**. Ou tudo é gravado, ou nada é. Publicação de eventos e ack da fila
só acontecem **depois** do commit.

---

## 3. Camadas (DDD simplificado)

```
src/
  domain/          regras puras: Money, Wallet, WagerTransaction, LedgerEntry,
                   InboxMessage, OutboxMessage, eventos, erros, failureCodes.
                   NÃO conhece NestJS, MikroORM, HTTP nem SQS.
  application/     use cases (orquestram o domínio) + portas (interfaces de
                   repositório, publisher, clock, id generator).
  infrastructure/  implementações: MikroORM (entities/repos/migrations),
                   SQS (consumer/publisher), workers, logger, métricas.
  interface/       controllers HTTP, DTOs, mapeamento de erro → status HTTP,
                   health checks, AuthGuard no-op.
```

Regra de dependência: `interface → application → domain` e
`infrastructure → application/domain`. O domínio não aponta para fora.

**Por quê?** As regras financeiras ficam testáveis sem banco e o mesmo use case
serve HTTP e SQS (exigência do desafio).

---

## 4. As 5 garantias e quem as protege

| Garantia | Código (1ª linha) | Banco (garantia final) |
|---|---|---|
| Dinheiro exato | `Money` com `decimal.js`, escala 2 | coluna `numeric(20,2)` |
| Saldo nunca negativo | `Wallet.debit()` lança erro | `CHECK (balance >= 0)` |
| Sem lost update | `SELECT ... FOR UPDATE` na wallet | `version` + lock de linha |
| Sem débito/crédito duplicado | checagem de idempotency key | `UNIQUE (provider_id, external_transaction_id)`, `UNIQUE (idempotency_key)`, `UNIQUE (transaction_id)` no ledger |
| Reversão só uma vez | regra no use case | `UNIQUE (reference_transaction_id, kind)` parcial |
| Ledger imutável | entidade sem setters | trigger que bloqueia `UPDATE`/`DELETE` |
| Uma wallet por player+moeda | conflito no use case | `UNIQUE (player_id, currency)` |

O desafio exige (restrição 9) que as garantias estejam **no schema**. O código
falha cedo com mensagem boa; o banco é a rede de segurança que nunca falha.

---

## 5. Concorrência — lock pessimista por wallet

```sql
BEGIN;
SELECT * FROM wallets WHERE id = $1 FOR UPDATE;  -- trava SÓ esta linha
-- calcula novo saldo em memória com Money
UPDATE wallets SET balance = $2, version = version + 1 WHERE id = $1;
INSERT INTO wallet_ledger_entries ...;
INSERT INTO outbox_messages ...;
COMMIT;                                           -- libera o lock
```

- **Unidade de concorrência = walletId.** Wallets diferentes não se bloqueiam
  (não é lock global — restrição 6).
- Funciona com N instâncias porque o lock vive **no PostgreSQL**, não na memória
  do processo.
- **Por que pessimista e não otimista?** Wallet "quente" (muitas apostas
  simultâneas) com otimista gera muitos retries; com pessimista as transações
  simplesmente fazem fila. É também mais fácil de explicar e provar.

### Cenário obrigatório: 100.00 e duas apostas de 80.00

```
T1: lock wallet ─► saldo 100 ─► debita 80 ─► saldo 20 ─► COMMIT (libera)
T2:      espera o lock ...................................► saldo 20
                                                             80 > 20 → REJECTED
                                                             (INSUFFICIENT_FUNDS)
```
Resultado: 1 `PROCESSED`, 1 `REJECTED`, saldo 20.00, 1 lançamento de débito.

---

## 6. Idempotência

- `Idempotency-Key` (header HTTP ou campo na mensagem) é a fonte da verdade.
- `payloadHash` = SHA-256 do **JSON canônico** (chaves ordenadas) dos campos de
  negócio: `providerId, externalTransactionId, playerId, walletId, roundId,
  gameId, kind, money, referenceExternalTransactionId`.
- Fluxo:
  1. busca transação pela key;
  2. **não existe** → processa;
  3. **existe e hash igual** → devolve o resultado original,
     `idempotentReplay: true` (saldo "daquele momento" vem de `balance_after`
     salvo na transação);
  4. **existe e hash diferente** → `409 IDEMPOTENCY_CONFLICT`.
- Se duas requisições iguais chegam juntas, uma delas bate na `UNIQUE` do banco;
  tratamos o erro relendo a transação e respondendo como replay.

---

## 7. Máquina de estados da WagerTransaction

```
              ┌──────────────► PROCESSED   (terminal)
              │
   PENDING ───┼──────────────► REJECTED    (terminal)
      │       │
      │       └──────────────► FAILED      (terminal)
      ▼
 PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
   (referência ainda não chegou; worker tenta de novo com backoff)
```

Transição a partir de estado terminal = `InvalidTransactionStateError`
(erro de programação, não de negócio).

---

## 8. Regras de negócio (resumo)

| Kind | Saldo | Ledger | Referência |
|---|---|---|---|
| `OPENING` | +valor | CREDIT | — (interno, nunca via API/fila) |
| `BET` | −valor | DEBIT | — ; sem saldo → `INSUFFICIENT_FUNDS` |
| `WIN` | +valor | CREDIT | opcional (BET da rodada) |
| `LOSS` | nada | nenhum | opcional |
| `REFUND` | +valor | CREDIT | obrigatória, só `BET` |
| `ROLLBACK` | inverso da ref. | invertido | obrigatória: `BET`, `WIN` ou `REFUND` |

Referência deve bater: mesmo provider, player, wallet, moeda, rodada e valor.
Reversão que deixaria saldo negativo → `REVERSAL_INSUFFICIENT_FUNDS`
(código diferente de `INSUFFICIENT_FUNDS`).

### 8.1 Interpretações adotadas

| Tema | Texto do desafio | Interpretação | Por quê |
|---|---|---|---|
| Reversão única | "não pode ser revertida duas vezes **pelo mesmo tipo** de operação" | Uma transação é revertida **no máximo uma vez no total**, somando `REFUND` e `ROLLBACK`. | Ao pé da letra, `REFUND` + `ROLLBACK` da mesma `BET` seriam permitidos e devolveriam o dinheiro **duas vezes** — crédito duplicado, falha eliminatória. `ROLLBACK` de um `REFUND` continua permitido: ele reverte o *refund*, não a `BET`. |
| Garantia no banco | — | `UNIQUE (reference_transaction_id) WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'` | Duas reversões concorrentes da mesma referência: uma entra, a outra viola o índice. |
| Efeito colateral | — | Depois de `BET → REFUND → ROLLBACK(REFUND)`, a `BET` não pode ser reembolsada de novo. | Caso raro; preferimos bloquear a arriscar crédito duplicado. Documentado como limitação. |
| `LOSS` | sem valor definido | aceita `0.00`; demais kinds exigem valor > 0 | `LOSS` só registra o resultado. |
| `BET` com referência | não especificado | rejeitada (`UNEXPECTED_REFERENCE`) | `BET` abre a rodada; não referencia nada. |
| `WIN` com referência | "pode referenciar a BET" | valida contexto (provider/player/wallet/rodada), **não** exige valor igual | Prêmio raramente é igual à aposta. |

---

## 9. Taxonomia de failureCode e status HTTP

| Situação | Exemplo de code | HTTP | Provedor deve... |
|---|---|---|---|
| Payload inválido | `INVALID_PAYLOAD`, `INVALID_AMOUNT`, `INVALID_KIND`, `MISSING_REFERENCE`, `MISSING_IDEMPOTENCY_KEY`, `INVALID_CURSOR` | 400 | corrigir antes de reenviar |
| Recurso não existe | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` | 404 | corrigir a referência |
| Conflito | `IDEMPOTENCY_CONFLICT`, `WALLET_ALREADY_EXISTS` | 409 | não reenviar igual |
| Rejeição por regra (transação **gravada**) | `INSUFFICIENT_FUNDS`, `ALREADY_REVERSED`, `REFERENCE_NOT_FOUND`, ... | 422 | desistir; reenvio devolve a mesma rejeição |
| Aceita, pendente | status `PENDING_REFERENCE` | 202 | aguardar |
| Aplicada | status `PROCESSED` | 200 | — |
| Falha transitória | `TEMPORARILY_UNAVAILABLE` + `Retry-After` | 503 | reenviar com a **mesma** key |
| Bug | `INTERNAL_ERROR` | 500 | — |

Decisões:

- **Uma única tabela** (`interface/http/error-mapping.ts`) mapeia code → status para todos os
  endpoints. É um `Record<FailureCode, HttpStatus>`: criar um code novo sem status é erro de compilação.
- **Replay devolve o mesmo status da primeira resposta** (200, 202 ou 422), mudando só
  `idempotentReplay: true`. Para o provedor, a 2ª chamada é indistinguível da 1ª.
- **422 × 409 × 400:** 400 = a requisição nem pôde ser entendida (nada gravado); 409 = conflito com
  algo que já existe; 422 = entendida, avaliada e **recusada pela regra** — fica gravada e auditável,
  e o corpo traz `transactionId` e `failureCode`.
- **Erros** sempre no formato `{ "error": { "code", "message" } }`; resultados de transação (inclusive
  422) no formato do contrato, com `failureCode`.
- **Id malformado** (não-UUID) = "não encontrado" (404), nunca 500.
- **Valor como `number` no JSON é rejeitado** (400): `25.1` em JSON já é float.

Transações rejeitadas também são **persistidas** (auditáveis) e geram evento.

---

## 10. Mensageria

**Inbox (entrada SQS):** tabela `inbox_messages` com
`PRIMARY KEY (consumer_name, message_id)`, gravada **na mesma transação SQL** do
efeito financeiro (`ProcessWagerTransactionUseCase.execute(cmd, { inbox })` — o
mesmo use case do HTTP). Se o registro existe, o efeito existe.
- `INSERT ... ON CONFLICT DO NOTHING RETURNING`: sem erro (que abortaria a transação)
  e, se outra entrega da mesma mensagem estiver em andamento, o INSERT **espera** ela
  terminar — commit → duplicata; rollback → segue normalmente.
- Duplicata → devolve o resultado original e faz ack, sem travar a wallet.
- Mesmo `messageId` com conteúdo diferente (hash do envelope canônico) → `MESSAGE_ID_CONFLICT`.
- Inbox **e** idempotency key: a inbox deduplica a *entrega* (mensagem), a key
  deduplica a *operação* (a mesma operação pode chegar por HTTP e por fila).

**Consumer SQS** (`interface/messaging/sqs-wager-consumer.ts`) — classificação:

| Resultado | Ação | Por quê |
|---|---|---|
| `PROCESSED`, `REJECTED`, `PENDING_REFERENCE` | **ack** (delete) após o commit | o banco já tem o registro; `PENDING_REFERENCE` segue pelo worker |
| `DomainError` lançado (payload inválido, wallet inexistente, conflito) | **DLQ imediata** + delete | nada foi gravado e repetir dá o mesmo erro; a DLQ preserva para auditoria, com `failureReason` |
| `TransientError` ou erro inesperado | **não** faz ack; `ChangeMessageVisibility` com backoff exponencial (2s, 4s… até 60s) | depois de `maxReceiveCount = 5` recebimentos, a *redrive policy* do SQS move para a DLQ |

- **Ack só depois do commit:** o `delete` acontece quando o use case retornou.
  Morrer entre commit e ack → redelivery → inbox reconhece → ack. Sem duplicar.
- **Ordem:** mensagens do mesmo `MessageGroupId` (a wallet) em sequência; grupos
  diferentes em paralelo. Ordenação é otimização — o lock e a inbox garantem a correção.
- **DLQ manual idempotente:** `MessageDeduplicationId` = id SQS original (crash entre
  `send` e `delete` não duplica na DLQ dentro da janela de 5 min).
- **SIGTERM:** `beforeApplicationShutdown` (antes de o MikroORM fechar) → para o long
  polling (abort), espera as mensagens em andamento até 10s; o que sobrar volta para a
  fila com `visibility = 0` para outra instância pegar na hora.

**Outbox (saída):** tabela `outbox_messages` gravada na mesma transação.
O `RelayOutboxUseCase` roda em todas as instâncias (sem líder), a cada 500 ms ociosos:
```sql
BEGIN;
SELECT * FROM outbox_messages
 WHERE published_at IS NULL AND next_attempt_at <= :now
 ORDER BY occurred_at, id
 LIMIT 10
 FOR UPDATE SKIP LOCKED;     -- cada instância pega um lote diferente, sem esperar
-- SendMessageBatch → wagering-events.fifo
UPDATE ... published_at = now()   -- ou attempts++, next_attempt_at = backoff
COMMIT;
```
- **Eventos na mesma transação** do efeito (`settleTransaction`): falhou gravar a
  outbox → rollback do débito também (testado). Nunca há evento de algo que não
  aconteceu, nem efeito sem evento.
- **At-least-once:** morreu depois de enviar e antes do COMMIT → lock liberado → outra
  instância reenvia. Mitigação dupla: `MessageDeduplicationId = eventId` (SQS FIFO
  descarta em 5 min) e o consumidor deduplica pelo `eventId`.
- **Sem limite de tentativas** na publicação (backoff 1s → 60s): evento confirmado
  nunca é descartado; atraso aparece como métrica de *outbox lag*.
- **Trade-off:** a transação fica aberta durante o envio ao SQS (lote pequeno, ≤ 10).
  Alternativa seria "lease" com coluna `claimed_until`; rejeitada por simplicidade.
- **Ordem:** `MessageGroupId = aggregateId = walletId`. Com vários publishers, eventos
  da mesma wallet podem sair fora de ordem entre lotes; `WalletBalanceChanged` leva
  `walletVersion` para o consumidor descartar o mais antigo.

**Eventos** (`domain/events`): classe abstrata `IntegrationEvent<T>` + uma subclasse
por evento com `eventType`/`version` no tipo; `data` só com `MoneyProps`.

| Desfecho | Eventos |
|---|---|
| `PROCESSED` com lançamento | `WagerTransactionProcessed` + `WalletBalanceChanged` |
| `PROCESSED` sem lançamento (`LOSS`) | `WagerTransactionProcessed` |
| `REJECTED` | `WagerTransactionRejected` |
| entra em `PENDING_REFERENCE` (só a 1ª vez) | `WagerTransactionPendingReference` |
| replay | nenhum (já foram emitidos) |

`correlationId`: header `X-Correlation-Id` (HTTP), `messageId` (fila) ou gerado;
`causationId`: `messageId` da fila.

**Worker de `PENDING_REFERENCE`** (`RetryPendingReferencesUseCase`, a cada 1 s ocioso):
lista as vencidas (índice parcial), e cada uma numa transação própria trava a
**wallet primeiro** — mesma ordem de locks do fluxo principal, sem deadlock —, relê a
transação (outra instância pode ter resolvido) e chama o mesmo `settleTransaction`
da entrada. Esgotadas 10 tentativas (~13 min) → `REJECTED/REFERENCE_NOT_FOUND` +
evento. Aqui não há SKIP LOCKED: o lock da wallet já serializa as instâncias.

---

## 11. Schema (rascunho)

```
wallets               id PK, player_id, currency, balance numeric(20,2)
                      CHECK >= 0, version int, created_at, updated_at,
                      UNIQUE(player_id, currency)

wager_transactions    id PK, provider_id, external_transaction_id,
                      idempotency_key UNIQUE, payload_hash, wallet_id FK,
                      player_id, round_id, game_id, kind, amount, currency,
                      reference_external_transaction_id, reference_transaction_id,
                      status, failure_code, balance_after, attempts,
                      next_attempt_at, created_at, processed_at,
                      UNIQUE(provider_id, external_transaction_id)

wallet_ledger_entries id PK, wallet_id FK, transaction_id FK UNIQUE,
                      direction, amount, currency, balance_before,
                      balance_after, created_at
                      CHECK (aritmética before ± amount = after)
                      trigger: proíbe UPDATE/DELETE

inbox_messages        (consumer_name, message_id) PK, payload_hash,
                      received_at, processed_at

outbox_messages       id PK, aggregate_id, event_type, payload jsonb,
                      occurred_at, attempts, next_attempt_at, published_at
```

---

## 12. Ordem de construção

| # | Entrega | Pontos que protege |
|---|---|---|
| 1 | Esqueleto: Bun + NestJS + Docker Compose (Postgres + LocalStack) + health | base |
| 2 | `Money` + testes | correção financeira |
| 3 | `Wallet`, `WagerTransaction`, `LedgerEntry` + testes | correção / modelagem |
| 4 | Migrations com constraints | restrição 9 |
| 5 | Use case + lock pessimista + idempotência | concorrência / idempotência |
| 6 | API HTTP + mapeamento de erros | API |
| 7 | Teste 100 / 80 + 80 e 50 em paralelo | concorrência |
| 8 | Consumer SQS + inbox + DLQ | mensageria |
| 9 | Outbox + publisher + worker de PENDING_REFERENCE | mensageria |
| 10 | Reconciliação, logs, métricas | observabilidade |
| 11 | Testes multi-instância e crash | testes |
| 12 | `README.md` + `ARCHITECTURE.md` | documentação |

---

## 12.1 Observabilidade

**Logs** (`infrastructure/observability/json-logger.ts`): uma linha JSON por evento,
substituindo o logger do Nest (`time`, `level`, `context`, `msg` + campos).
- **Contexto assíncrono** (`AsyncLocalStorage`): HTTP (middleware), consumer (por
  mensagem) e workers abrem um contexto; tudo logado lá dentro sai com `correlationId`,
  `messageId`, `transactionId`, `walletId`, `providerId` — sem passar parâmetro.
- `correlationId`: header `X-Correlation-Id` (validado: só `[A-Za-z0-9._:-]`, ≤128, contra
  *log injection*) ou gerado; devolvido no header da resposta e propagado aos eventos.
- **Sem valores financeiros nem payloads**: chaves como `amount`, `money`, `balance`,
  `payload`, `body`, `authorization` são substituídas por `[redacted]` mesmo se
  passadas por engano. Ids bastam para correlacionar; o valor está no banco.
- Use cases **não logam**: quem loga e mede são as bordas (HTTP, consumer, workers).

**Métricas** (Prometheus, `GET /metrics`, registry próprio por app):

| Exigência | Métrica |
|---|---|
| transações por status | `wagering_transactions_total{status,kind,source}` (sem replays) |
| duplicatas | `wagering_duplicates_total{source}` |
| retries | `wagering_retries_total{operation,reason}` |
| DLQ | `wagering_dlq_messages_total{code}` + `wagering_dlq_depth` (inclui redrive) |
| conflitos de lock | `wagering_lock_conflicts_total{reason}` (lock_timeout, deadlock, version_conflict) |
| outbox lag | `wagering_outbox_lag_seconds`, `wagering_outbox_pending` |
| latência | `wagering_processing_duration_seconds{source}`, `http_request_duration_seconds{method,route,status}` |
| extra | `wagering_errors_total{code,source}`, `wagering_reconciliation_divergences_total`, `wagering_outbox_published_total` |

- Gauges de outbox e DLQ são calculados **no scrape**, direto da fonte da verdade
  (SELECT na outbox, `GetQueueAttributes` na DLQ) — não dependem de qual instância
  fez o trabalho. SQS fora: mantém o último valor em vez de derrubar o `/metrics`.
- Labels de baixa cardinalidade: rota com parâmetro (`/wallets/:walletId`), nunca ids.
- `/metrics` aberto como os health checks: é para o scraper interno (rede privada).

---

## 13. Fora de escopo (decidido)

- **Autenticação:** só `AuthGuard` no-op + desenho documentado (Keycloak/OIDC).
- **Partidas dobradas:** ledger simples por wallet.
- **Teste de carga:** não faremos.
- **Multi-moeda real:** modelo suporta, usamos só `BRL`; conflito de moeda é testado.

---

## 14. Mapa dos testes obrigatórios (README §13)

Todos contra **PostgreSQL e LocalStack reais** (nada mockado na persistência ou na fila).
Invariante final conferida no banco depois de cada teste de integração:
`wallet.balance == soma do ledger` (`expectLedgerConsistent`).

| Exigência | Onde |
|---|---|
| `Money`: escala, arredondamento, entradas inválidas, conflito de moeda | `test/unit/domain/money.test.ts` |
| Invariantes da `Wallet`; regras de BET/WIN/LOSS/REFUND/ROLLBACK | `test/unit/domain/*.test.ts` |
| Idempotency key com payload divergente | `process-wager.test.ts`, `http-api.test.ts` |
| Migrations (reversíveis) e constraints | `migrations.test.ts`, `schema-constraints.test.ts` |
| Atomicidade wallet + ledger + inbox + outbox | `outbox.test.ts` (falha na outbox desfaz o débito) |
| Inbox e redelivery | `sqs-consumer.test.ts` |
| Publishers concorrentes na mesma outbox | `outbox.test.ts` (3 relays, 60 eventos, cada um 1×) |
| Retry e DLQ | `sqs-consumer.test.ts` |
| 1. Mesma aposta 50× em paralelo | `concurrency.test.ts` (+ 30× em 3 processos) |
| 2. Disputa de saldo (100 → 80 + 80) | `concurrency.test.ts` (+ em 2 processos) |
| 3. Wallets distintas em paralelo | `concurrency.test.ts` |
| 4. ≥ 3 processos simultâneos | `test/multi-instance/` (processos `bun run src/main.ts` reais) |
| 5. Worker morto depois do commit e antes do ack | `sqs-consumer.test.ts` (determinístico) + `multi-instance` (SIGKILL real) |
| 6. Dois publishers sobre a mesma outbox | `outbox.test.ts` |
| 7. ROLLBACK/REFUND antes da referência | `pending-reference.test.ts`, `multi-instance` |
| 8. Reinício com comprovação da consistência final | `multi-instance` (derruba tudo, sobe 3 novas, reconcilia) |

**Prova de que os testes pegam o bug** (feita manualmente): sem o `FOR UPDATE` os testes de
concorrência falham (o compare-and-set da `version` aborta); sem o `SKIP LOCKED` o teste
de publishers concorrentes falha (evento publicado mais de uma vez).

**Limitação:** no Windows, enviar SIGTERM a um processo filho equivale a matá-lo
(TerminateProcess), então o *graceful shutdown* é testado dentro do processo
(`consumer.stop()`), e os testes multi-processo usam SIGKILL — o pior caso.
