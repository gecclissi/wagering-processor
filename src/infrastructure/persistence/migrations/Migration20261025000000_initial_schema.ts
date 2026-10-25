import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. As garantias de unicidade, imutabilidade e não-negatividade
 * vivem AQUI (restrição 9 do desafio): o código falha cedo com mensagem boa,
 * mas o banco é a última linha de defesa — vale para qualquer instância,
 * qualquer bug e qualquer acesso direto.
 */
export class Migration20261025000000_initial_schema extends Migration {
  override async up(): Promise<void> {
    // ------------------------------------------------------------------ wallets
    this.addSql(`
      create table wallets (
        id          uuid primary key,
        player_id   text          not null check (length(player_id) > 0),
        currency    char(3)       not null check (currency ~ '^[A-Z]{3}$'),
        -- numeric é decimal exato (nunca float). 20 dígitos, 2 casas.
        balance     numeric(20,2) not null check (balance >= 0),
        version     integer       not null check (version >= 1),
        created_at  timestamptz   not null,
        updated_at  timestamptz   not null,

        -- No máximo uma wallet por jogador + moeda.
        constraint wallets_player_currency_uq unique (player_id, currency),
        -- Alvo da FK composta do ledger (garante moeda do lançamento = moeda da wallet).
        constraint wallets_id_currency_uq unique (id, currency)
      );
    `);

    // ------------------------------------------------------- wager_transactions
    this.addSql(`
      create table wager_transactions (
        id                                 uuid primary key,
        provider_id                        text          not null check (length(provider_id) > 0),
        external_transaction_id            text          not null check (length(external_transaction_id) > 0),
        idempotency_key                    text          not null check (length(idempotency_key) > 0),
        payload_hash                       text          not null,
        wallet_id                          uuid          not null references wallets (id),
        player_id                          text          not null,
        round_id                           text          not null,
        game_id                            text          not null,
        kind                               text          not null
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount                             numeric(20,2) not null check (amount >= 0),
        currency                           char(3)       not null check (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id  text,
        reference_transaction_id           uuid references wager_transactions (id),
        status                             text          not null
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code                       text,
        resulting_balance                  numeric(20,2) check (resulting_balance >= 0),
        reference_attempts                 integer       not null default 0 check (reference_attempts >= 0),
        next_reference_attempt_at          timestamptz,
        created_at                         timestamptz   not null,
        processed_at                       timestamptz,

        -- Idempotência: a key é única, e o par provider + id externo também.
        constraint wager_tx_idempotency_key_uq unique (idempotency_key),
        constraint wager_tx_provider_external_uq unique (provider_id, external_transaction_id),
        -- Alvo da FK composta do ledger (garante wallet do lançamento = wallet da transação).
        constraint wager_tx_id_wallet_uq unique (id, wallet_id),

        -- Só LOSS pode ter valor zero.
        constraint wager_tx_amount_positive_ck check (amount > 0 or kind = 'LOSS'),
        -- REFUND e ROLLBACK exigem referência; BET e OPENING não aceitam.
        constraint wager_tx_reference_required_ck check (
          kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_tx_reference_forbidden_ck check (
          kind not in ('BET', 'OPENING') or reference_external_transaction_id is null),
        -- Estado terminal <=> processed_at preenchido.
        constraint wager_tx_terminal_processed_at_ck check (
          (status in ('PROCESSED', 'REJECTED', 'FAILED')) = (processed_at is not null)),
        -- REJECTED/FAILED <=> failure_code preenchido.
        constraint wager_tx_failure_code_ck check (
          (status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        -- Aguardando referência <=> próxima tentativa agendada.
        constraint wager_tx_pending_reference_ck check (
          (status = 'PENDING_REFERENCE') = (next_reference_attempt_at is not null))
      );
    `);

    // Reversão única (ver DESIGN.md §8.1): uma transação é revertida no máximo
    // UMA vez no total, somando REFUND e ROLLBACK. Índice parcial: só conta
    // reversões aplicadas — rejeitadas não bloqueiam.
    this.addSql(`
      create unique index wager_tx_single_reversal_uq
        on wager_transactions (reference_transaction_id)
        where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED';
    `);
    // No máximo uma abertura por wallet.
    this.addSql(`
      create unique index wager_tx_single_opening_uq
        on wager_transactions (wallet_id) where kind = 'OPENING';
    `);
    // Fila do worker de referências: só as pendentes, ordenadas pela próxima tentativa.
    this.addSql(`
      create index wager_tx_pending_reference_idx
        on wager_transactions (next_reference_attempt_at) where status = 'PENDING_REFERENCE';
    `);
    // Detectar "já foi revertida?" e resolver pendentes quando a referência chega.
    this.addSql(`
      create index wager_tx_reference_external_idx
        on wager_transactions (provider_id, reference_external_transaction_id)
        where reference_external_transaction_id is not null;
    `);

    // Transação em estado terminal é fato consumado: não muda mais.
    // E os campos de negócio nunca mudam, em nenhum estado.
    this.addSql(`
      create function wager_tx_guard_update() returns trigger language plpgsql as $$
      begin
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager_transaction % is terminal (%) and cannot change', old.id, old.status
            using errcode = 'integrity_constraint_violation';
        end if;
        if (new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
            new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount,
            new.currency, new.reference_external_transaction_id, new.created_at)
           is distinct from
           (old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
            old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount,
            old.currency, old.reference_external_transaction_id, old.created_at) then
          raise exception 'business fields of wager_transaction % are immutable', old.id
            using errcode = 'integrity_constraint_violation';
        end if;
        return new;
      end $$;
    `);
    this.addSql(`
      create trigger wager_tx_guard_update before update on wager_transactions
        for each row execute function wager_tx_guard_update();
    `);

    // ---------------------------------------------------- wallet_ledger_entries
    this.addSql(`
      create table wallet_ledger_entries (
        id              uuid primary key,
        -- Sequência monotônica: base do cursor estável de paginação do ledger.
        seq             bigint generated always as identity unique,
        wallet_id       uuid          not null,
        transaction_id  uuid          not null,
        direction       text          not null check (direction in ('DEBIT', 'CREDIT')),
        amount          numeric(20,2) not null check (amount > 0),
        currency        char(3)       not null,
        balance_before  numeric(20,2) not null check (balance_before >= 0),
        balance_after   numeric(20,2) not null check (balance_after >= 0),
        created_at      timestamptz   not null,

        -- No máximo um lançamento por transação financeira.
        constraint ledger_transaction_uq unique (transaction_id),
        -- A aritmética do lançamento é verificada pelo banco.
        constraint ledger_balanced_ck check (
          (direction = 'CREDIT' and balance_after = balance_before + amount) or
          (direction = 'DEBIT'  and balance_after = balance_before - amount)),
        -- Moeda do lançamento = moeda da wallet.
        constraint ledger_wallet_currency_fk foreign key (wallet_id, currency)
          references wallets (id, currency),
        -- Wallet do lançamento = wallet da transação.
        constraint ledger_transaction_wallet_fk foreign key (transaction_id, wallet_id)
          references wager_transactions (id, wallet_id)
      );
    `);
    this.addSql(`create index ledger_wallet_seq_idx on wallet_ledger_entries (wallet_id, seq);`);

    // Ledger append-only: UPDATE e DELETE são proibidos pelo próprio banco.
    this.addSql(`
      create function ledger_forbid_mutation() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only (% forbidden)', tg_op
          using errcode = 'integrity_constraint_violation';
      end $$;
    `);
    this.addSql(`
      create trigger ledger_forbid_mutation before update or delete on wallet_ledger_entries
        for each row execute function ledger_forbid_mutation();
    `);

    // ----------------------------------------------------------- inbox_messages
    this.addSql(`
      create table inbox_messages (
        consumer_name  text        not null,
        message_id     text        not null,
        payload_hash   text        not null,
        received_at    timestamptz not null,
        processed_at   timestamptz,
        -- Deduplicação persistente da entrada SQS.
        constraint inbox_messages_pk primary key (consumer_name, message_id)
      );
    `);

    // ---------------------------------------------------------- outbox_messages
    this.addSql(`
      create table outbox_messages (
        id               uuid primary key,
        aggregate_id     text        not null,
        event_type       text        not null,
        payload          jsonb       not null,
        occurred_at      timestamptz not null,
        attempts         integer     not null default 0 check (attempts >= 0),
        next_attempt_at  timestamptz not null,
        published_at     timestamptz
      );
    `);
    // Fila do publisher: só não publicadas, pela próxima tentativa.
    this.addSql(`
      create index outbox_pending_idx
        on outbox_messages (next_attempt_at, occurred_at) where published_at is null;
    `);
  }

  override async down(): Promise<void> {
    // Ordem inversa por causa das FKs.
    this.addSql(`drop table if exists outbox_messages;`);
    this.addSql(`drop table if exists inbox_messages;`);
    this.addSql(`drop table if exists wallet_ledger_entries;`);
    this.addSql(`drop function if exists ledger_forbid_mutation();`);
    this.addSql(`drop table if exists wager_transactions;`);
    this.addSql(`drop function if exists wager_tx_guard_update();`);
    this.addSql(`drop table if exists wallets;`);
  }
}
