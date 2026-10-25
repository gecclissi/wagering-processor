import type { EntityManager } from '@mikro-orm/postgresql';
import type { LedgerPage, ReconciliationSnapshot, WalletReadRepository } from '../../application/ports';
import { Money } from '../../domain/shared/money';
import type { WagerTransaction } from '../../domain/wager/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import { LedgerEntryMapper, WagerTransactionMapper, WalletMapper } from './mappers';
import { LedgerEntryRecord, WagerTransactionRecord, WalletRecord } from './records';
import { isUuid } from './uuid';

/** Consultas da API. Sem transação explícita e sem lock: só leitura. */
export class MikroOrmWalletReadRepository implements WalletReadRepository {
  constructor(private readonly root: EntityManager) {}

  /** EntityManager novo por consulta: nada de identity map entre requisições. */
  private get em() {
    return this.root.fork();
  }

  async findWallet(id: string): Promise<Wallet | undefined> {
    if (!isUuid(id)) return undefined;
    const record = await this.em.findOne(WalletRecord, { id });
    return record ? WalletMapper.toDomain(record) : undefined;
  }

  async listLedger(walletId: string, afterSeq: string | undefined, limit: number): Promise<LedgerPage> {
    // Paginação por "keyset": WHERE seq > cursor ORDER BY seq LIMIT n.
    // Estável mesmo com inserções novas (diferente de OFFSET, que "pula" linhas)
    // e usa o índice (wallet_id, seq). Pede limit + 1 para saber se há próxima página.
    const records = await this.em.find(
      LedgerEntryRecord,
      { walletId, ...(afterSeq !== undefined ? { seq: { $gt: afterSeq } } : {}) },
      { orderBy: { seq: 'asc' }, limit: limit + 1 },
    );
    const page = records.slice(0, limit);
    const hasMore = records.length > limit;
    return {
      entries: page.map(LedgerEntryMapper.toDomain),
      nextSeq: hasMore ? page.at(-1)?.seq : undefined,
    };
  }

  async findTransaction(id: string): Promise<WagerTransaction | undefined> {
    if (!isUuid(id)) return undefined;
    const record = await this.em.findOne(WagerTransactionRecord, { id });
    return record ? WagerTransactionMapper.toDomain(record) : undefined;
  }

  async findTransactionByExternalId(providerId: string, externalTransactionId: string) {
    const record = await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId });
    return record ? WagerTransactionMapper.toDomain(record) : undefined;
  }

  async reconcile(walletId: string): Promise<ReconciliationSnapshot | undefined> {
    if (!isUuid(walletId)) return undefined;
    // UM único SELECT: o PostgreSQL garante que um comando enxerga um snapshot
    // consistente, então saldo e soma do ledger são do mesmo instante — sem
    // lock e sem bloquear quem está apostando.
    // Créditos e débitos vêm separados (ambos ≥ 0) para o cálculo ficar no Money,
    // inclusive se o resultado for negativo (o que indicaria corrupção).
    const rows = await this.em.execute<
      { balance: string; currency: string; credits: string; debits: string; entries: number }[]
    >(
      `select w.balance::text as balance,
              w.currency,
              coalesce(sum(l.amount) filter (where l.direction = 'CREDIT'), 0)::numeric(20,2)::text as credits,
              coalesce(sum(l.amount) filter (where l.direction = 'DEBIT'), 0)::numeric(20,2)::text as debits,
              count(l.id)::int as entries
         from wallets w
         left join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = ?
        group by w.id`,
      [walletId],
    );
    const row = rows[0];
    if (!row) return undefined;

    const money = (amount: string) => Money.from({ amount, currency: row.currency });
    return {
      storedBalance: money(row.balance),
      calculatedBalance: money(row.credits).subtract(money(row.debits)),
      checkedEntries: row.entries,
    };
  }
}
