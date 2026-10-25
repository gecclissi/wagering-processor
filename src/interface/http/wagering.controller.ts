import { Body, Controller, Get, Headers, Inject, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { TransactionNotFoundError } from '../../application/errors';
import type { WalletReadRepository } from '../../application/ports';
import { ProcessWagerTransactionUseCase } from '../../application/wagering/process-wager-transaction.use-case';
import { DomainError } from '../../domain/shared/domain-error';
import { FailureCode } from '../../domain/shared/failure-code';
import { ProviderAuthGuard } from './auth.guard';
import { statusForTransaction } from './error-mapping';
import { presentTransaction, presentWagerResult } from './presenters';
import { WALLET_READS } from './tokens';
import { optionalString, requireMoney, requireObject, requireString } from './validation';

class MissingIdempotencyKeyError extends DomainError {
  readonly code = FailureCode.MissingIdempotencyKey;

  constructor() {
    super('Idempotency-Key header is required');
  }
}

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerTransactionUseCase,
    @Inject(WALLET_READS) private readonly reads: WalletReadRepository,
  ) {}

  /**
   * 200 PROCESSED · 202 PENDING_REFERENCE · 422 REJECTED (corpo traz failureCode)
   * 400 payload inválido / sem Idempotency-Key · 404 wallet · 409 key com outro payload
   * 503 transitório (reenvie com a mesma key)
   */
  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    // O header é a fonte da verdade da idempotência — obrigatório.
    if (!idempotencyKey?.trim()) throw new MissingIdempotencyKeyError();

    const body = requireObject(raw);
    const result = await this.processWager.execute({
      idempotencyKey: idempotencyKey.trim(),
      providerId: requireString(body, 'providerId'),
      externalTransactionId: requireString(body, 'externalTransactionId'),
      playerId: requireString(body, 'playerId'),
      walletId: requireString(body, 'walletId'),
      roundId: requireString(body, 'roundId'),
      gameId: requireString(body, 'gameId'),
      kind: requireString(body, 'kind'),
      money: requireMoney(body, 'money'),
      referenceExternalTransactionId: optionalString(body, 'referenceExternalTransactionId'),
    });

    res.status(statusForTransaction(result.status));
    return presentWagerResult(result);
  }

  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId') transactionId: string) {
    const tx = await this.reads.findTransaction(transactionId);
    if (!tx) throw new TransactionNotFoundError(transactionId);
    return presentTransaction(tx);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const tx = await this.reads.findTransactionByExternalId(providerId, externalTransactionId);
    if (!tx) throw new TransactionNotFoundError(`${providerId}/${externalTransactionId}`);
    return presentTransaction(tx);
  }
}
