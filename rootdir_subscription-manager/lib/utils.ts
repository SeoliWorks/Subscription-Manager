import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import { type Subscription } from "@/db/schema"
import { SUBSCRIPTION_CYCLES, CURRENCIES, type CurrencyCode } from "./constants"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * クライアントのローカル日付を "YYYY-MM-DD" 形式で取得する
 * ブラウザのロケール実装に依存せず、確実にフォーマットする
 */
export function getLocalTodayString(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * DB保存値(整数)を、UI表示用の数値(小数)に戻す
 * 表示用のため割り算を行う
 */
export function convertAmountFromMinorUnits(amount: number, currency: string): number {
  const config = CURRENCIES[currency as CurrencyCode] ?? CURRENCIES.JPY;
  return amount / Math.pow(10, config.decimals);
}

/**
 * UI入力値(小数含む数値)を、DB保存用の整数(最小単位)に変換
 * IEEE 754 浮動小数点誤差を防ぐため、文字列操作で小数点を移動させる
 * 例: 10.99 (USD) -> "10.99" -> "1099"
 */
export function convertAmountToMinorUnits(amount: number, currency: string): number {
  const config = CURRENCIES[currency as CurrencyCode] ?? CURRENCIES.JPY;
  
  // 小数点以下の桁数を固定した文字列を作成 (四捨五入の効果もある)
  const fixedString = amount.toFixed(config.decimals);
  
  // 小数点を取り除いて整数化
  const integerString = fixedString.replace('.', '');
  
  return parseInt(integerString, 10);
}

/**
 * [DB用] DBの整数値を受け取り、自動的に小数に戻してフォーマットする
 */
export function formatCurrency(amountFromDb: number, currency: string): string {
  const actualAmount = convertAmountFromMinorUnits(amountFromDb, currency);
  return formatDisplayPrice(actualAmount, currency);
}

/**
 * [表示用] すでに計算済みの数値を受け取り、通貨フォーマットする
 */
export function formatDisplayPrice(amount: number, currency: string): string {
  return new Intl.NumberFormat('ja-JP', {
    style: 'currency',
    currency: currency,
  }).format(amount);
}

export type AggregatedTotals = {
  [key in CurrencyCode]: number;
};

/**
 * 全通貨の月額換算合計を計算して返す
 * 戻り値例: { JPY: 5000, USD: 10.50, EUR: 0 }
 */
export function calculateMonthlyAggregations(subscriptions: Subscription[]): AggregatedTotals {
  const totals: AggregatedTotals = {
    JPY: 0,
    USD: 0,
    EUR: 0,
  };

  subscriptions.forEach((sub) => {
    const currency = sub.currency as CurrencyCode;
    if (!totals.hasOwnProperty(currency)) return;

    const actualPrice = convertAmountFromMinorUnits(sub.price, currency);
    
    let monthlyPrice = actualPrice;
    if (sub.cycle === SUBSCRIPTION_CYCLES.yearly) {
      // 年額の12分割時に発生する無限小数を、項目ごとに小数第2位で丸めて確定させる
      monthlyPrice = Math.round((actualPrice / 12) * 100) / 100;
    }

    totals[currency] += monthlyPrice;
  });

  return totals;
}
