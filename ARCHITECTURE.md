# Arquitetura

Este documento explica **por que** o sistema é como é: as garantias, as decisões,
o que foi trocado pelo quê e o que ficou de fora. Setup e comandos estão no
[`README.md`](README.md); o enunciado em [`CHALLENGE.md`](CHALLENGE.md).

**Ideia central:** toda alteração de dinheiro acontece numa **única transação do
PostgreSQL**, com a wallet travada. Transação, saldo, ledger, inbox e eventos são
gravados juntos — ou nada é. O banco é a fonte da verdade e a última linha de defesa:
fila, ordem de entrega e memória do processo são otimizações, nunca garantias.

---

## 1. Visão geral

```
   HTTP POST /wagering/transactions          SQS wager-transactions.fifo
          │ (Idempotency-Key)                       │ (inbox por messageId)
          ▼                                         ▼
   WageringController                        SqsWagerConsumer
          └──────────────┬──────────────────────────┘
                         ▼
          ProcessWagerTransactionUseCase      ← o MESMO use case para as duas entradas
                         │
   BEGIN ────────────────┼──────────────────────────────────────────────┐
   │ 0. inbox (só fila): mensagem já tratada? → resultado original      │
   │ 1. SELECT wallet … FOR UPDATE            (lock da wallet, por linha)│
   │ 2. idempotência: key já existe? → replay ou conflito               │
   │ 3. referência + "já foi revertida?"                                │
   │ 4. regras de domínio (função pura)                                 │
   │ 5. INSERT transação · UPDATE wallet (CAS version) · INSERT ledger  │
   │ 6. INSERT outbox (eventos)                                         │
   COMMIT ───────────────────────────────────────────────────────────────┘
                         │  só depois: resposta HTTP / ack da fila
                         ▼
   OutboxRelay (todas as instâncias, SKIP LOCKED) ──► wagering-events.fifo
   RetryPendingReferences (todas as instâncias)   ──► reprocessa PENDING_REFERENCE
```

## 2. Camadas

```
src/domain/          Money, Wallet, WagerTransaction, WalletLedgerEntry, eventos,
                     InboxMessage, OutboxMessage, applyWagerTransaction (regras).
                     Não conhece NestJS, MikroORM, HTTP nem SQS.
src/application/     use cases + portas (UnitOfWork, repositórios, EventPublisher, Clock…)
src/infrastructure/  MikroORM, SQS, logs, métricas — implementações das portas
src/interface/       entradas: controllers, consumer SQS, workers periódicos
```

Dependências apontam para dentro: `interface → application → domain`,
`infrastructure → application/domain`. O único lugar que conhece as implementações
concretas é o [`app.module.ts`](src/app.module.ts) (composição).

**Por quê:** as regras financeiras são testadas sem banco (131 testes de domínio
rodam em < 1 s), e o mesmo use case atende HTTP e SQS, como o desafio exige.

**Modelagem:** construtores `private` + factories (`create`/`open`/`from`/`enqueue`)
validam as regras; `rehydrate` reconstrói do banco **sem** revalidar transições.
Estado encapsulado com getters; `Money` e `WalletLedgerEntry` são congelados
(`Object.freeze`) — imutabilidade estrutural, não convenção.

---

## 3. Correção financeira

### 3.1 Dinheiro sem `number`

`Money` usa `decimal.js` (cópia isolada da configuração global) com escala fixa de 2.

- **Entrada estrita** por regex `^(0|[1-9]\d*)(\.\d{1,2})?$`: rejeita `NaN`, `Infinity`,
  `1e3`, negativos, `+5`, `05`, `5,00`, string vazia e `amount` enviado como `number`
  no JSON (já chegaria como float).
- **Sem arredondamento silencioso:** `10.005` é rejeitado, não vira `10.01`.
  Arredondar dinheiro sem avisar faria o sistema guardar um valor diferente do enviado.
- **Soma e subtração** de valores com 2 casas nunca precisam arredondar.
- Operar moedas diferentes lança `CURRENCY_MISMATCH`; `equals` só devolve `false`.
- `-0.00` é normalizado para `0.00`.
- Multi-moeda no modelo (wallet por `player + currency`); na prática usa-se `BRL`.

**Persistência:** `numeric(20,2)` (decimal exato) e lido do banco como **string**
(`decimal('string')` no MikroORM) — o valor nunca passa por `number` em nenhum ponto.

