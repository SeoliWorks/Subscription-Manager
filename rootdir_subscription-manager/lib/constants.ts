export const SUBSCRIPTION_CYCLES = {
  monthly: 'monthly',
  yearly: 'yearly',
} as const;

export const CYCLE_LABELS = {
  [SUBSCRIPTION_CYCLES.monthly]: '月額',
  [SUBSCRIPTION_CYCLES.yearly]: '年額',
};

// 通貨設定
// decimals: DB保存時の倍率 (例: 2なら x100)
export const CURRENCIES = {
  JPY: { code: 'JPY', symbol: '¥', decimals: 0 },
  USD: { code: 'USD', symbol: '$', decimals: 2 },
  EUR: { code: 'EUR', symbol: '€', decimals: 2 },
} as const;

export type CurrencyCode = keyof typeof CURRENCIES;
