import { Money, type MoneyProps } from '../../domain/shared/money';
import { WagerTransaction } from '../../domain/wager/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import type { Clock, IdGenerator, UnitOfWork } from '../ports';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

/**
 * Cria a wallet. Saldo inicial > 0 gera, NA MESMA transação SQL, a transação
 * interna OPENING e o lançamento CREDIT correspondente.
 * Wallet duplicada (player + moeda) → WalletAlreadyExistsError (via UNIQUE do banco).
 */
export class OpenWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(command: OpenWalletCommand): Promise<WalletView> {
    const initialBalance = Money.from(command.initialBalance);
    const at = this.clock.now();
    const walletId = this.ids.next();
    const openingTransactionId = this.ids.next();

    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: command.playerId,
      initialBalance,
      at,
      opening: { transactionId: openingTransactionId, entryId: this.ids.next() },
    });

    await this.uow.run(async (ctx) => {
      await ctx.wallets.insert(wallet);
      if (openingEntry) {
        const opening = WagerTransaction.opening({
          id: openingTransactionId,
          walletId,
          playerId: wallet.playerId,
          money: initialBalance,
          at,
        });
        // Ordem importa por causa das FKs: wallet → transação → lançamento.
        await ctx.transactions.insert(opening);
        await ctx.ledger.append(openingEntry);
      }
    });

    return toWalletView(wallet);
  }
}