### 3.2 Saldo e ledger sempre juntos

- Só a `Wallet` altera saldo, e `debit`/`credit` **devolvem** o `WalletLedgerEntry`:
  não há como mudar o saldo sem produzir o lançamento.
- O lançamento é criado **antes** de mutar a wallet (falhou a validação → wallet intacta).
- `WalletLedgerEntry.create` confere `balanceBefore ± money == balanceAfter`; o banco
  confere de novo com `CHECK`.
- `version` nasce em 1 e só incrementa quando o saldo muda (movimento de valor zero é
  proibido). Abrir com saldo é **um** evento: `OPENING` + `CREDIT`, `version = 1`.
- Ledger simples por wallet (partidas dobradas é diferencial opcional, não feito).

### 3.3 Reconciliação

`POST /wallets/:id/reconciliation` compara o saldo gravado com
`Σ créditos − Σ débitos` do ledger num **único SELECT** — o PostgreSQL garante que um
comando enxerga um snapshot consistente, então os dois números são do mesmo instante,
sem lock e sem bloquear apostas. Divergência **não é corrigida**: vira log de erro,
métrica (`wagering_reconciliation_divergences_total`) e `consistent: false`. Corrigir
automaticamente esconderia o bug que causou a divergência.

---

## 4. Garantias no schema

O código falha cedo com mensagem boa; o **banco** garante (restrição 9 do desafio).
Migration única, reversível, em [`Migration20261025000000_initial_schema.ts`](src/infrastructure/persistence/migrations/Migration20261025000000_initial_schema.ts).
Cada linha abaixo é testada inserindo SQL proibido direto no banco e conferindo o
**nome** da constraint que barrou ([`schema-constraints.test.ts`](test/integration/schema-constraints.test.ts)).

| Garantia | Mecanismo |
|---|---|
| Saldo nunca negativo | `CHECK (balance >= 0)` em `wallets` e nos saldos do ledger |
| Uma wallet por player + moeda | `UNIQUE (player_id, currency)` |
| Idempotência | `UNIQUE (idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)` |
| Um lançamento por transação | `UNIQUE (transaction_id)` no ledger |
| Aritmética do lançamento | `CHECK (balance_after = balance_before ± amount)` por direção |
| Moeda do lançamento = da wallet | FK composta `(wallet_id, currency) → wallets(id, currency)` |
| Wallet do lançamento = da transação | FK composta `(transaction_id, wallet_id) → wager_transactions(id, wallet_id)` |
| Ledger append-only | trigger bloqueia `UPDATE` e `DELETE` |
| Transação terminal não muda; campos de negócio nunca mudam | trigger em `wager_transactions` |
| Reversão única | índice único parcial `(reference_transaction_id) WHERE kind IN (REFUND, ROLLBACK) AND status = PROCESSED` |
| Uma abertura por wallet | índice único parcial `(wallet_id) WHERE kind = 'OPENING'` |
| Coerência de estado | terminal ⇔ `processed_at`; REJECTED/FAILED ⇔ `failure_code`; PENDING_REFERENCE ⇔ próxima tentativa |
| Regras por kind | REFUND/ROLLBACK exigem referência; BET/OPENING não aceitam; só LOSS aceita 0 |
| Inbox | `PRIMARY KEY (consumer_name, message_id)` |

Ids são **UUIDv7** (ordenados por tempo: inserção no fim do índice B-tree). O ledger
tem `seq bigint identity` para paginação estável.

---

## 5. Concorrência

**Estratégia: lock pessimista por wallet** + compare-and-set da `version` como segunda
linha de defesa.

```sql
SET LOCAL lock_timeout = '5s';
SELECT * FROM wallets WHERE id = $1 FOR UPDATE;          -- trava SÓ esta linha
…regras em memória…
UPDATE wallets SET balance = $2, version = $3
 WHERE id = $1 AND version = $previous;                  -- 0 linhas → aborta (TransientError)
```

- **Unidade de concorrência = `walletId`.** Wallets diferentes nunca se bloqueiam
  (lock por linha, não global) — testado segurando o lock de uma wallet e processando
  outra em < 1 s.
- **Funciona com N instâncias** porque o lock vive no PostgreSQL, não na memória do processo.
- **Por que pessimista e não otimista:** numa *hot wallet* (muitas apostas simultâneas),
  otimista gera uma tempestade de retries; com pessimista as transações fazem fila no
  lock e cada uma roda uma vez. Também é mais simples de provar correto.
