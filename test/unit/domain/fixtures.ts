import { Money } from '../../../src/domain/shared/money';
import { Wallet } from '../../../src/domain/wallet/wallet';
import {
  WagerTransaction,
  WagerTransactionKind,
  type CreateWagerTransactionProps,
} from '../../../src/domain/wager/wager-transaction';

export const T0 = new Date('2026-01-01T00:00:00.000Z');
export const PLAYER = 'player-1';
export const PROVIDER = 'provider-a';
export const ROUND = 'round-1';

export const id = () => crypto.randomUUID();
export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

export function openWallet(initial: string, walletId = 'wallet-1'): Wallet {
  return Wallet.open({
    id: walletId,
    playerId: PLAYER,
    initialBalance: brl(initial),
    at: T0,
    opening: { transactionId: id(), entryId: id() },
  }).wallet;
}

let seq = 0;

/** Cria uma WagerTransaction válida; sobrescreva só o que importa no teste. */
export function wager(
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  seq += 1;
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${seq}`;
  return WagerTransaction.create({
    id: id(),
    providerId: PROVIDER,
    externalTransactionId,
    idempotencyKey: `${PROVIDER}:${externalTransactionId}`,
    payloadHash: `hash-${externalTransactionId}`,
    walletId: 'wallet-1',
    playerId: PLAYER,
    roundId: ROUND,
    gameId: 'fortune-chimp',
    kind,
    money: brl(amount),
    createdAt: T0,
    ...overrides,
  });
}
