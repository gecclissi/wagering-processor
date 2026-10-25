# Design — Distributed Wagering Processor

> O mapa do projeto. Serve para construir e para apresentar.
> Decisões detalhadas e trade-offs vão para o `ARCHITECTURE.md` ao final.

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
`PRIMARY KEY (consumer_name, message_id)`. Inserida na mesma transação; se já
existe, a mensagem é duplicata → ack sem reprocessar.

**Consumer SQS:**
- erro de negócio → transação `REJECTED` gravada, **ack**;
- erro transitório (banco fora) → **não** faz ack, a mensagem volta
  (visibility timeout) e é tentada de novo;
- excedeu `maxReceiveCount` → SQS manda para `wager-transactions-dlq.fifo`;
- `SIGTERM` → para de buscar mensagens, termina as em andamento.

**Outbox (saída):** tabela `outbox_messages` gravada na mesma transação.
O `OutboxPublisher` roda em todas as instâncias:
```sql
SELECT * FROM outbox_messages
 WHERE published_at IS NULL AND next_attempt_at <= now()
 ORDER BY occurred_at
 LIMIT 50
 FOR UPDATE SKIP LOCKED;     -- cada instância pega um lote diferente
```
Publica → marca `published_at`. Se o processo morre antes de marcar, outra
instância publica de novo → **at-least-once**; consumidores deduplicam pelo
`eventId`.

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

## 13. Fora de escopo (decidido)

- **Autenticação:** só `AuthGuard` no-op + desenho documentado (Keycloak/OIDC).
- **Partidas dobradas:** ledger simples por wallet.
- **Teste de carga:** não faremos.
- **Multi-moeda real:** modelo suporta, usamos só `BRL`; conflito de moeda é testado.