- **Por que o CAS da `version` além do lock:** defesa em profundidade. Se algum caminho
  futuro esquecer o lock, o UPDATE afeta 0 linhas e a transação aborta em vez de
  sobrescrever saldo (lost update). **Comprovado:** removendo o `FOR UPDATE`, os testes de
  concorrência falham com `version_conflict` — e nenhum saldo errado é gravado.
- **`lock_timeout` de 5 s:** ninguém espera para sempre; estourou → 503 / retry.
- **Isolamento READ COMMITTED** (padrão). Suficiente porque toda leitura que decide algo
  acontece **depois** do lock da wallet, e cada comando enxerga o que já foi commitado.
- **Ordem de locks fixa** (wallet primeiro) em todos os fluxos, inclusive no worker de
  pendências → sem deadlock.

**Cenário obrigatório** (100.00, duas BETs de 80.00 simultâneas): exatamente uma
`PROCESSED`, uma `REJECTED/INSUFFICIENT_FUNDS`, saldo 20.00, um débito. Testado em
paralelo real no mesmo processo e com cada aposta numa **instância diferente**.

---

## 6. Idempotência

- **`Idempotency-Key`** (header HTTP ou campo `idempotencyKey` da mensagem) é a fonte da
  verdade e é obrigatório (`400 MISSING_IDEMPOTENCY_KEY`).
- **`payloadHash`** = SHA-256 (hex) do **JSON canônico** dos campos de negócio
  (`providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money,
  referenceExternalTransactionId`): chaves ordenadas em todos os níveis, ausentes
  omitidos, `money` normalizado (`"25"` ≡ `"25.00"`). Header e metadados não entram.
- **Mesma key, mesmo hash** → resultado **original** (incluindo o saldo daquele momento,
  guardado em `resulting_balance`), `idempotentReplay: true`, **mesmo status HTTP** da
  primeira resposta. Replays não geram eventos.
- **Mesma key, hash diferente** → `409 IDEMPOTENCY_CONFLICT`, nunca replay. O mesmo vale
  para o mesmo `externalTransactionId` com outra key.
- **A checagem acontece depois do lock.** Duas requisições idênticas simultâneas: a
  segunda espera o lock, e quando entra a primeira já commitou — o SELECT a enxerga.
  Se a checagem fosse antes do lock, as duas veriam "não existe" e debitariam.
- **Corrida que o lock não cobre** (mesma key apontando para wallets diferentes): a
  `UNIQUE` barra o segundo INSERT; o repositório traduz em `DuplicateTransactionError` e o
  use case relê a vencedora numa nova transação → replay ou conflito.
- **Persistente**, nunca em memória: a mesma BET 30× espalhada em 3 processos gera um débito.

**Inbox × idempotency key:** a inbox deduplica a **entrega** (a mesma mensagem SQS), a
key deduplica a **operação** (que pode chegar uma vez por HTTP e outra pela fila).

---

## 7. Regras de negócio

### 7.1 Estados

```
PENDING ───────────┬──► PROCESSED  (terminal)
   │               ├──► REJECTED   (terminal, regra de negócio)
   ▼               └──► FAILED     (terminal, infra permanente — reservado)
PENDING_REFERENCE ─┘
   ▲  │ nova tentativa (attempts++)
   └──┘
```

Transição a partir de estado terminal lança `InvalidTransactionStateError` — erro de
**programação** (500), não de negócio; o trigger do banco também a impede.

### 7.2 Regras

As regras vivem em [`applyWagerTransaction`](src/domain/wager/apply-wager-transaction.ts),
função pura usada pela entrada e pelo worker.

| Kind | Saldo | Ledger | Referência |
|---|---|---|---|
| `OPENING` | + | CREDIT | — (interno; rejeitado se vier de fora: `INVALID_KIND`) |
| `BET` | − | DEBIT | proibida; sem saldo → `INSUFFICIENT_FUNDS` |
| `WIN` | + | CREDIT | opcional (BET da rodada; valor livre) |
| `LOSS` | — | — | opcional |
| `REFUND` | + | CREDIT | obrigatória, só `BET`, mesmo valor |
| `ROLLBACK` | inverso da referência | invertido | obrigatória: `BET`, `WIN` ou `REFUND`, mesmo valor |

