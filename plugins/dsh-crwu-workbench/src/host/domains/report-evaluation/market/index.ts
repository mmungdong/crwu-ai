/** 外部案例的字段标准化（挂牌 / 成交纪律在这里）。 */
export {
  caseCounts,
  caseIsComparable,
  normalizeCase,
  normalizeFieldName,
  knownFieldAliases,
  parseArea,
  parsePrice,
  pickField,
  transactionTypeOf,
  unitPriceOf,
} from './normalize.ts'
export type { NormalizeOptions, TransactionType, ValuationCase } from './normalize.ts'
export { dedupeListings, listingFieldsOf, listingsFromJsonLd } from './jsonld.ts'
