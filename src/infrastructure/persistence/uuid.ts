const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * As colunas de id são `uuid` no PostgreSQL: consultar com "abc" seria erro de
 * sintaxe (500). Um id malformado simplesmente não existe → "não encontrado".
 */
export const isUuid = (value: string) => UUID_PATTERN.test(value);