A referência é resolvida por `(providerId, referenceExternalTransactionId)` e precisa
ser do mesmo provider, player, wallet, moeda e rodada (`REFERENCE_MISMATCH`). Reversão
que deixaria saldo negativo → `REVERSAL_INSUFFICIENT_FUNDS`, código **distinto** de
`INSUFFICIENT_FUNDS` (situação operacional diferente: o prêmio já foi gasto).
Transações rejeitadas são **gravadas** (auditáveis) e geram evento, mas não ledger.

### 7.3 Interpretações adotadas

| Tema | Decisão | Por quê |
|---|---|---|
| Reversão única | Uma transação é revertida **no máximo uma vez no total**, somando REFUND e ROLLBACK | O texto ("pelo mesmo tipo") permitiria REFUND + ROLLBACK da mesma BET = **crédito duplicado**, falha eliminatória. ROLLBACK de um REFUND continua permitido (reverte o refund) |
| Efeito colateral | Após `BET → REFUND → ROLLBACK(REFUND)` a BET não pode ser reembolsada de novo | Caso raro; preferimos bloquear a arriscar crédito duplicado |
| `LOSS` | aceita `0.00`; os demais exigem valor > 0 | LOSS só registra o resultado |
| `BET` com referência | rejeitada (`UNEXPECTED_REFERENCE`) | BET abre a rodada |
| `WIN` com referência | valida o contexto, não exige valor igual | Prêmio raramente é igual à aposta |
| Referência ainda pendente | a transação também espera | Ainda pode ser processada |
| Referência `REJECTED` | `REFERENCE_NOT_PROCESSED` | Não há o que reverter |

### 7.4 Referências fora de ordem

Referência ausente → `PENDING_REFERENCE` + evento. O worker
[`RetryPendingReferencesUseCase`](src/application/wagering/retry-pending-references.use-case.ts)
reprocessa com **backoff exponencial 1 s, 2 s, 4 s … até 5 min, no máximo 10
tentativas (~13 min)**. Esgotado → `REJECTED/REFERENCE_NOT_FOUND` + evento.

**Por que esses números:** provedores costumam entregar a referência em segundos
(reordenação de rede/fila); 13 min dão folga para atrasos reais sem deixar transações
penduradas indefinidamente. Quando a referência chega, o próximo ciclo (≤ 1 s após o
vencimento) resolve.

Cada pendência é processada numa transação própria, **travando a wallet primeiro** e
relendo a transação (outra instância pode já ter resolvido) — sem SKIP LOCKED, pois o
lock da wallet já serializa as instâncias.

### 7.5 Taxonomia de `failureCode` e status HTTP

Uma única tabela, [`error-mapping.ts`](src/interface/http/error-mapping.ts), mapeia
code → status para todos os endpoints. É um `Record<FailureCode, HttpStatus>`: criar um
code sem status **não compila**.

