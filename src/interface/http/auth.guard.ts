import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';

/**
 * PONTO DE EXTENSÃO de autenticação — hoje deixa tudo passar (decisão de
 * escopo: autenticação não pontua no desafio; ver DESIGN.md §13).
 *
 * Desenho previsto: cada provedor é um client OIDC num IdP externo (Keycloak)
 * e obtém token via client_credentials. Este guard validaria o JWT (assinatura
 * pelo JWKS do IdP, `iss`, `aud`, `exp`) e conferiria que o `providerId` do
 * corpo é o mesmo do token — um provedor não pode operar em nome de outro.
 * Health checks ficam fora (o guard não é aplicado no HealthController).
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
