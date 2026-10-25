import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { WalletNotFoundError } from '../../application/errors';
import type { WalletReadRepository } from '../../application/ports';
import { OpenWalletUseCase, toWalletView } from '../../application/wallets/open-wallet.use-case';
import { ReconcileWalletUseCase } from '../../application/wallets/reconcile-wallet.use-case';
import { ProviderAuthGuard } from './auth.guard';
import { decodeCursor, encodeCursor } from './cursor';
import { presentLedgerEntry } from './presenters';
import { WALLET_READS } from './tokens';
import { parseLimit, requireMoney, requireObject, requireString } from '../validation';

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWalletUseCase,
    private readonly reconcileWallet: ReconcileWalletUseCase,
    @Inject(WALLET_READS) private readonly reads: WalletReadRepository,
  ) {}

  /** 201 criada · 400 payload inválido · 409 já existe wallet para player + moeda */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() raw: unknown) {
    const body = requireObject(raw);
    return this.openWallet.execute({
      playerId: requireString(body, 'playerId'),
      initialBalance: requireMoney(body, 'initialBalance'),
    });
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    const wallet = await this.reads.findWallet(walletId);
    if (!wallet) throw new WalletNotFoundError(walletId);
    return toWalletView(wallet);
  }

  /** Paginação por cursor opaco: devolva `nextCursor` em `?cursor=` para a próxima página. */
  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const afterSeq = decodeCursor(cursor);
    const pageSize = parseLimit(limit);
    if (!(await this.reads.findWallet(walletId))) throw new WalletNotFoundError(walletId);

    const page = await this.reads.listLedger(walletId, afterSeq, pageSize);
    return {
      walletId,
      entries: page.entries.map(presentLedgerEntry),
      nextCursor: page.nextSeq ? encodeCursor(page.nextSeq) : null,
    };
  }

  /** POST porque é uma AÇÃO (executa a verificação e pode disparar alerta), não leitura pura. */
  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcile(@Param('walletId') walletId: string) {
    return this.reconcileWallet.execute(walletId);
  }
}