| HTTP | Códigos | Provedor deve |
|---|---|---|
| 400 | `INVALID_PAYLOAD`, `INVALID_AMOUNT`, `INVALID_CURRENCY`, `INVALID_KIND`, `MISSING_REFERENCE`, `UNEXPECTED_REFERENCE`, `MISSING_IDEMPOTENCY_KEY`, `INVALID_CURSOR` | corrigir (nada foi gravado) |
| 404 | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` | corrigir a referência |
| 409 | `IDEMPOTENCY_CONFLICT`, `WALLET_ALREADY_EXISTS`, `MESSAGE_ID_CONFLICT` | não reenviar igual |
| 422 | `INSUFFICIENT_FUNDS`, `REVERSAL_INSUFFICIENT_FUNDS`, `CURRENCY_MISMATCH`, `WALLET_MISMATCH`, `REFERENCE_NOT_FOUND`, `REFERENCE_MISMATCH`, `INVALID_REFERENCE_KIND`, `REFERENCE_NOT_PROCESSED`, `AMOUNT_MISMATCH`, `ALREADY_REVERSED` | desistir; a rejeição está gravada |
| 202 | status `PENDING_REFERENCE` | aguardar |
| 503 | `TEMPORARILY_UNAVAILABLE` + `Retry-After` | reenviar com a **mesma** key |
| 500 | `INTERNAL_ERROR` (bug; detalhes só no log) | — |

**400 × 409 × 422:** 400 = nem deu para entender; 409 = conflita com algo que já
existe; 422 = entendida, avaliada e recusada pela regra — com `transactionId`.
Id malformado (não-UUID) é tratado como "não encontrado" (404), nunca 500.

---

## 8. Mensageria e falhas

### 8.1 Consumer SQS

[`SqsWagerConsumer`](src/interface/messaging/sqs-wager-consumer.ts): long polling,
mesmo use case da API, inbox na mesma transação SQL do efeito.

| Resultado | Ação |
|---|---|
| `PROCESSED`, `REJECTED`, `PENDING_REFERENCE` | **ack** (delete) **depois do commit** |
| `DomainError` lançado (payload inválido, wallet inexistente, conflito) | **DLQ imediata** com `failureReason` + delete: nada foi gravado e repetir dá o mesmo erro |
| Transitório ou inesperado | **não** faz ack; `ChangeMessageVisibility` com backoff (2 s … 60 s). Após `maxReceiveCount = 5`, a *redrive policy* do SQS move para a DLQ |

- **Rejeição de negócio não vai para a DLQ**: está gravada e auditável, e gera evento.
  A DLQ é para o que não pôde nem ser registrado.
- **Erro inesperado também é retry**: se for bug, o `maxReceiveCount` leva à DLQ; se for
  passageiro, se recupera. Nada fica em loop infinito.
- **Inbox:** `INSERT … ON CONFLICT DO NOTHING RETURNING`. Não usa exceção (abortaria a
  transação) e, se outra entrega da mesma mensagem estiver em andamento, o INSERT
  **espera** ela terminar: commit → duplicata (ack); rollback → segue.
  `messageId` reaproveitado com conteúdo diferente → `MESSAGE_ID_CONFLICT` (DLQ).
- **Morte entre commit e ack:** a mensagem volta após o visibility timeout, a inbox
  reconhece, ack. Aconteceu de verdade no teste multi-processo (uma operação commitada
  no instante do SIGKILL foi reconhecida como duplicata pela outra instância).
- **Ordem:** mesmo `MessageGroupId` (wallet) em sequência, grupos diferentes em paralelo.
  Ordenação e deduplicação do SQS FIFO são otimização; a correção vem do banco.
- **DLQ manual idempotente:** `MessageDeduplicationId` = id SQS original.
- **SIGTERM:** `beforeApplicationShutdown` (roda antes de o MikroORM fechar conexões)
  aborta o long polling, espera as mensagens em andamento até 10 s e devolve as
  restantes com `visibility = 0` para outra instância pegar na hora.

### 8.2 Transactional outbox

Eventos gravados em `outbox_messages` **na mesma transação** do efeito (no passo
compartilhado [`settleTransaction`](src/application/wagering/settle-transaction.ts)).
Testado: se gravar a outbox falha, o débito também é desfeito.

[`RelayOutboxUseCase`](src/application/outbox/relay-outbox.use-case.ts) roda em todas as
instâncias (sem líder):

```sql
BEGIN;
SELECT … FROM outbox_messages
 WHERE published_at IS NULL AND next_attempt_at <= :now
 ORDER BY occurred_at, id LIMIT 10
 FOR UPDATE SKIP LOCKED;        -- cada instância pega um lote diferente, sem esperar
