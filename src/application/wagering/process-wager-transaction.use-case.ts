import type { FailureCode } from '../../domain/shared/failure-code';
import { Money, type MoneyProps } from '../../domain/shared/money';
import { applyWagerTransaction } from '../../domain/wager/apply-wager-transaction';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../domain/wager/wager-transaction';
import type { InboxMessage } from '../../domain/messaging/inbox-message';
import { InvariantViolationError } from '../../domain/shared/domain-error';
import {
  DuplicateTransactionError,
  IdempotencyConflictError,
  MessageIdConflictError,
  WalletNotFoundError,
} from '../errors';
import type { Clock, IdGenerator, TransactionContext, UnitOfWork } from '../ports';
import { computePayloadHash } from './payload-hash';

/** Entrada comum a HTTP e SQS: os dois chamam ESTE use case. */
export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

export interface WagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Saldo observado quando a transação foi finalizada (ausente enquanto pendente). */
  balance: MoneyProps | undefined;
  failureCode: FailureCode | undefined;
  idempotentReplay: boolean;
}

export function toWagerResult(tx: WagerTransaction, idempotentReplay: boolean): WagerTransactionResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: tx.resultingBalance?.toJSON(),
    failureCode: tx.failureCode,
    idempotentReplay,
  };
}

/**
 * Processa uma operação do provedor exatamente uma vez.
 *
 * Tudo acontece numa única transação SQL:
 *   1. SELECT wallet FOR UPDATE   → serializa operações da MESMA wallet
 *   2. idempotência (depois do lock, para enxergar a gêmea que acabou de commitar)
 *   3. resolve referência + "já foi revertida?"
 *   4. regras de domínio (applyWagerTransaction)
 *   5. INSERT transação, UPDATE wallet, INSERT ledger
 * Wallets diferentes não se bloqueiam: o lock é por linha, nunca global.
 */
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  /**
   * @param options.inbox  presente quando a entrada é a fila: o registro de inbox
   *                       entra na MESMA transação SQL do efeito financeiro.
   */
  async execute(
    command: SubmitWagerTransactionCommand,
    options: { inbox?: InboxMessage } = {},
  ): Promise<WagerTransactionResult> {
    // Validação do payload ANTES de tocar no banco: erro aqui é 400, sem efeito.
    const money = Money.from(command.money);
    const payloadHash = computePayloadHash({ ...command, money });
    const transaction = WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind as WagerTransactionKind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: this.clock.now(),
    });

    const { inbox } = options;
    inbox?.markProcessed(this.clock.now());

    try {
      return await this.uow.run((ctx) => this.process(ctx, transaction, inbox));
    } catch (error) {
      // Corrida perdida: uma gêmea com a mesma key/id externo commitou primeiro
      // (ex.: mesma key apontando para OUTRA wallet, logo sem lock em comum).
      // A transação atual já sofreu rollback; relemos a vencedora numa nova.
      if (error instanceof DuplicateTransactionError) {
        return this.uow.run(async (ctx) => {
          if (inbox) await this.registerInbox(ctx, inbox);
          const winner = await this.findTwin(ctx, transaction);
          if (!winner) throw error; // não deveria acontecer: a UNIQUE só falha se a linha existe
          return this.replay(winner, transaction);
        });
      }
      throw error;
    }
  }

  private async process(
    ctx: TransactionContext,
    tx: WagerTransaction,
    inbox: InboxMessage | undefined,
  ): Promise<WagerTransactionResult> {
    // 0) Inbox (só entrada SQS). Mensagem já tratada → o efeito já foi
    //    commitado junto com ela: devolve o resultado original, sem lock.
    if (inbox && (await this.registerInbox(ctx, inbox)) === 'duplicate') {
      const original = await this.findTwin(ctx, tx);
      if (!original) throw new InvariantViolationError(`Inbox has ${inbox.messageId} but no transaction`);
      return this.replay(original, tx);
    }

    // 1) Lock pessimista da wallet. Concorrentes da mesma wallet esperam aqui.
    const wallet = await ctx.wallets.findByIdForUpdate(tx.walletId);
    if (!wallet) throw new WalletNotFoundError(tx.walletId);

    // 2) Idempotência. Feita DEPOIS do lock: se uma requisição idêntica estava
    //    na frente, ela já commitou e este SELECT a enxerga (READ COMMITTED).
    const twin = await this.findTwin(ctx, tx);
    if (twin) return this.replay(twin, tx);

    // 3) Referência (por id do PROVEDOR) e se ela já foi revertida.
    const reference = tx.referenceExternalTransactionId
      ? await ctx.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId)
      : undefined;
    const referenceAlreadyReversed =
      reference !== undefined && tx.isReversal()
        ? await ctx.transactions.hasProcessedReversal(reference.id)
        : false;

    // 4) Regras de negócio (puras, em memória).
    const previousVersion = wallet.version;
    const entry = applyWagerTransaction({
      transaction: tx,
      wallet,
      reference,
      referenceAlreadyReversed,
      entryId: this.ids.next(),
      at: this.clock.now(),
    });

    // 5) Persistência — na ordem exigida pelas FKs.
    await ctx.transactions.insert(tx);
    if (entry) {
      await ctx.wallets.update(wallet, previousVersion);
      await ctx.ledger.append(entry);
    }
    return toWagerResult(tx, false);
  }

  private async registerInbox(ctx: TransactionContext, inbox: InboxMessage): Promise<'registered' | 'duplicate'> {
    const registration = await ctx.inbox.register(inbox);
    if (registration.status === 'registered') return 'registered';
    if (!registration.existing.matchesPayload(inbox.payloadHash)) {
      throw new MessageIdConflictError(inbox.messageId);
    }
    return 'duplicate';
  }

  /** Mesma idempotency key, ou mesmo id externo do provedor. */
  private async findTwin(ctx: TransactionContext, tx: WagerTransaction) {
    return (
      (await ctx.transactions.findByIdempotencyKey(tx.idempotencyKey)) ??
      (await ctx.transactions.findByExternalId(tx.providerId, tx.externalTransactionId))
    );
  }

  /** Payload igual → devolve o resultado ORIGINAL. Diferente → conflito, nunca replay. */
  private replay(existing: WagerTransaction, incoming: WagerTransaction): WagerTransactionResult {
    if (!existing.matchesPayload(incoming.payloadHash)) {
      throw new IdempotencyConflictError(incoming.idempotencyKey);
    }
    return toWagerResult(existing, true);
  }
}