-- SendMessageBatch → wagering-events.fifo
UPDATE … published_at (ou attempts++ e next_attempt_at com backoff)
COMMIT;
```

- **SKIP LOCKED** (`LockMode.PESSIMISTIC_PARTIAL_WRITE`): 3 publishers sobre 60 eventos
  publicam cada um **exatamente uma vez**. **Comprovado:** sem o SKIP LOCKED o teste falha.
- **At-least-once:** morreu depois de enviar e antes do COMMIT → outra instância reenvia.
  Mitigação dupla: `MessageDeduplicationId = eventId` (o SQS FIFO descarta em 5 min) e o
  consumidor deduplica pelo `eventId`.
- **Sem limite de tentativas** (backoff 1 s → 60 s): evento confirmado nunca é
  descartado; atraso aparece em `wagering_outbox_lag_seconds`.

**Eventos** ([`wagering-events.ts`](src/domain/events/wagering-events.ts)): classe
abstrata `IntegrationEvent<T>` com uma subclasse por evento, `eventType` e `version` no
tipo, `data` só com `MoneyProps` (string). `aggregateId = walletId` (vira o
`MessageGroupId`).

| Desfecho | Eventos |
|---|---|
| `PROCESSED` com lançamento (inclui `OPENING`) | `WagerTransactionProcessed` + `WalletBalanceChanged` |
| `PROCESSED` sem lançamento (`LOSS`) | `WagerTransactionProcessed` |
| `REJECTED` | `WagerTransactionRejected` |
| entra em `PENDING_REFERENCE` (só a 1ª vez) | `WagerTransactionPendingReference` |
| replay | nenhum |

`correlationId`: `X-Correlation-Id` (HTTP), `messageId` (fila) ou gerado; `causationId`:
`messageId` da fila.

### 8.3 Indisponibilidade

| Falha | Comportamento |
|---|---|
| PostgreSQL fora | HTTP 503 + `Retry-After`; fila: retry com backoff; `/health/ready` 503 |
| SQS fora na publicação | outbox acumula, retry com backoff, lag na métrica; app sobe mesmo assim (URL resolvida sob demanda) |
| SQS fora no consumo | loop de polling espera 1 s e tenta de novo |
| Instância morre | locks e transações são liberados pelo PostgreSQL; mensagens voltam pela visibilidade; outbox e pendências são retomadas por qualquer outra instância |

---

## 9. Observabilidade

- **Logs JSON** ([`json-logger.ts`](src/infrastructure/observability/json-logger.ts)), uma
  linha por evento, substituindo o logger do Nest. Um **contexto assíncrono**
  (`AsyncLocalStorage`) aberto por requisição, mensagem e ciclo de worker leva
  `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId` para todo log,
  sem passar parâmetro.
- **Sem dados financeiros:** `amount`, `money`, `balance`, `payload`, `body`,
  `authorization`… são `[redacted]` mesmo se passados por engano. Ids bastam para
  correlacionar; o valor está no banco.
- `X-Correlation-Id` validado (contra *log injection*), gerado se ausente, devolvido na resposta.
- **Métricas Prometheus** em `GET /metrics` — transações por status, duplicatas, retries,
  DLQ (contador + profundidade real da fila), conflitos de lock, outbox lag/pendentes,
  latência de processamento e HTTP, erros por código, divergências de reconciliação.
  Gauges de outbox e DLQ são calculados no scrape, direto da fonte. Labels de baixa
  cardinalidade (rota com parâmetro, nunca ids).
- **Health:** `/health/live` (processo) e `/health/ready` (`SELECT 1` + `GetQueueUrl`), abertos.
- Use cases não logam nem medem: isso fica nas bordas (HTTP, consumer, workers).

---

## 10. Autenticação (não implementada)

Decisão de escopo: não pontua e competiria com o núcleo financeiro. O ponto de extensão
é o [`ProviderAuthGuard`](src/interface/http/auth.guard.ts), hoje no-op, aplicado aos
controllers de wallet e wagering (health e métricas ficam fora).

**Desenho previsto:** cada provedor é um client OIDC num IdP externo (Keycloak no
Docker Compose) e obtém token por `client_credentials`. O guard valida o JWT pelo JWKS
do IdP (`iss`, `aud`, `exp`) e exige que o `providerId` do corpo seja o do token — um
provedor não opera em nome de outro. Mensagens da fila são canal interno confiável, mas
o `providerId` continua sujeito às mesmas validações de domínio.

---

## 11. Escolhas de stack

| Escolha | Por quê |
|---|---|
| **MikroORM** | Preferencial no desafio; `EntityManager.transactional()`, `LockMode.PESSIMISTIC_WRITE` e `PESSIMISTIC_PARTIAL_WRITE` (SKIP LOCKED) usados diretamente; migrations versionadas |
| Records separados do domínio | O MikroORM conhece só "records" (`defineEntity`, sem decorators); mappers convertem com `rehydrate`. O domínio não depende do ORM |
| Escritas explícitas (`insert`/`nativeUpdate`) em vez do flush do Unit of Work | O SQL dentro da seção crítica (wallet travada) fica previsível, curto e na ordem exigida pelas FKs. `em.fork()` por operação: sem identity map compartilhado; `refresh: true` nas leituras após o lock |
| Migrations listadas explicitamente (`migrationsList`) | Não dependem de varrer o disco; iguais com Bun e em build |
| `decimal.js` | Decimal exato, maduro, sem dependências |
| `prom-client` | Padrão de mercado para Prometheus em Node/Bun |
| LocalStack `4.4` fixado | Imagens mais novas exigem auth token |

---

## 12. Testes

**265 testes**, todos contra **PostgreSQL e LocalStack reais** (nada mockado na
persistência ou na fila). Depois de cada teste de integração, o banco confere a
invariante final: `wallet.balance == saldo reconstruído pelo ledger`.

| Camada | O quê |
|---|---|
| `test/unit` | Money, Wallet, WagerTransaction, ledger, regras dos 5 kinds, logger |
| `test/integration` | migrations reversíveis, constraints, use cases, concorrência com `Promise.all`, HTTP de ponta a ponta, consumer SQS, outbox, worker de pendências, observabilidade |
| `test/multi-instance` | 3 processos `bun run src/main.ts` reais: hot wallet, mesma aposta 30×, 100 → 80 + 80, 3 consumidores com SIGKILL no meio, queda durante carga + reinício total com reconciliação |

**Falhas simuladas:** banco fora (UnitOfWork que falha N vezes), broker fora, falha ao
gravar a outbox, processo morto antes do commit da outbox, morto depois do commit e antes
do ack (determinístico e com SIGKILL real), shutdown que estoura o prazo.

**Prova de que os testes pegam o bug** (verificado removendo o código e rodando):
sem `FOR UPDATE` → testes de concorrência falham; sem `SKIP LOCKED` → teste de
publishers concorrentes falha.

Mapa completo "teste exigido pelo desafio → arquivo" em [`DESIGN.md §14`](DESIGN.md).

---

## 13. Trade-offs

| Escolhemos | Em vez de | Ganho | Custo |
|---|---|---|---|
| Lock pessimista por wallet | Otimista com retry | Sem tempestade de retries em hot wallet; simples de provar | Throughput por wallet limitado a uma transação por vez |
| Rejeitar escala > 2 | Arredondar | Nunca guarda valor diferente do enviado | Provedor precisa mandar o valor certo |
| Transação aberta durante o envio da outbox ao SQS | "Lease" (`claimed_until`) | Simples; SKIP LOCKED resolve a concorrência | Conexão presa durante a chamada de rede (lote ≤ 10) |
| Polling do banco pelos workers | `LISTEN/NOTIFY` / CDC | Simples, sem infraestrutura extra | Até ~1 s de latência para publicar/resolver pendência |
| Reversão única no total | Texto literal (por tipo) | Impossível crédito duplicado | Bloqueia re-reembolso após rollback de refund |
| Erro inesperado = retry | Erro inesperado = DLQ | Falhas passageiras se recuperam | Bug consome até 5 tentativas antes da DLQ |
| DLQ imediata para erro permanente | Deixar a redrive policy levar | Não desperdiça tentativas; motivo anotado | Um `send` + `delete` a mais |

---

## 14. Limitações conhecidas e próximos passos

- **Autenticação** não implementada (§10).
- **Ordem de eventos entre instâncias:** com vários publishers, eventos da mesma wallet
  podem sair fora de ordem entre lotes. `WalletBalanceChanged` leva `walletVersion` para o
  consumidor descartar o mais antigo.
- **Crescimento de tabelas:** `inbox_messages` e `outbox_messages` publicadas não têm
  rotina de limpeza (faltaria um job de retenção por idade).
- **Pendências** são resolvidas no próximo ciclo do worker após o backoff, não no
  instante em que a referência chega (otimização possível: tentar as dependentes logo
  após processar a referência).
- **`TRUNCATE`** não é bloqueado pelo trigger do ledger (os testes usam para limpar
  dados). Em produção, o usuário da aplicação não deve ter esse privilégio.
- **Ferramenta de reprocessamento da DLQ** não implementada (hoje: inspeção manual).
- **Métricas por instância:** contadores zeram no restart; a agregação fica no Prometheus.
  `/metrics` sem autenticação (deve ficar em rede interna).
- **Correlação no worker:** eventos gerados pelo worker usam o id da transação como
  `correlationId` (a correlação da requisição original não é persistida).
- **SIGTERM no Windows:** enviar SIGTERM a um processo filho equivale a matá-lo; o
  shutdown gracioso é testado dentro do processo (`consumer.stop()`) e os testes
  multi-processo usam SIGKILL (o pior caso).
- **Fora de escopo por decisão:** partidas dobradas, multi-moeda em uso real (modelo
  suporta; conflito de moeda testado), teste de carga, reversão parcial.
